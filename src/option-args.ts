/**
 * `run --option` 的 argv 解析。
 *
 * 只做**切分**，不判 option 类型、不查 case 是否存在——类型、适用性、case 名合法性只有 interface
 * 知道，判定收口在 `computePipelineOverride` 一处，CLI 与 REPL 各写一套就会分叉。
 *
 * 两种写法：
 * - `<键>=<值>`：select / switch 的 case 名；checkbox 用逗号分隔多个 case
 * - `<键>.<字段>=<值>`：input 的输入字段（占位符 `{字段名}` 引用的就是它）
 */
export interface OptionArgs {
  /** option 键 → case 名（单值或数组） */
  cases: Record<string, string | string[]>
  /** option 键 → { 字段名: 原文 } */
  fields: Record<string, Record<string, string>>
  /** 写法非法时的原因（调用方决定怎么报） */
  error?: string
}

export function parseOptionArgs(list: unknown): OptionArgs {
  const out: OptionArgs = { cases: {}, fields: {} }
  const items = Array.isArray(list) ? list : list === undefined ? [] : [list]
  for (const item of items) {
    const s = typeof item === 'string' ? item : ''
    const eq = s.indexOf('=')
    const lhs = eq > 0 ? s.slice(0, eq).trim() : ''
    if (!lhs) {
      out.error = '--option 要写成 <键>=<值> 或 <键>.<字段>=<值>：' + JSON.stringify(item)
      return out
    }
    const rhs = s.slice(eq + 1)
    const dot = lhs.indexOf('.')
    if (dot > 0) {
      const key = lhs.slice(0, dot)
      const field = lhs.slice(dot + 1)
      if (!field) {
        out.error = '--option 的字段名不能为空：' + JSON.stringify(item)
        return out
      }
      out.fields[key] = { ...(out.fields[key] ?? {}), [field]: rhs }
    } else {
      out.cases[lhs] = rhs.includes(',') ? rhs.split(',').map((x) => x.trim()).filter(Boolean) : rhs
    }
  }
  return out
}
