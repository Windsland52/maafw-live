/**
 * 候选集合比较的判据内核：**给定外来目标 + 一组位置假设 → 排序表 + bestGap + 并列带 + 三态结论**。
 *
 * 为什么把它从 `roi-check` 里拆出来：旧形态把候选写死成"沿 x 偏移 ±pitch/2"——y 从不偏移，
 * 还要求你先知道周期。而真实棋盘的行距 ≠ 列距、列距本身也逐行不同（单一标量周期不成立），
 * 所以"半周期关系"只是近似。判据的正确形状是**候选集合比较**：候选从哪来（显式全套 / 相对平移 /
 * 发现模式）是调用方的事，这里只负责"生成 → 逐个取分 → 排序 → 下结论"。
 *
 * 三条不许动的性质：
 *  1. **没有证据 ≠ 0 分**：`score: null` 的候选不参与排序，也不许被当成垫底来"宣布胜出"
 *     （全无证据 = 未命中；部分缺证据 = 不宣布唯一最优）；
 *  2. **`bestGap` 无上限地照给**：永远报第 1 与第 2 名的真实分差，不做阈值截断——
 *     只报"带内"的差值等于把"差多少"这件事藏起来；
 *  3. **顺序可追溯**：候选带 `origin`（输入列表下标），排序稳定（同分按 origin），
 *     于是输出能被还原回输入，而不是"看起来像排序过"。
 *
 * 纯函数、不碰 IO、不碰协议：退出码与文案归命令层。
 */
import { roiOutOfBounds } from './reco-args.js'

export type Roi = number[]

/** 图像尺寸（未知时传 undefined：判不动就不判，不猜）。 */
export interface FrameSize {
  w?: unknown
  h?: unknown
}

/** 允许说"分不出来"的并列带宽度：最优与次优分差小于它就不下结论。 */
export const DEFAULT_GAP = 0.15

/** 一个候选位置。`origin` = 输入候选列表里的下标（输出可还原回输入）。 */
export interface Candidate {
  roi: Roi
  origin: number
}

/** 被越界判据挡下的候选：**跳过并报出是谁**，不静默丢弃。 */
export interface SkippedCandidate {
  roi: Roi
  origin: number
  reason: string
}

