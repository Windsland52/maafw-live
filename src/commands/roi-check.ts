/**
 * ROI 验真：`maafw-live roi-check` —— 用**外来目标**判断一个 ROI 该落在哪一套候选相位上。
 *
 * 为什么需要它（G17）：`crop` 的自匹配是**自洽**检查——模板把背景连元素一起裁进去也照样
 * 「位置正确」；`reco` 只回答你问的问题，没法告诉你问题本身问错了。本案例里 8 个几何脚本
 * 全部收敛到错误的周期相位（棋盘 3×5：格心间距 ≈136px，格与格之间的分隔槽也是 ≈136px），
 * 每套假设各自等距、自洽、看着都对，**没有一个脚本承认过自己不确定**。
 *
 * 判据（三点是灵魂）：
 *  1. **必须用外来目标**（`--target`，资源目录里的模板）：用"假说自己"当模板，两套假设各自
 *     1.000，什么都没证明；
 *  2. **必须能说「分不出来」**：本位置与对照位置的分差 < 0.15 → `AMBIGUOUS` + 退出 3，
 *     把"该做放大对比"变成工具主动喊出来的事；
 *  3. **两个假设的分数都要给**：单边只能证明"旧的不对"，证明不了"新的对"。
 *
 * 本命令现在是**薄包装**：候选集合比较的判据（生成 / 排序 / bestGap / 并列带 / 三态）都在
 * `src/runtime/roi-compare.ts`，这里只负责把它接到本命令既有的回执与文案上。
 * 候选生成器 `--pitch`（本位置 + 沿 x 偏移 ±pitch/2）是**案例专用**的形状：它假定单一周期、
 * 且 y 从不偏移；泛用的形态是 `maafw-live roi-compare`（`--rois` / `--offsets` / `--scan`）。
 * 缺 `--pitch` 时**不做对照**：推测周期正是本条批评的静默错，缺省只报单边分 + 明说"未做对照"。
 */
import { existsSync } from 'node:fs'
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { recoTest, withDaemon } from '../runtime/actions.js'
import {
  aggregate, DEFAULT_GAP, fromOffsets, sampleOf,
  type CandidateSet, type CompareItem, type FrameSize, type Offset,
} from '../runtime/roi-compare.js'
import { daemonFail } from './runtime.js'

const fmt = (n: number | null): string => (n === null ? '（无得分）' : String(Math.round(n * 1000) / 1000))

