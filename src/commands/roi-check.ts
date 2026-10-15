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
 * 实现复用既有 `reco_test` 通道（**本仓库没有 NCC / 模板匹配实现**，全库 grep 0 命中；
 * 唯一能出匹配分的路是 MaaFW 的 TemplateMatch）——对同一张 `--image` 跑两次识别，
 * 两次之间没有画面漂移风险。缺 `--pitch` 时**不做对照**：推测周期正是本条批评的静默错，
 * 缺省只报单边分 + 明说"未做对照"。
 */
import { existsSync } from 'node:fs'
import type { DaemonClient } from '../client/daemon.js'
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { recoTest, withDaemon } from '../runtime/actions.js'
import { roiOutOfBounds } from '../runtime/reco-args.js'
import { daemonFail } from './runtime.js'

/** 允许说"分不出来"的门槛：两侧分差小于它就不下结论（与原稿约定一致）。 */
const AMBIGUOUS_GAP = 0.15

interface Probe {
  score: number | null
  ok: boolean
  boxes: number[]
}

/** 取一例识别结果的分数与命中框。分数在识别详情内层（miss 时 best 为 null、all 仍带候选分）。 */
function probeResult(result: { ok?: unknown; detail?: unknown } | undefined): Probe {
  const inner = (result?.detail as { detail?: { best?: { score?: unknown }; all?: Array<{ score?: unknown }> } } | null | undefined)?.detail
  const best = inner?.best?.score
  const boxes = (inner?.all ?? [])
    .map((x) => Number(x.score))
    .filter((n) => Number.isFinite(n))
    .concat(Number.isFinite(Number(best)) ? [Number(best)] : [])
  const score = boxes.length ? Math.max(...boxes) : null
  const box = (inner?.best as { box?: unknown } | undefined)?.box
  return {
    score,
    ok: result?.ok === true,
    boxes: Array.isArray(box) ? (box as number[]) : [],
  }
}

const fmt = (n: number | null): string => (n === null ? '（无得分）' : String(Math.round(n * 1000) / 1000))