export interface CandidateSet {
  candidates: Candidate[]
  skipped: SkippedCandidate[]
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000

function finiteRoi(value: unknown): Roi | null {
  if (!Array.isArray(value) || value.length !== 4) return null
  const roi = value.map(Number)
  return roi.every((n) => Number.isFinite(n)) ? roi : null
}

/** 唯一的越界口径：一律走 `roiOutOfBounds`（它连左上负坐标一起判）。 */
function collect(
  raw: Array<{ roi: Roi | null; echo: Roi; origin: number }>,
  size?: FrameSize,
): CandidateSet {
  const candidates: Candidate[] = []
  const skipped: SkippedCandidate[] = []
  for (const e of raw) {
    if (!e.roi) {
      skipped.push({ roi: e.echo, origin: e.origin, reason: '不是 4 个有限数字，无法当 roi' })
      continue
    }
    const oob = roiOutOfBounds(e.roi, size?.w, size?.h)
    if (oob) {
      skipped.push({ roi: e.roi, origin: e.origin, reason: oob })
      continue
    }
    candidates.push({ roi: e.roi, origin: e.origin })
  }
  return { candidates, skipped }
}

/** 显式全套：每个元素就是 `[x,y,w,h]`。位置假设已经知道时用这条（**没有周期假设**）。 */
export function fromRois(rois: unknown[], size?: FrameSize): CandidateSet {
  return collect(rois.map((r, origin) => ({
    roi: finiteRoi(r),
    echo: Array.isArray(r) ? r.map(Number) : [],
    origin,
  })), size)
}

export interface Offset {
  dx: number
  dy: number
}

/** 相对一个基准位置的平移：x / y 分量都允许，列表允许非均匀（逐行不同的列距照样能表达）。 */
export function fromOffsets(offsets: Offset[], base: Roi, size?: FrameSize): CandidateSet {
  return collect(offsets.map((o, origin) => {
    const roi = [base[0]! + o.dx, base[1]! + o.dy, base[2]!, base[3]!]
    return { roi: finiteRoi(roi), echo: roi, origin }
  }), size)
}

/** 扫描轴：闭区间 `from..to`、步长 `step`（正数）。`from === to` 就是单点。 */
export interface ScanAxis {
  from: number
  to: number
  step: number
}

export interface ScanSpec {
  dx?: ScanAxis
  dy?: ScanAxis
}

/** 一个轴的取值列表（单点恒为 1 个值）。 */
export function axisValues(axis: ScanAxis | undefined): number[] {
  if (!axis) return [0]
  const step = Number.isFinite(axis.step) && axis.step > 0 ? axis.step : 1
  const out: number[] = []
  for (let v = axis.from; v <= axis.to + 1e-9; v += step) out.push(round3(v))
  return out
}

export interface ScanInfo {
  dx: ScanAxis | null
  dy: ScanAxis | null
  count: number
}

export function scanInfo(spec: ScanSpec): ScanInfo {
  return {
    dx: spec.dx ?? null,
    dy: spec.dy ?? null,
    count: axisValues(spec.dx).length * axisValues(spec.dy).length,
  }
}

/** 发现模式：笛卡尔积 dx × dy 全部落在**同一个基准 roi** 上（不是判据，见命令层文案）。 */
export function fromScan(spec: ScanSpec, base: Roi, size?: FrameSize): CandidateSet {
  const xs = axisValues(spec.dx)
  const ys = axisValues(spec.dy)
  const raw: Array<{ roi: Roi | null; echo: Roi; origin: number }> = []
  let origin = 0
  for (const dx of xs) {
    for (const dy of ys) {
      const roi = [base[0]! + dx, base[1]! + dy, base[2]!, base[3]!]
      raw.push({ roi: finiteRoi(roi), echo: roi, origin: origin++ })
    }
  }
  return collect(raw, size)
}

/**
 * `--scan` 语法解析：`dx=-160..160/8,dy=0`（逗号分段，轴是 dx / dy，值是 `<n>` 或 `<from>..<to>/<step>`）。
 *
 * 范围**必须带步长**：候选数是 (to−from)/step 线性增长、而耗时按候选数线性增长，
 * 缺省步长等于让一次手滑变成几百个候选。
 */
export function parseScan(raw: string): { value?: ScanSpec; error?: string } {
  const spec: ScanSpec = {}
  for (const part of String(raw).split(',')) {
    const seg = part.trim()
    if (!seg) continue
    const eq = seg.indexOf('=')
    if (eq < 0) return { error: '--scan 每段要写成 <轴>=<值>：' + seg + '（形如 dx=-160..160/8,dy=0）' }
    const axis = seg.slice(0, eq).trim()
    if (axis !== 'dx' && axis !== 'dy') return { error: '--scan 只认识 dx / dy 两个轴，不认识：' + seg }
    const body = seg.slice(eq + 1).trim()
    const m = /^(-?\d+(?:\.\d+)?)(?:\.\.(-?\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?)?$/.exec(body)
    if (!m) return { error: '--scan 的值要写成 <n> 或 <from>..<to>/<step>：' + seg }
    const from = Number(m[1])
    if (m[2] === undefined) {
      spec[axis] = { from, to: from, step: 1 }
      continue
    }
    if (m[3] === undefined) {
      return { error: '--scan 的范围要给步长（' + seg + ' 应写成 ' + body + '/<step>）：耗时随候选数线性增长，缺步长会让候选数失控' }
    }
    const to = Number(m[2])
    const step = Number(m[3])
    if (!(step > 0)) return { error: '--scan 的步长要正数：' + seg }
    if (to < from) return { error: '--scan 的区间为空（from > to）：' + seg }
    spec[axis] = { from, to, step }
  }
  if (spec.dx === undefined && spec.dy === undefined) {
    return { error: '--scan 至少要给一个轴：dx=… 或 dy=…' }
  }
  return { value: spec }
}

/* ───────────────────────────── 结果聚合 ───────────────────────────── */

/** 一例识别的可比较部分。分数在详情内层（miss 时 best 为 null、all 仍带候选得分）。 */
export interface Sample {
  score: number | null
  ok: boolean
  box: number[]
}

export function sampleOf(result: { ok?: unknown; detail?: unknown } | undefined): Sample {
  const inner = (result?.detail as {
    detail?: { best?: { score?: unknown; box?: unknown }; all?: Array<{ score?: unknown }> }
  } | null | undefined)?.detail
  const best = inner?.best?.score
  const boxes = (inner?.all ?? [])
    .map((x) => Number(x.score))
    .filter((n) => Number.isFinite(n))
    .concat(Number.isFinite(Number(best)) ? [Number(best)] : [])
  const box = inner?.best?.box
  return {
    score: boxes.length ? Math.max(...boxes) : null,
    ok: result?.ok === true,
    box: Array.isArray(box) ? (box as number[]) : [],
  }
}

export interface CompareItem extends Sample {
  roi: Roi
  origin: number
}

export interface RankedItem extends CompareItem {
  rank: number
  /** 落在"与最优的差 < gap"这条并列带里（带是按分数降序的前缀） */
  inBand: boolean
}

export type Verdict = 'HIT' | 'MISS' | 'AMBIGUOUS'

export type CompareReason =
  /** 唯一最优 */
  | 'unique'
  /** 与最优并列的 ≥ 2 个，分不开 */
  | 'ambiguous'
  /** 最优没过 --threshold */
  | 'below-threshold'
  /** 一个候选都没得分：目标在这张图上什么都没匹配上 */
  | 'no-evidence'
  /** 没有候选（全部越界 / 空输入） */
  | 'no-candidates'

export interface CompareOutcome {
  ranked: RankedItem[]
  bestGap: number | null
  gap: number
  /** 与最优并列的 **rank** 列表（1 起） */
  withinGap: number[]
  verdict: Verdict
  reason: CompareReason
}

/**
 * 三态判据。优先序（**别重排**）：**先把没有证据的候选剔除，再谈歧义**——
 *  ① 可评估候选 0 个 → 未命中；② 最优未过 threshold → 未命中；
 *  ③ 与最优并列（|Δ| < gap）的 ≥ 2 → AMBIGUOUS；④ 否则唯一最优。
 *
 * `score: null` 的候选**不参与**排序与并列带（"没有证据"不是 0 分，也不许被当成垫底来
 * 把最优衬托成唯一）。剩下有证据的那些谁更优，才是这里回答的问题；"还有候选没被评估过"
 * 这件事由调用方写进退出码（3）与回执，不改变这里的结论——一次 41 点的扫描里，落在背景上的
 * 点本来就拿不到相关系数（实测 `all: []`），把它们算成"分不出来"会淹没真正的信号。
 */
export function aggregate(
  items: CompareItem[],
  options: { gap?: number; threshold?: number } = {},
): CompareOutcome {
  const gap = options.gap ?? DEFAULT_GAP
  const threshold = options.threshold
  const scored = items.filter((x) => x.score !== null)
  const missing = items.filter((x) => x.score === null)
  const byScore = scored.slice().sort((a, b) => (b.score! - a.score!) || (a.origin - b.origin))
  const tail = missing.slice().sort((a, b) => a.origin - b.origin)
  const best = byScore.length ? byScore[0]!.score! : null
  const second = byScore.length > 1 ? byScore[1]!.score! : null
  const bestGap = best !== null && second !== null ? round3(best - second) : null
  const band = best === null ? [] : byScore.filter((x) => best - x.score! < gap)
  const withinGap = band.map((_, i) => i + 1)
  const ranked: RankedItem[] = [...byScore, ...tail].map((x, i) => ({
    ...x,
    rank: i + 1,
    inBand: i < band.length,
  }))

  let verdict: Verdict = 'MISS'
  let reason: CompareReason = 'no-candidates'
  if (items.length === 0) {
    reason = 'no-candidates'
  } else if (!byScore.length) {
    reason = 'no-evidence'
  } else if (threshold !== undefined && best! < threshold) {
    reason = 'below-threshold'
  } else if (band.length >= 2) {
    verdict = 'AMBIGUOUS'
    reason = 'ambiguous'
  } else {
    verdict = 'HIT'
    reason = 'unique'
  }
  return { ranked, bestGap, gap, withinGap, verdict, reason }
}