export const roiCheckCommand: Command = {
  name: 'roi-check',
  summary: 'ROI 验真：用外来模板比对「本位置」与「偏移半周期」两套候选，分不出来时明确报 AMBIGUOUS',
  usage: 'maafw-live roi-check --image <png> --roi x,y,w,h --target <资源目录内的模板> [--pitch <周期>]\n' +
    '                    [--resource-dir <dir>] [--threshold <t>]\n' +
    '       判据是**外来目标**（不是自匹配）：本位置分 / 对照位置分 / 差值 / 结论(HIT|MISS|AMBIGUOUS)\n' +
    '       对照位置 = roi 沿 x 偏移 ±pitch/2，取更相似的那个；缺 --pitch 只报单边分并明说未做对照\n' +
    '       --pitch 是**案例专用的候选生成器**（单一周期、y 不偏移）；泛用形态见 `maafw-live roi-compare`\n' +
    '       （--rois 显式全套 / --offsets 相对平移 / --scan 发现模式）\n' +
    '       退出码：0 命中 / 3 歧义或未命中 / 2 参数错',
  options: {
    image: { type: 'string' },
    roi: { type: 'string' },
    target: { type: 'string' },
    pitch: { type: 'string' },
    'resource-dir': { type: 'string' },
    threshold: { type: 'string' },
    name: { type: 'string' },
  },

  async run(ctx): Promise<CommandResult> {
    const image = typeof ctx.values.image === 'string' ? ctx.values.image : undefined
    const target = typeof ctx.values.target === 'string' ? ctx.values.target : undefined
    const resourceDir = typeof ctx.values['resource-dir'] === 'string' ? ctx.values['resource-dir'] : undefined
    if (!image || !target) {
      return fail('BAD_ARGUMENTS', '缺 --image <png> 或 --target <模板>',
        '外来目标是本命令的灵魂：用"假说自己"当模板，两套假设各自 1.000，什么都证明不了', EXIT.USAGE)
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
    const roiRaw = typeof ctx.values.roi === 'string' ? ctx.values.roi : undefined
    const roi = roiRaw ? roiRaw.split(',').map((x) => Number(String(x).trim())) : undefined
    if (!roi || roi.length !== 4 || roi.some((n) => !Number.isFinite(n))) {
      return fail('BAD_ARGUMENTS', '--roi 需要 4 个数字：x,y,w,h（按 --image 的像素坐标给）', undefined, EXIT.USAGE)
    }
    const pitchRaw = typeof ctx.values.pitch === 'string' ? ctx.values.pitch : undefined
    const pitch = pitchRaw !== undefined ? Number(pitchRaw) : undefined
    if (pitchRaw !== undefined && (!Number.isFinite(pitch) || pitch! <= 0)) {
      return fail('BAD_ARGUMENTS', '--pitch 必须是正数（周期像素；缺省不做对照，不按 roi 推测周期）', undefined, EXIT.USAGE)
    }
    const thrRaw = typeof ctx.values.threshold === 'string' ? ctx.values.threshold : undefined
    const threshold = thrRaw !== undefined ? Number(thrRaw) : undefined
    if (thrRaw !== undefined && (!Number.isFinite(threshold) || threshold! < 0 || threshold! > 1)) {
      return fail('BAD_ARGUMENTS', '--threshold 要在 [0,1]（TemplateMatch 的置信度门槛；缺省只报分数不下结论）',
        undefined, EXIT.USAGE)
    }
    const type = typeof ctx.values.name === 'string' && ctx.values.name ? ctx.values.name : 'TemplateMatch'

    /* `--pitch` 就是候选生成器：本位置（偏移 0）+ 沿 x 的 ±pitch/2。y 分量恒为 0 正是它的形状限制，
     * 也是泛用形态存在的理由（真实棋盘行距 ≠ 列距）。 */
    const half = pitch !== undefined ? pitch / 2 : 0
    const offsets: Offset[] = pitch !== undefined
      ? [{ dx: 0, dy: 0 }, { dx: -half, dy: 0 }, { dx: half, dy: 0 }]
      : [{ dx: 0, dy: 0 }]
    const build = (size?: FrameSize): CandidateSet => fromOffsets(offsets, roi, size)
    const sent = build().candidates

    try {
      return await withDaemon(async (c) => {
        const t0 = Date.now()
        const r = await recoTest(c, {
          resourceDir, type, image,
          param: { template: target },
          candidates: sent.map((x) => x.roi),
        }, Math.max(90000, sent.length * 5000) + 20000)
        const elapsedMs = Date.now() - t0
        const results = (r.results as Array<{ ok?: unknown; detail?: unknown }> | undefined) ?? []
        const meta = r.meta as { w?: unknown; h?: unknown } | undefined
        const imgW = Number(meta?.w)
        const imgH = Number(meta?.h)
        const known = Number.isFinite(imgW) && Number.isFinite(imgH) && imgW > 0 && imgH > 0
        if (r.ok === false && !results.length) {
          return fail('ROI_CHECK', String(r.error ?? '识别失败'), undefined, EXIT.FINDINGS)
        }
        if (results.length !== sent.length) {
          return fail('ROI_CHECK',
            '识别回执例数 ' + results.length + ' ≠ 发出的候选数 ' + sent.length + '：逐例对应关系断了，不猜',
            undefined, EXIT.FINDINGS)
        }
        const set = build(known ? { w: imgW, h: imgH } : undefined)
        const byOrigin = new Map<number, ReturnType<typeof sampleOf>>()
        sent.forEach((x, i) => byOrigin.set(x.origin, sampleOf(results[i])))

        /* 本位置越界：这是**参数用错空间**，先于一切判据报出来（roiOutOfBounds 连左上负坐标一起判）。 */
        const baseSkip = set.skipped.find((s) => s.origin === 0)
        if (baseSkip) {
          return fail('ROI_OUT_OF_BOUNDS', baseSkip.reason,
            'roi 要按 --image 的像素坐标给（控制器的 roi 差一个 scale）', EXIT.FINDINGS)
        }
        const base = byOrigin.get(0)!
        const baseRoi = set.candidates.find((x) => x.origin === 0)!.roi

        const human: string[] = [
          'ROI 验真（外来目标）：' + target + '  on ' + image,
          '  图像 ' + (known ? imgW + 'x' + imgH : '尺寸未知')
            + '  roi=' + baseRoi.join(','),
          '  本位置   score=' + fmt(base.score) + (base.ok ? '  [命中]' : '  [未中]')
            + (base.box.length ? '  box=' + JSON.stringify(base.box) : ''),
        ]

        /* 对照候选（origin ≥ 1）里界内的那些；出界的一律进"已跳过"计数并按顺序报出。
         * 候选**不预过滤**：左右都交给 roiOutOfBounds 判——同一条判据不能有两套口径。 */
        const altCand = set.candidates.filter((x) => x.origin > 0)
        const altSkipped = set.skipped.filter((x) => x.origin > 0)
        let alt: CompareItem | null = null
        let whyNoCompare = ''
        if (pitch === undefined) {
          whyNoCompare = '未给 --pitch'
        } else if (!altCand.length) {
          whyNoCompare = '±pitch/2 的对照位置越出图像（' + offsets.slice(1).map((o) =>
            [baseRoi[0]! + o.dx, baseRoi[1]! + o.dy, baseRoi[2]!, baseRoi[3]!].join(',')).join(' / ')
            + '）'
        } else {
          if (altSkipped.length) {
            human.push('  对照位置：' + altSkipped.length + ' 个越出图像，已跳过（'
              + altSkipped.map((x) => x.roi.join(',')).join(' / ') + '）')
          }
          for (const cand of altCand) {
            const p = byOrigin.get(cand.origin)!
            if (!alt || (p.score ?? -1) > (alt.score ?? -1)) {
              alt = { roi: cand.roi, origin: cand.origin, ...p }
            }
          }
        }

        const imageSize = known ? { w: imgW, h: imgH } : null
        if (!alt) {
          human.push('  对照位置：未做（' + whyNoCompare + '）——**未做验真**，本回执只证明外来目标在此位置的分数，'
            + '不能证明这个位置比"偏移半周期"更对（推测周期正是本命令拒绝做的事）')
          /* 单边结论与双边共用一条门槛口径：给了 --threshold 就按它断言，没给就按"有无得分"断言
           * （未命中不是调低阈值的理由）。这是单边，不据此声称"偏移半周期"不成立。 */
          const miss = base.score === null || (threshold !== undefined && base.score < threshold)
          const verdict = miss ? 'MISS' : 'HIT'
          human.push('  结论：' + verdict
            + (threshold === undefined
              ? '（未给 --threshold：只按有无得分判，未做门槛断言）'
              : miss && base.score !== null ? '（得分 ' + fmt(base.score) + ' < 门槛 ' + threshold + '）' : ''))
          return {
            exitCode: verdict === 'HIT' ? EXIT.OK : EXIT.FINDINGS,
            human,
            data: {
              image, roi: baseRoi, target, type, pitch: pitch ?? null, threshold: threshold ?? null,
              imageSize,
              scores: { base: { score: base.score, ok: base.ok, box: base.box }, alt: null },
              delta: null, gap: DEFAULT_GAP, varied: false, verdict,
              compare: 'none',
              compareSkipped: whyNoCompare,
              bestGap: null, withinGap: [], elapsedMs,
            },
          }
        }

        /* 三态判据的事实部分（排序 / bestGap / 并列带）来自核心；本命令保留自己既有的
         * **优先序与方向**（单测钉着）：缺证据先于歧义、歧义先于门槛、"本位置 vs 对照"看方向。
         * 泛用的 roi-compare 与之只在"门槛 vs 歧义"的次序上不同（文档定的优先序）。 */
        const items: CompareItem[] = [
          { roi: baseRoi, origin: 0, score: base.score, ok: base.ok, box: base.box },
          { roi: alt.roi, origin: alt.origin, score: alt.score, ok: alt.ok, box: alt.box },
        ]
        const outcome = aggregate(items, { gap: DEFAULT_GAP })
        const bothScored = base.score !== null && alt.score !== null
        const failThreshold = threshold !== undefined && base.score !== null && base.score < threshold
        let verdict: 'HIT' | 'MISS' | 'AMBIGUOUS'
        if (!bothScored) {
          /* 任一位置无证据 → 谈不上"分不出来"：最多只能说某一边有分。 */
          verdict = 'MISS'
        } else if (outcome.withinGap.length >= 2) {
          verdict = 'AMBIGUOUS'
        } else if (failThreshold) {
          verdict = 'MISS'
        } else {
          verdict = base.score! > alt.score! ? 'HIT' : 'MISS'
        }
        const delta = bothScored ? base.score! - alt.score! : null

        human.push('  对照位置 score=' + fmt(alt.score) + (alt.ok ? '  [命中]' : '  [未中]')
          + '  roi=' + alt.roi.join(',')
          + (alt.box.length ? '  box=' + JSON.stringify(alt.box) : ''))
        human.push(delta === null
          ? '  差值：不适用（有一侧无得分 —— 无证据不等于 0 分）'
          : '  差值（本位置 − 对照）= ' + (Math.round(delta * 1000) / 1000) + '，判定门槛 |Δ| ≥ ' + DEFAULT_GAP)
        if (verdict === 'AMBIGUOUS') {
          human.push('  AMBIGUOUS：无法区分，需人工放大对比'
            + '（两侧分差 ' + (Math.round(Math.abs(delta!) * 1000) / 1000) + ' < ' + DEFAULT_GAP
            + '；本案例的判据正是 4× 放大 A/B 四联图，不是分数）')
        } else if (verdict === 'HIT') {
          human.push('  结论：HIT —— 外来目标在本位置明显优于偏移半周期（'
            + (threshold !== undefined ? '且 ≥ 门槛 ' + threshold : '未做门槛断言（未给 --threshold）') + '）')
        } else if (!bothScored) {
          /* 文案必须与上面打印的两侧分数逐字一致：漏分的那一侧是 base 还是 alt，
           * 处置方向完全不同（目标有问题 vs 对照位置有问题）。 */
          if (base.score === null && alt.score === null) {
            human.push('  结论：MISS —— 本位置与对照位置都没有得分（外来目标在这张图上什么都没匹配上），'
              + '不是"分不出来"；先核对目标模板与图像是否同源、roi 是否用错空间')
          } else if (base.score === null) {
            human.push('  结论：MISS —— 本位置没有得分，而对照位置有（' + fmt(alt.score) + '）；'
              + '先核对目标模板与图像是否同源、roi 是否用错空间，别当成歧义去人工对比')
          } else {
            human.push('  结论：MISS —— 本位置有分（score=' + fmt(base.score) + (base.ok ? ' 命中' : ' 未中')
              + '）但对照位置没有得分：**缺的是对照证据，不是本位置没分**，所以不据此宣布胜出；'
              + '对照位置无分多为它落在图像边界外或该处无内容——先看上面的对照 roi 是否越界，再看 pitch 是否合理')
          }
        } else {
          human.push('  结论：MISS —— 对照位置更优'
            + (failThreshold ? '，且本位置得分 ' + fmt(base.score) + ' < 门槛 ' + threshold : '')
            + '；这个 roi 要么偏了半周期，要么指错了地方')
        }

        return {
          exitCode: verdict === 'HIT' ? EXIT.OK : EXIT.FINDINGS,
          human,
          data: {
            image, roi: baseRoi, target, type, pitch: pitch ?? null, threshold: threshold ?? null,
            imageSize,
            scores: {
              base: { score: base.score, ok: base.ok, box: base.box },
              alt: { score: alt.score, ok: alt.ok, box: alt.box, roi: alt.roi },
            },
            delta: delta === null ? null : Math.round(delta * 1000) / 1000,
            gap: DEFAULT_GAP,
            bestGap: outcome.bestGap,
            withinGap: outcome.withinGap,
            varied: true,
            verdict,
            compare: bothScored ? 'both-scored' : (base.score === null ? 'base-missing' : 'alt-missing'),
            elapsedMs,
          },
        }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const ROI_CHECK_COMMANDS: Command[] = [roiCheckCommand]
