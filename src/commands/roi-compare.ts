/**
 * `maafw-live roi-compare` —— 外来目标 + 一组位置假设 → 排序表 / bestGap / 并列带 / 三态结论。
 *
 * 与 `roi-check` 的关系：`roi-check` 的候选写死成"沿 x 偏移 ±pitch/2"（案例专用，且要求你先知道
 * 周期），`roi-compare` 把判据泛化成**候选集合比较**——候选从哪来由参数决定（显式全套 / 相对平移 /
 * 发现模式），判据只有一份（`src/runtime/roi-compare.ts`）。
 *
 * 判据三条（灵魂，别改）：
 *  1. **外来目标**：用资源目录里的模板（`--target`）；
 *  2. **允许说"分不出来"**：最优与次优差 < `--gap`（缺省 0.15）且并列 ≥ 2 → AMBIGUOUS + 退出 3；
 *  3. **不说无证据的结论**：无得分的候选既不当 0 分，也不许被当成"垫底"来宣布胜出。
 *
 * 成本（**别以为是秒回**）：候选在 daemon 侧**逐例串行**跑，实测 ≈ 0.24s/例 + 一次子进程启动
 * （本项目实测 15 例约 12s）；候选数线性涨（41 个候选按实测 ≈ 20s，换更重的模板/画面会到分钟级）。
 * 一次命令只 spawn 一次识别子进程（候选折进同一个 `cases`），不是每个候选 spawn 一次。
 */
import { existsSync } from 'node:fs'
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { recoTest, withDaemon } from '../runtime/actions.js'
import {
  aggregate, DEFAULT_GAP, fromOffsets, fromRois, fromScan, parseScan, sampleOf, scanInfo,
  type CandidateSet, type CompareItem, type FrameSize, type Offset, type Roi, type ScanAxis, type ScanSpec,
} from '../runtime/roi-compare.js'
import { daemonFail } from './runtime.js'

interface OffsetEntry {
  dx: number
  dy: number
  abs?: Roi
}

function parseRois(raw: string): { value?: Roi[]; error?: string } {
  const value: Roi[] = []
  for (const part of raw.split(';')) {
    const seg = part.trim()
    if (!seg) continue
    const nums = seg.split(',').map((x) => Number(x.trim()))
    if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
      return { error: '--rois 每段要 4 个数字 x,y,w,h（段之间用 ; 隔开），不认识：' + seg }
    }
    value.push(nums)
  }
  if (!value.length) return { error: '--rois 是空的：至少给一个 x,y,w,h' }
  return { value }
}

function parseOffsets(raw: string): { value?: OffsetEntry[]; error?: string } {
  const value: OffsetEntry[] = []
  for (const part of raw.split(';')) {
    const seg = part.trim()
    if (!seg) continue
    const nums = seg.split(',').map((x) => Number(x.trim()))
    if (nums.some((n) => !Number.isFinite(n)) || (nums.length !== 2 && nums.length !== 4)) {
      return {
        error: '--offsets 每段要 2 个数字 dx,dy（相对 --roi 的平移）或 4 个数字 x,y,w,h（当基准用），不认识：' + seg,
      }
    }
    value.push(nums.length === 2 ? { dx: nums[0]!, dy: nums[1]! } : { dx: 0, dy: 0, abs: nums })
  }
  if (!value.length) return { error: '--offsets 是空的：至少给一个 dx,dy' }
  return { value }
}

const fmt = (n: number | null): string => (n === null ? '（无得分）' : String(Math.round(n * 1000) / 1000))

/** 一个轴的人读写法：单点写 `axis=<n>`，区间写 `axis=<from>..<to>/<step>`。 */
const axisText = (name: string, a: ScanAxis | null): string =>
  a === null ? name + '=0'
    : a.from === a.to ? name + '=' + a.from
      : name + '=' + a.from + '..' + a.to + '/' + a.step

/** 单轴有范围时给出步长（两轴都有范围时"那个"步长无从谈起，如实给 null）。 */
function scanStep(spec: ScanSpec): number | null {
  const ranged = [spec.dx, spec.dy].filter((a): a is ScanAxis => a !== undefined && a.from !== a.to)
  return ranged.length === 1 ? ranged[0]!.step : null
}

