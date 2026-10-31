/**
 * 识别未命中的原因与计数：**只有这一份判据**，一次性 CLI 与 REPL 都读它。
 *
 * 为什么单独立文件：miss 的病因直接决定下一步查什么（roi 里没有字 / expected 过滤掉了 /
 * 分数不够 / 模板根本读不到），两个壳各推一遍必然分叉，而分叉的代价是把"expected 不匹配"
 * 当成"模板读不到"去翻资源目录。
 *
 * 名字按**算法**分开给，不共用一套 OCR 口径：OCR 没有阈值这回事，模板匹配也没有 `expected`
 * 这回事——共用口径就会编出不存在的病因。表以外的算法不猜，如实不给原因。
 *
 * OCR 的空结果还有一个同形病因：**模型没加载时框架不报错，只回空结果**。这条不在本文件的
 * 职责内（要查文件系统），由调用方用 `runtime/ocr-model` 判好、以 `options.ocrModel` 传进来。
 *
 * 派生的前提是**先看 hit**：`noConfidence` 旧式判据（`threshold 建议为 null`）在 OCR 命中时
 * 也成立（OCR 无数值分），不看 `ok` 就会把命中标成"无置信度"。
 */

export interface RecoResultLike {
  ok?: boolean
  detail?: unknown
  /** 子进程捕获到的识别调用异常（此时 detail 为 null）；不是"未命中"，是"没跑成" */
  error?: unknown
}

/** 打分摘要（与 `suggestThreshold` 同源，跨层传结构而不传函数，避免 runtime → commands 反向依赖） */
export interface ScoreSummary {
  bestScore: number
  lowMatch: boolean
}

/** 派生原因时需要调用方补的外部事实：本文件保持纯函数，文件系统检查由调用方做（runtime/ocr-model） */
export interface MissOptions {
  /** OCR 模型是否在资源链里；'missing' 时"空结果"先指向模型，不是 roi */
  ocrModel?: 'present' | 'missing'
}

export interface MissDetail {
  missReason: string | null
  rawCount: number | null
  filteredCount: number | null
  /** 识别调用本身报错（detail 缺失），不是"未命中"——渲染层要分开标，别打 [未中] */
  failed: boolean
}

export interface MissVerdict {
  /** 回执级原因：所有未命中的原因一致时才有值 */
  missReason: string | null
  /** 回执级去重后的原因（多例扫描可能不止一种） */
  missReasons: string[]
  /** 只在单例回执上给：多例求和会被读成"候选有多少个"，而它其实是逐例之和 */
  rawCount: number | null
  filteredCount: number | null
  perResult: MissDetail[]
}

function innerDetail(detail: unknown): { all?: unknown; filtered?: unknown } | null {
  const outer = detail as { detail?: unknown } | null | undefined
  const inner = outer && typeof outer === 'object' ? outer.detail : undefined
  return inner && typeof inner === 'object' ? (inner as { all?: unknown; filtered?: unknown }) : null
}

function countOf(v: unknown): number | null {
  return Array.isArray(v) ? v.length : null
}

function reasonFor(
  hit: boolean,
  type: string,
  rawCount: number | null,
  scores: ScoreSummary | null,
  ocrModel: 'present' | 'missing' | undefined,
  failure: string | null,
): string | null {
  if (hit) return null
  /* 调用本身报错（detail 为 null）优先于一切算法口径：这不是"未命中"，别按未命中解释 */
  if (failure !== null) return '识别调用报错：' + failure
  if (type === 'OCR') {
    if (rawCount === 0) {
      /* 模型没加载时框架不报错，只回空结果——与"roi 里没有字"同形，先排前者 */
      if (ocrModel === 'missing') return 'OCR 模型不在资源链里（model/ocr 需 det.onnx + rec.onnx + keys.txt）'
      return 'roi 内无文字'
    }
    if (rawCount !== null && rawCount > 0) return 'expected 无匹配'
    return null
  }
  if (type === 'TemplateMatch') {
    if (scores === null) return '识别未返回任何置信度（模板/资源读不到）'
    if (scores.lowMatch) return '模板与画面不匹配（最高置信度 ' + scores.bestScore + '）'
    return '低于阈值（最高置信度 ' + scores.bestScore + '）'
  }
  return null
}

export function describeMisses(
  results: RecoResultLike[],
  type: string,
  scores: ScoreSummary | null,
  options: MissOptions = {},
): MissVerdict {
  const perResult: MissDetail[] = results.map((r) => {
    const inner = innerDetail(r.detail)
    const rawCount = countOf(inner?.all)
    const filteredCount = countOf(inner?.filtered)
    /* detail 缺失 = 子进程捕获到异常（正常 miss 时框架仍回 detail 对象）。异常文本直接给人看，
     * 但截断：它是框架的原生消息，可能很长。 */
    const hasDetail = r.detail !== null && typeof r.detail === 'object'
    const errText = typeof r.error === 'string' && r.error.trim() !== '' ? r.error.trim() : null
    const failure = hasDetail ? null : (errText ?? '未返回 detail（调用失败）')
    return {
      missReason: reasonFor(r.ok === true, type, rawCount, scores, options.ocrModel,
        failure && failure.length > 160 ? failure.slice(0, 160) + ' …' : failure),
      rawCount,
      filteredCount,
      failed: failure !== null && r.ok !== true,
    }
  })
  const reasons: string[] = []
  for (const p of perResult) {
    if (p.missReason && !reasons.includes(p.missReason)) reasons.push(p.missReason)
  }
  const single = results.length === 1 ? perResult[0] : undefined
  return {
    missReason: reasons.length === 1 ? reasons[0] : null,
    missReasons: reasons,
    rawCount: single ? single.rawCount : null,
    filteredCount: single ? single.filteredCount : null,
    perResult,
  }
}