export const roiCheckCommand: Command = {
  name: 'roi-check',
  summary: 'ROI 验真：用外来模板比对「本位置」与「偏移半周期」两套候选，分不出来时明确报 AMBIGUOUS',
  usage: 'maafw-live roi-check --image <png> --roi x,y,w,h --target <资源目录内的模板> [--pitch <周期>]\n' +
    '                    [--resource-dir <dir>] [--threshold <t>]\n' +
    '       判据是**外来目标**（不是自匹配）：本位置分 / 对照位置分 / 差值 / 结论(HIT|MISS|AMBIGUOUS)\n' +
    '       对照位置 = roi 沿 x 偏移 ±pitch/2，取更相似的那个；缺 --pitch 只报单边分并明说未做对照\n' +
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

    /** 在给定 roi 上跑一次外来目标识别，拿回分数与命中框。 */
    const probe = async (c: DaemonClient, useRoi: number[]): Promise<Probe> => {
      const r = await recoTest(c, {
        resourceDir, type, image,
        param: { template: target, roi: useRoi },
      })
      const results = (r.results as Array<{ ok?: unknown; detail?: unknown }> | undefined) ?? []
      if (r.ok === false && !results.length) {
        throw new Error(String(r.error ?? '识别失败'))
      }
      return probeResult(results[0])
    }

    try {
      return await withDaemon(async (c) => {
        /* 图像尺寸先要一次：daemon 的 reco_test 回执带 meta.w/h，越界判据靠它（不猜）。 */
        const first = await recoTest(c, { resourceDir, type, image, param: { template: target, roi } })
        const meta = first.meta as { w?: unknown; h?: unknown } | undefined
        const imgW = Number(meta?.w)
        const imgH = Number(meta?.h)
        const oob = roiOutOfBounds(roi, meta?.w, meta?.h)
        if (oob) {
          return fail('ROI_OUT_OF_BOUNDS', oob, 'roi 要按 --image 的像素坐标给（控制器的 roi 差一个 scale）', EXIT.FINDINGS)
        }
        const firstResults = (first.results as Array<{ ok?: unknown; detail?: unknown }> | undefined) ?? []
        if (first.ok === false && !firstResults.length) {
          return fail('ROI_CHECK', String(first.error ?? '识别失败'), undefined, EXIT.FINDINGS)
        }
        const base = probeResult(firstResults[0])

        const human: string[] = [
          'ROI 验真（外来目标）：' + String(target) + '  on ' + image,
          '  图像 ' + (Number.isFinite(imgW) && Number.isFinite(imgH) ? imgW + 'x' + imgH : '尺寸未知')
            + '  roi=' + roi.join(','),
          '  本位置   score=' + fmt(base.score) + (base.ok ? '  [命中]' : '  [未中]')
            + (base.boxes.length ? '  box=' + JSON.stringify(base.boxes) : ''),
        ]

        let alt: Probe | null = null
        let altRoi: number[] | null = null
        if (pitch !== undefined) {
          const half = pitch / 2
          const candidates = [-half, half]
            .map((d) => ({ d, r: [roi[0] + d, roi[1], roi[2], roi[3]] }))
            .filter((x) => x.r[0] >= 0)
          if (!candidates.length) {
            human.push('  对照位置：跳过（roi 左右都放不下 ±pitch/2）')
          } else {
            for (const cand of candidates) {
              const p = await probe(c, cand.r)
              if (!alt || (p.score ?? -1) > (alt.score ?? -1)) { alt = p; altRoi = cand.r }
            }
          }
        }

        if (!alt || !altRoi) {
          human.push('  对照位置：未做（' + (pitch === undefined ? '未给 --pitch' : '放不下 ±pitch/2')
            + '）——**未做验真**，本回执只证明外来目标在此位置的分数，'
            + '不能证明这个位置比"偏移半周期"更对（推测周期正是本命令拒绝做的事）')
          /* 单边结论用与对照路径同一条门槛口径：给了 --threshold 就按它断言，
           * 没给就按"有无得分"断言（未命中不是调低阈值的理由）。 */
          const miss = base.score === null
            || (threshold !== undefined && base.score < threshold)
          const verdict = miss ? 'MISS' : 'HIT'
          human.push('  结论：' + verdict
            + (threshold === undefined
              ? '（未给 --threshold：只按有无得分判，未做门槛断言）'
              : miss && base.score !== null ? '（得分 ' + fmt(base.score) + ' < 门槛 ' + threshold + '）' : ''))
          return {
            exitCode: verdict === 'HIT' ? EXIT.OK : EXIT.FINDINGS,
            human,
            data: {
              image, roi, target, type, pitch: null, threshold: threshold ?? null,
              imageSize: Number.isFinite(imgW) && Number.isFinite(imgH) ? { w: imgW, h: imgH } : null,
              scores: { base: { score: base.score, ok: base.ok, box: base.boxes }, alt: null },
              delta: null, gap: AMBIGUOUS_GAP, varied: false, verdict,
            },
          }
        }

        /* 分数为 null = **没有证据**，不是 0 分。先按"有没有证据"定结论，再谈歧义——
         * 反过来的话，两侧都无分（目标根本不存在）会算出 Δ=0 → 误报 AMBIGUOUS，
         * 而 AMBIGUOUS 是这条命令的灵魂信号（专门喊"该人工放大对比"），
         * 被滥用到"什么都没匹配上"的场景就退化成噪声。单边路径本来就是这么判的。 */
        const bothScored = base.score !== null && alt.score !== null
        const failThreshold = threshold !== undefined && base.score !== null && base.score < threshold
        let verdict: 'HIT' | 'MISS' | 'AMBIGUOUS'
        if (!bothScored) {
          /* 任一位置无证据 → 谈不上"分不出来"：最多只能说某一边有分。 */
          verdict = 'MISS'
        } else if (Math.abs(base.score! - alt.score!) < AMBIGUOUS_GAP) {
          verdict = 'AMBIGUOUS'
        } else if (failThreshold) {
          verdict = 'MISS'
        } else {
          verdict = base.score! > alt.score! ? 'HIT' : 'MISS'
        }
        const delta = bothScored ? base.score! - alt.score! : null

        human.push('  对照位置 score=' + fmt(alt.score) + (alt.ok ? '  [命中]' : '  [未中]')
          + '  roi=' + altRoi.join(',')
          + (alt.boxes.length ? '  box=' + JSON.stringify(alt.boxes) : ''))
        human.push(delta === null
          ? '  差值：不适用（有一侧无得分 —— 无证据不等于 0 分）'
          : '  差值（本位置 − 对照）= ' + (Math.round(delta * 1000) / 1000) + '，判定门槛 |Δ| ≥ ' + AMBIGUOUS_GAP)
        if (verdict === 'AMBIGUOUS') {
          human.push('  AMBIGUOUS：无法区分，需人工放大对比'
            + '（两侧分差 ' + (Math.round(Math.abs(delta!) * 1000) / 1000) + ' < ' + AMBIGUOUS_GAP
            + '；本案例的判据正是 4× 放大 A/B 四联图，不是分数）')
        } else if (verdict === 'HIT') {
          human.push('  结论：HIT —— 外来目标在本位置明显优于偏移半周期（'
            + (threshold !== undefined ? '且 ≥ 门槛 ' + threshold : '未做门槛断言（未给 --threshold）') + '）')
        } else if (!bothScored) {
          human.push('  结论：MISS —— ' + (base.score === null && alt.score === null
            ? '两套候选都没有得分（外来目标在这张图上什么都没匹配上），不是"分不出来"'
            : '本位置没有得分'
              + (alt.score !== null ? '，而对照位置有（' + fmt(alt.score) + '）' : ''))
            + '；先核对目标模板与图像是否同源、roi 是否用错空间，别当成歧义去人工对比')
        } else {
          human.push('  结论：MISS —— 对照位置更优'
            + (failThreshold ? '，且本位置得分 ' + fmt(base.score) + ' < 门槛 ' + threshold : '')
            + '；这个 roi 要么偏了半周期，要么指错了地方')
        }

        return {
          exitCode: verdict === 'HIT' ? EXIT.OK : EXIT.FINDINGS,
          human,
          data: {
            image, roi, target, type, pitch: pitch ?? null, threshold: threshold ?? null,
            imageSize: Number.isFinite(imgW) && Number.isFinite(imgH) ? { w: imgW, h: imgH } : null,
            scores: {
              base: { score: base.score, ok: base.ok, box: base.boxes },
              alt: { score: alt.score, ok: alt.ok, box: alt.boxes, roi: altRoi },
            },
            delta: delta === null ? null : Math.round(delta * 1000) / 1000,
            gap: AMBIGUOUS_GAP,
            varied: true,
            verdict,
          },
        }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const ROI_CHECK_COMMANDS: Command[] = [roiCheckCommand]