export const roiCompareCommand: Command = {
  name: 'roi-compare',
  summary: '候选集合比较：外来模板在同图的一批位置假设上的排序表 + bestGap + 并列带 + 三态结论',
  usage: 'maafw-live roi-compare --image <png> --target <资源目录内的模板> --resource-dir <dir>\n' +
    '                       ( --rois "x,y,w,h;x,y,w,h;…"         # 显式全套（位置已经知道时用这条）\n' +
    '                       | --offsets "0,0;135,0;140,0;0,111"  # 相对 --roi 的平移，x/y 分量与非均匀列表都允许\n' +
    '                       | --scan "dx=-160..160/8,dy=0" )     # 你也不知道周期时的发现模式\n' +
    '                       [--roi x,y,w,h]   [--threshold <t>]   [--gap <0.15>]   [--name TemplateMatch]\n' +
    '       判据是**候选集合比较**：按分数排序，报第 1/2 名的真实分差（bestGap）与并列带（withinGap）\n' +
    '       三态：唯一最优且过门槛 → 命中(0) / 歧义·未命中·有候选无法评估 → 检出问题(3) / 参数错 → 2\n' +
    '       候选越界（含左上负坐标）：跳过并报出是谁；全部越界 → 检出问题(3)\n' +
    '       --name 只接受 TemplateMatch：别的识别类型不读 template，会把 --target 静默吞掉\n' +
    '       --scan 是**发现模式**，不是判据：结论只说"发现/未发现唯一最优"，不据此判位置对错\n' +
    '       --roi 是 --offsets/--scan 的基准（--offsets 缺省用第一个候选：把它写成 x,y,w,h）\n' +
    '       成本：候选逐例**串行**，实测 ≈ 0.24s/例 + 一次子进程启动；候选越多越慢，不是秒回',
  options: {
    image: { type: 'string' },
    target: { type: 'string' },
    'resource-dir': { type: 'string' },
    rois: { type: 'string' },
    offsets: { type: 'string' },
    scan: { type: 'string' },
    roi: { type: 'string' },
    threshold: { type: 'string' },
    gap: { type: 'string' },
    name: { type: 'string' },
  },

  async run(ctx): Promise<CommandResult> {
    const image = typeof ctx.values.image === 'string' ? ctx.values.image : undefined
    const target = typeof ctx.values.target === 'string' ? ctx.values.target : undefined
    const resourceDir = typeof ctx.values['resource-dir'] === 'string' ? ctx.values['resource-dir'] : undefined
    if (!image || !target) {
      return fail('BAD_ARGUMENTS', '缺 --image <png> 或 --target <模板>',
        '外来目标是本命令的灵魂：用"假说自己"当模板，候选之间各自 1.000，什么都证明不了', EXIT.USAGE)
    }
    if (image.startsWith('kf:')) {
      return fail('BAD_ARGUMENTS', '--image 要文件路径；kf: 开头的库帧 ID 请走 reco --from-kf（本命令暂不支持库帧）',
        undefined, EXIT.USAGE)
    }
    if (!existsSync(image)) {
      return fail('BAD_ARGUMENTS', '图像不存在：' + image, undefined, EXIT.USAGE)
    }
    if (!resourceDir) {
      return fail('BAD_ARGUMENTS', '缺 --resource-dir：模板与 OCR 模型都要靠它加载，不给只会得到零例数（看不出病因）',
        '模板路径按资源目录的相对路径给，如 CritterCrash/P40/Leaders_30027.png', EXIT.USAGE)
    }

    let base: Roi | undefined
    const roiRaw = typeof ctx.values.roi === 'string' ? ctx.values.roi : undefined
    if (roiRaw !== undefined) {
      const nums = roiRaw.split(',').map((x) => Number(x.trim()))
      if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
        return fail('BAD_ARGUMENTS', '--roi 需要 4 个数字：x,y,w,h（按 --image 的像素坐标给）', undefined, EXIT.USAGE)
      }
      base = nums
    }

    /* 候选来源三选一：多给不是"叠加"，是语义打架——明确报错，不猜哪个优先。 */
    const sources = (['rois', 'offsets', 'scan'] as const)
      .filter((k) => typeof ctx.values[k] === 'string' && ctx.values[k] !== '')
    if (sources.length !== 1) {
      return fail('BAD_ARGUMENTS',
        sources.length === 0
          ? '缺候选来源：给 --rois / --offsets / --scan 之一'
          : '候选来源只能给一个，收到：' + sources.map((s) => '--' + s).join(' + '),
        '--rois 是显式全套；--offsets 是相对基准的平移；--scan 是你也说不上周期时的发现模式', EXIT.USAGE)
    }
    const source = sources[0]!

    const thrRaw = typeof ctx.values.threshold === 'string' ? ctx.values.threshold : undefined
    const threshold = thrRaw !== undefined ? Number(thrRaw) : undefined
    if (thrRaw !== undefined && (!Number.isFinite(threshold) || threshold! < 0 || threshold! > 1)) {
      return fail('BAD_ARGUMENTS', '--threshold 要在 [0,1]（TemplateMatch 的置信度门槛；缺省不做门槛断言）',
        undefined, EXIT.USAGE)
    }
    const gapRaw = typeof ctx.values.gap === 'string' ? ctx.values.gap : undefined
    const gap = gapRaw !== undefined ? Number(gapRaw) : DEFAULT_GAP
    if (!Number.isFinite(gap) || gap < 0 || gap > 1) {
      return fail('BAD_ARGUMENTS', '--gap 要在 [0,1]（并列带宽度：最优与次优分差小于它就不下结论）', undefined, EXIT.USAGE)
    }
    /* 只认 TemplateMatch：`--target` 是必给的**模板**，而 OCR / ColorMatch 这些类型根本不读
     * `template`——放行它们就是"参数被静默忽略、分数换成另一套含义，而回执照旧打「外来目标」"，
     * 正是本命令要治的那种静默错。 */
    const nameRaw = typeof ctx.values.name === 'string' ? ctx.values.name.trim() : ''
    if (nameRaw && nameRaw !== 'TemplateMatch') {
      return fail('BAD_ARGUMENTS', '--name 只接受 TemplateMatch，收到：' + nameRaw,
        '别的识别类型（OCR / ColorMatch …）不读 template：--target 会被静默忽略、score 也换成另一套含义',
        EXIT.USAGE)
    }
    const type = 'TemplateMatch'

    /* 候选生成器只写一遍：`build()` 不判越界（还不知道图像尺寸）→ 决定发哪些候选；
     * `build({w,h})` 用回执里的 meta 尺寸跑同一个函数 → 决定报哪些候选被跳过。
     * 越界判据（roiOutOfBounds）因此仍然只有一份，不在这里重写。 */
    let scan: ScanSpec | undefined
    let build: (size?: FrameSize) => CandidateSet
    if (source === 'rois') {
      const parsed = parseRois(ctx.values.rois as string)
      if (parsed.error) return fail('BAD_ARGUMENTS', parsed.error, undefined, EXIT.USAGE)
      const rois = parsed.value!
      build = (size) => fromRois(rois, size)
    } else if (source === 'offsets') {
      const parsed = parseOffsets(ctx.values.offsets as string)
      if (parsed.error) return fail('BAD_ARGUMENTS', parsed.error, undefined, EXIT.USAGE)
      const entries = parsed.value!
      let anchor: Roi | undefined
      let offsets: Offset[]
      if (base) {
        if (entries.some((e) => e.abs)) {
          return fail('BAD_ARGUMENTS', '--offsets 里出现 4 个数字的绝对 roi，同时又给了 --roi 基准：只能二选一',
            '要么全部写 dx,dy 并用 --roi 给基准，要么不给 --roi、让第一段写成 x,y,w,h 当基准', EXIT.USAGE)
        }
        anchor = base
        offsets = entries.map((e) => ({ dx: e.dx, dy: e.dy }))
      } else {
        const first = entries[0]!
        if (!first.abs) {
          return fail('BAD_ARGUMENTS', '缺 --roi（--offsets 的基准）：第一段只有 2 个分量，没法当绝对位置',
            '给 --roi x,y,w,h，或把第一段写成 x,y,w,h 当基准', EXIT.USAGE)
        }
        anchor = first.abs
        offsets = [{ dx: 0, dy: 0 }, ...entries.slice(1).map((e) => ({ dx: e.dx, dy: e.dy }))]
      }
      base = anchor
      build = (size) => fromOffsets(offsets, anchor!, size)
    } else {
      const parsed = parseScan(ctx.values.scan as string)
      if (parsed.error) return fail('BAD_ARGUMENTS', parsed.error, undefined, EXIT.USAGE)
      scan = parsed.value
      if (!base) {
        return fail('BAD_ARGUMENTS', '--scan 缺 --roi：扫描是相对一个基准位置的平移，基准必须显式给',
          '形如 --roi 462,175,68,44 --scan "dx=-160..160/8,dy=0"', EXIT.USAGE)
      }
      const anchor = base
      build = (size) => fromScan(scan!, anchor, size)
    }

    const sent = build().candidates
    if (!sent.length) {
      return fail('BAD_ARGUMENTS', '没有可用的候选：候选来源给出的都不是 4 个有限数字', undefined, EXIT.USAGE)
    }

    try {
      return await withDaemon(async (c) => {
        const t0 = Date.now()
        /* 客户端预算必须比 daemon 侧那笔更宽（daemon：max(90s, 5s×例)，spawnRecoChild 再封顶 120s）
         * ——反过来的话，还在正常跑的子进程会先被客户端判成超时，看起来像"识别失败"。 */
        const r = await recoTest(c, {
          resourceDir, type, image,
          param: { template: target },
          candidates: sent.map((x) => x.roi),
        }, Math.max(90000, sent.length * 5000) + 20000)
        const elapsedMs = Date.now() - t0
        const results = (r.results as Array<{ ok?: unknown; detail?: unknown }> | undefined) ?? []
        const meta = r.meta as { w?: unknown; h?: unknown } | undefined
        if (r.ok === false && !results.length) {
          return fail('ROI_COMPARE', String(r.error ?? '识别失败'), undefined, EXIT.FINDINGS)
        }
        /* 逐例回执与发出的候选**逐个对齐**（顺序不变量）：数量不符就是契约破了，不按"分数看起来对"猜。 */
        if (results.length !== sent.length) {
          return fail('ROI_COMPARE',
            '识别回执例数 ' + results.length + ' ≠ 发出的候选数 ' + sent.length + '：逐例对应关系断了，不猜',
            'daemon 的 candidates 折叠应逐例透传（同一次 spawnRecoChild）', EXIT.FINDINGS)
        }
        const w = Number(meta?.w)
        const h = Number(meta?.h)
        const known = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0

        /* 逐例对应关系是**结构性不变量**（results[i] ↔ 发出的第 i 条），而 results[i].param.roi
         * 必须就是我发出去的那条 roi。不是就明确报"断了"——`sweep` 是"同键换值"、候选是"逐例换 roi"，
         * 形状像但不变量不同；分数悄悄错位是这条判据最贵的失败方式。 */
        const sampleByOrigin = new Map<number, ReturnType<typeof sampleOf>>()
        const caseRoiByOrigin = new Map<number, Roi>()
        for (let i = 0; i < sent.length; i++) {
          const sentRoi = sent[i]!.roi
          const echoed = (results[i] as { param?: { roi?: unknown } } | undefined)?.param?.roi
          const got = Array.isArray(echoed) ? echoed.map(Number) : null
          if (!got || got.length !== 4 || !got.every(Number.isFinite) || got.join(',') !== sentRoi.join(',')) {
            return fail('ROI_COMPARE',
              '第 ' + (i + 1) + ' 例回执的 param.roi=' + JSON.stringify(echoed ?? null)
                + ' 与发出的候选 ' + sentRoi.join(',') + ' 不一致：逐例对应关系断了，不猜',
              '候选集合的比较依赖"逐例换 roi"这条不变量（reco_test 的 candidates 逐例透传）', EXIT.FINDINGS)
          }
          sampleByOrigin.set(sent[i]!.origin, sampleOf(results[i]))
          caseRoiByOrigin.set(sent[i]!.origin, got)
        }

        const set = build(known ? { w, h } : undefined)
        const skipped = set.skipped
        const sizeText = known ? w + 'x' + h : '尺寸未知'
        const human: string[] = [
          'roi-compare（外来目标）：' + target + '  on ' + image + '   图像 ' + sizeText,
        ]

        const skipText = skipped.map((s) => s.roi.join(',')).join(' / ')
        if (skipped.length) {
          human.push(' 候选越界：跳过 ' + skipped.length + ' 个（' + skipText + '）——越界是**参数用错空间**，'
            + '不是识别未命中（roi 按 ' + sizeText + ' 的像素空间给）')
        }
        if (!set.candidates.length) {
          return {
            exitCode: EXIT.FINDINGS,
            human: [...human, ' 候选全部越界（' + skipped.length + ' 个）：' + skipText],
            error: {
              code: 'ROI_OUT_OF_BOUNDS',
              message: skipped[0]!.reason,
              hint: 'roi 要按 --image 的像素坐标给（控制器的 roi 差一个 scale）',
            },
          }
        }

        /* 逐例得分按 origin 归位：发出的第 i 例 ↔ results[i]（上面已验数量与 roi）。 */
        const items: CompareItem[] = set.candidates.map((x) => ({
          roi: x.roi, origin: x.origin, ...sampleByOrigin.get(x.origin)!,
        }))
        const outcome = aggregate(items, { gap, threshold })
        const missing = items.filter((x) => x.score === null)
        /* `ranked` 里**只有拿得到分数的候选**：没有分数就没有名次（它们仍在回执的逐例记录里点名）。 */
        const top = outcome.ranked[0] ?? null
        const best = top?.score ?? null

        if (outcome.ranked.length) {
          const roiW = Math.max(15, ...outcome.ranked.map((x) => x.roi.join(',').length))
          human.push(' rank  ' + 'roi'.padEnd(roiW) + '  score   命中')
          for (const row of outcome.ranked) {
            const delta = best !== null && row.score !== null ? Math.round((best - row.score) * 1000) / 1000 : null
            human.push(' ' + String(row.rank).padStart(4) + '  ' + row.roi.join(',').padEnd(roiW)
              + '  ' + fmt(row.score).padStart(5) + '   ' + (row.ok ? '✓' : '')
              + (row.inBand && row.rank > 1 && delta !== null
                ? '     ← Δ=' + delta + ' < ' + outcome.gap + '，并列带内' : ''))
          }
        } else {
          human.push(' （没有候选拿到分数：无排序表可打）')
        }
        human.push(' bestGap = ' + (outcome.bestGap === null ? '不可用（可评估候选不足 2 个）' : outcome.bestGap)
          + '   gap = ' + outcome.gap
          + '   withinGap = [' + outcome.withinGap.join(',') + ']'
          + '   best = ' + fmt(best)
          + (threshold !== undefined ? '   门槛 = ' + threshold : ''))

        if (source === 'scan') {
          const info = scanInfo(scan!)
          human.push(' 发现模式（--scan）：' + axisText('dx', info.dx) + ' × ' + axisText('dy', info.dy)
            + ' → ' + info.count + ' 个候选；耗时 ' + (elapsedMs / 1000).toFixed(1) + 's'
            + '（候选逐例**串行**，候选数线性涨；不是秒回）')
        } else {
          human.push(' 候选来源：'
            + (source === 'rois'
              ? '--rois（显式全套 ' + sent.length + ' 个）'
              : '--offsets（相对基准 ' + (base ?? []).join(',') + ' 的 ' + sent.length + ' 个平移）')
            + '；耗时 ' + (elapsedMs / 1000).toFixed(1) + 's')
        }

        /* 结论文案分两套：--rois/--offsets 是判据（谈位置与歧义），--scan 是发现模式
         * （只说"发现/未发现唯一最优"，不据此判"位置错了"）。 */
        const discovery = source === 'scan'
        const passText = threshold !== undefined ? '过门槛 ' + threshold : '未给 --threshold（不做门槛断言）'
        if (outcome.verdict === 'HIT') {
          const gapText = outcome.bestGap === null
            ? '（可评估候选只有 1 个，无从谈并列）'
            : '与次优差 ' + outcome.bestGap + ' ≥ gap ' + outcome.gap
          human.push(discovery
            ? ' 结论：**发现唯一最优** rank ' + top!.rank + '（roi=' + top!.roi.join(',') + ' score=' + fmt(best)
              + '，' + gapText + '）—— 这是发现模式的输出，**不构成"位置对了"的判据**；'
              + '要判位置请把候选集合显式给出来（--rois / --offsets）'
            : ' 结论：HIT —— 唯一最优 rank 1（roi=' + top!.roi.join(',') + ' score=' + fmt(best) + '），'
              + gapText + '，' + passText)
        } else if (outcome.reason === 'ambiguous') {
          human.push(' 结论：AMBIGUOUS —— 无法区分，需人工放大对比（差值过小）'
            + '：并列带内有 rank [' + outcome.withinGap.join(',') + ']（与最优的差 < gap ' + outcome.gap + '）'
            + (discovery ? '—— 周期结构下不唯一正是这个信号；这是发现模式的输出，不是"位置错了"的判据' : '')
            + '；下一步是人工放大对比，不是调阈值')
        } else if (outcome.reason === 'no-evidence') {
          human.push(' 结论：' + (discovery ? '未发现唯一最优：' : 'MISS —— ')
            + '所有候选都没有得分（外来目标在这张图上什么都没匹配上），**不是"分不出来"**；'
            + '先核对目标模板与图像是否同源、roi 是否用错空间')
        } else if (outcome.reason === 'below-threshold') {
          human.push(' 结论：' + (discovery ? '未发现唯一最优：' : 'MISS —— ')
            + '最优 ' + top!.roi.join(',') + ' 得分 ' + fmt(best) + ' < 门槛 ' + threshold
            + '；识别未命中不是调低阈值的理由（先核对模板与画面是否同源）')
        } else {
          human.push(' 结论：' + (discovery ? '未发现唯一最优' : 'MISS') + '（' + outcome.reason + '）')
        }
        /* 无得分的候选被**剔除**在比较之外（不是当 0 分垫底）：这件事必须写出来，
         * 并由退出码 3 承担——否则"还有候选没被评估过"就被结论盖掉了。 */
        if (missing.length && outcome.reason !== 'no-evidence') {
          human.push(' 注：另有 ' + missing.length + ' 个候选无得分（' + missing.map((x) => x.roi.join(',')).join(' / ')
            + '），已从比较里剔除（无证据 ≠ 0 分，也不当垫底）——本结论只对可评估的 '
            + (items.length - missing.length) + ' 个成立；退出码按"有候选无法评估"给 3')
        }

        const exitCode = outcome.verdict === 'HIT' && !missing.length ? EXIT.OK : EXIT.FINDINGS
        return {
          exitCode,
          human,
          data: {
            image, target, type,
            source,
            ...(base ? { base } : {}),
            imageSize: known ? { w, h } : null,
            candidates: {
              sent: sent.length,
              evaluated: items.length - missing.length,
              missing: missing.map((x) => x.roi),
              skipped: skipped.map((s) => ({ roi: s.roi, origin: s.origin, reason: s.reason })),
            },
            /* 逐例回执（**输入顺序**，**含没有得分的那几例**）：完整记录，`ranked` 只放有得分的。
             * `caseRoi` 是 daemon 回执里那例自己的 param.roi，必须与 `roi` 逐例相等。 */
            cases: items.map((x) => ({
              origin: x.origin,
              roi: x.roi,
              caseRoi: caseRoiByOrigin.get(x.origin) ?? null,
              score: x.score,
              ok: x.ok,
            })),
            ranked: outcome.ranked.map((x) => ({
              rank: x.rank, roi: x.roi, score: x.score, ok: x.ok, box: x.box, origin: x.origin, inBand: x.inBand,
            })),
            bestGap: outcome.bestGap,
            gap: outcome.gap,
            withinGap: outcome.withinGap,
            threshold: threshold ?? null,
            verdict: outcome.verdict,
            reason: outcome.reason,
            exit: exitCode,
            elapsedMs,
            ...(scan ? { scan: { ...scanInfo(scan), step: scanStep(scan) } } : {}),
          },
        }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const ROI_COMPARE_COMMANDS: Command[] = [roiCompareCommand]
