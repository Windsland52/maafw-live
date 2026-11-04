/**
 * pipeline_override 合成（PI v2）。
 *
 * 三部分合进同一份 override：
 * 1. **task 级 `pipeline_override`**（键=节点名、值=字段覆盖）。协议只说它"执行任务时覆盖已加载的
 *    资源"，**没有把它写进 option 覆盖顺序**——本工具把它当基底（先应用），option 链在其上叠加。
 *    这是本地选择，不是协议结论。
 * 2. **option 四级链**：global_option → resource.option → controller.option → task.option，
 *    后合并覆盖先合并；进链前先按 option 自带的 controller/resource 条件过滤（v2.3.0 / v2.3.1）。
 *    checkbox 多选按 cases 声明序合并；嵌套 option 在其父 case 之后合并。
 * 3. **input / hotkey 的模板替换**：`option.<键>.pipeline_override` 是**整个 option 一份**的模板，
 *    里面有 `{字段名}` 占位——注意它与 `cases[].pipeline_override` 是协议里两处不同字段。
 *
 * 取值优先级（**协议未规定**，本工具自定）：CLI `--option` > preset > `default_case`。
 * preset 是把 GUI 用户选择搬进来的通道；CLI 表示"这一跑就按这个"，所以压过 preset。
 * input 字段还有第三档来源：`inputs[].default`（协议把它定义成默认值，本工具在无人输入时拿它替换）。
 */
import type { InterfaceOption, LoadedInterface, OptionCase } from './load.js'

export interface OverrideInput {
  loaded: LoadedInterface
  controllerName: string | null
  resourceName: string | null
  taskName: string | null
  presetName?: string | null
  /** CLI 按次取值：option 键 → case 名（select/switch 单值；checkbox 数组） */
  optionCases?: Record<string, string | string[]>
  /** CLI 按次取值：option 键 → { 字段名: 原文 }（input / hotkey 的字段映射） */
  optionFields?: Record<string, Record<string, string>>
}

export interface OverrideResult {
  override: Record<string, unknown>
  /** 需要人工注意的事项（选项无取值、preset 未找到等） */
  warns: string[]
  /** 人类可读的生效记录：option=值（级别） */
  applied: string[]
}

/**
 * 把一份 pipeline_override 并入累计结果：同节点字段替换（与协议"不深度合并"一致）。
 *
 * **唯一一份实现**：四级链、`run --override`、`timing --override` 都走这里。这三处曾经各写一份，
 * 代价是同一个参数在不同命令里表现不同。非对象值必须**原样替换、不能展开**：字符串会被摊成
 * `{0:'a',1:'b'}`，`null` / 数字会静默变成空对象——等于把用户写的节点悄悄丢掉。
 */
export function mergeOverride(acc: Record<string, unknown>, po: Record<string, unknown>): void {
  for (const [node, fields] of Object.entries(po)) {
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      acc[node] = { ...((acc[node] as Record<string, unknown>) ?? {}), ...(fields as Record<string, unknown>) }
    } else {
      acc[node] = fields
    }
  }
}

const PLACEHOLDER = /\{([^{}]+)\}/g

/**
 * 按 `pipeline_type` 转型。枚举只有 `string` / `int` / `bool`（没有 float）。
 *
 * 协议只写了"会根据该类型进行类型转换"，**没规定** int 遇到 `abc`、bool 接受哪些字面量 ——
 * 这里的规则是本地约定，宁可转不了就整条模板放弃，也不猜一个值写进 pipeline。
 */
function convert(raw: string, type: string | undefined): unknown {
  if (type === 'int') return /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined
  if (type === 'bool') {
    const s = raw.trim().toLowerCase()
    if (s === 'true' || s === '1') return true
    if (s === 'false' || s === '0') return false
    return undefined
  }
  return raw
}

export function computePipelineOverride(input: OverrideInput): OverrideResult {
  const { loaded, controllerName, resourceName, taskName, presetName } = input
  const warns: string[] = []
  const applied: string[] = []
  /** 进过链的 option 键：用来抓"--option 给了值但没有任何级别引用它"这种静默失联 */
  const reached = new Set<string>()
  const acc: Record<string, unknown> = {}
  const preset = presetName ? loaded.presets.find((p) => p.name === presetName) : undefined
  if (presetName && !preset) warns.push('preset ' + presetName + ' 不存在（可用：' + loaded.presets.map((p) => p.name).join(' / ') + '或无）')
  const presetTask = preset && taskName ? preset.task.find((t) => t.name === taskName) : undefined

  const applicable = (o: InterfaceOption): boolean => {
    if (o.controller?.length && controllerName && !o.controller.includes(controllerName)) return false
    if (o.resource?.length && resourceName && !o.resource.includes(resourceName)) return false
    return true
  }

  /** case 名取值：CLI > preset > default_case。 */
  const caseValues = (o: InterfaceOption): { cases: string[]; via: string } | null => {
    const cli = input.optionCases?.[o.name]
    if (cli !== undefined) {
      return { cases: Array.isArray(cli) ? cli.map(String) : [String(cli)], via: 'cli' }
    }
    const pv = presetTask?.option?.[o.name]
    if (pv !== undefined && !(pv && typeof pv === 'object' && !Array.isArray(pv))) {
      return { cases: Array.isArray(pv) ? pv.map(String) : [String(pv)], via: 'preset' }
    }
    if (o.defaultCase !== undefined) {
      return { cases: Array.isArray(o.defaultCase) ? o.defaultCase.map(String) : [String(o.defaultCase)], via: 'default' }
    }
    return null
  }

  /** input / hotkey 的字段取值：字段 default < preset 字段映射 < CLI 字段。 */
  const fieldValues = (o: InterfaceOption): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const f of [...(o.inputs ?? []), ...(o.hotkeys ?? [])]) {
      if (f.default !== undefined) out[f.name] = f.default
    }
    const pv = presetTask?.option?.[o.name]
    if (pv && typeof pv === 'object' && !Array.isArray(pv)) {
      for (const [k, v] of Object.entries(pv as Record<string, unknown>)) out[k] = String(v)
    }
    for (const [k, v] of Object.entries(input.optionFields?.[o.name] ?? {})) out[k] = v
    return out
  }

  /**
   * 把模板里的 `{字段名}` 换成取值：整串是占位时用转型后的值（int → 数字），
   * 出现在片段里时用它的文本形态（如 `MainChapter_{章节号}`）。
   * 有任何一个占位取不到值就整条模板放弃——写一半的 override 比不写更难查。
   */
  const substitute = (o: InterfaceOption, map: Record<string, string>): { value: Record<string, unknown>; missing: string[] } => {
    const missing: string[] = []
    const typeOf = (field: string): string | undefined => o.inputs?.find((f) => f.name === field)?.pipelineType
    const one = (field: string): unknown => {
      const raw = map[field]
      if (raw === undefined) {
        if (!missing.includes(field)) missing.push(field)
        return undefined
      }
      const v = convert(raw, typeOf(field))
      if (v === undefined) missing.push(field + '=' + raw + '（按 pipeline_type=' + String(typeOf(field) ?? 'string') + ' 转不了）')
      return v
    }
    const walk = (n: unknown): unknown => {
      if (typeof n === 'string') {
        const whole = /^\{([^{}]+)\}$/.exec(n)
        if (whole) return one(whole[1])
        return n.replace(PLACEHOLDER, (_m, name: string) => {
          const v = one(name)
          return v === undefined ? '' : String(v)
        })
      }
      if (Array.isArray(n)) return n.map(walk)
      if (n && typeof n === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(n as Record<string, unknown>)) out[k] = walk(v)
        return out
      }
      return n
    }
    return { value: walk(o.pipelineOverride) as Record<string, unknown>, missing }
  }

  const mergeOption = (name: string, level: string, chain: string[] = []): void => {
    /* 嵌套 option 是"case 里再列 option"，A → B → A 这类自引用会让递归停不下来：
     * 记一条警告并跳过，而不是用栈溢出把整条 run 打断。 */
    if (chain.includes(name)) {
      warns.push('option ' + name + ' 出现在自己的嵌套链里（' + [...chain, name].join(' > ') + '），已跳过')
      return
    }
    const o = loaded.options[name]
    if (!o) {
      warns.push('option ' + name + ' 未在 interface 中定义，已跳过')
      return
    }
    reached.add(name)
    if (!applicable(o)) {
      if (input.optionCases?.[name] !== undefined || input.optionFields?.[name] !== undefined) {
        warns.push('option ' + name + ' 不适用于当前控制器/资源（适用性过滤），--option 给的取值未生效')
      }
      return
    }

    if (o.type === 'input' || o.type === 'hotkey') {
      const tpl = o.pipelineOverride
      if (!tpl || !Object.keys(tpl).length) {
        /* 没有模板 = 没有东西可丢。但如果有人专门给它传了 --option，那是一次静默失联，要说。 */
        if (input.optionFields?.[o.name] !== undefined) {
          warns.push('option ' + o.name + ' 声明为 ' + o.type + ' 但没有 pipeline_override 模板，--option 给的字段不参与覆盖')
        }
        return
      }
      if (o.type === 'hotkey') {
        /* 占位符产出的是**当前控制器的虚拟按键码整数**（Win32 VK / Android KeyEvent / …）。
         * 协议与 schema 都不给映射表，maa-node 只暴露裸 keycode：本工具没有这张表，
         * 硬编一份不全的等于制造新的静默错——跳过并说清楚，让人用 --override 给整数。 */
        warns.push(
          'option ' + name + '（' + level + '）是 hotkey 类型：pipeline_override 要把它映射成控制器的虚拟按键码，' +
            '协议不提供映射表、本工具未内置，这一层覆盖已跳过（要补请用 --override 直接写整数键码）',
        )
        return
      }
      const fields = fieldValues(o)
      const r = substitute(o, fields)
      if (r.missing.length) {
        warns.push(
          'option ' + name + '（' + level + '）的 pipeline_override 模板里这些占位没有取值：' +
            r.missing.join(' / ') + '——整条覆盖已跳过（用 --option ' + name + '.<字段>=<值> 给值）',
        )
        return
      }
      mergeOverride(acc, r.value)
      const shown = Object.entries(fields).map(([k, v]) => k + '=' + v).join('，')
      applied.push(name + '=（input' + (shown ? '：' + shown : '') + '，' + level + '）')
      return
    }

    const v = caseValues(o)
    if (!v) {
      warns.push('option ' + name + '（' + level + '）无 preset/default_case 取值，跳过其 pipeline_override')
      return
    }
    for (const cname of v.cases) {
      const c = o.cases.find((x: OptionCase) => x.name === cname)
      if (!c) {
        warns.push('option ' + name + ' 的取值 ' + cname + ' 不是已声明的 case，已跳过')
        continue
      }
      if (c.pipelineOverride && Object.keys(c.pipelineOverride).length) {
        mergeOverride(acc, c.pipelineOverride)
        applied.push(name + '=' + cname + '（' + level + '，via ' + v.via + '）')
      }
      /* 嵌套子 option：父 case 生效后按声明顺序合并（更具体，晚于父级） */
      for (const child of c.option ?? []) mergeOption(child, level + ' > ' + name, [...chain, name])
    }
  }

  /* task 级覆盖是基底：协议只规定 option 四级顺序，没说它插在哪一级——这里按"先应用"处理。 */
  const taskDecl = taskName ? loaded.tasks.find((x) => x.name === taskName) : undefined
  if (taskDecl?.pipelineOverride && Object.keys(taskDecl.pipelineOverride).length) {
    mergeOverride(acc, taskDecl.pipelineOverride)
    applied.push('task.pipeline_override（task 级基底）')
  }

  for (const name of loaded.globalOption) mergeOption(name, 'global_option')
  if (resourceName) {
    const r = loaded.resources.find((x) => x.name === resourceName)
    for (const name of r?.option ?? []) mergeOption(name, 'resource.option')
  }
  if (controllerName) {
    const c = loaded.controllers.find((x) => x.name === controllerName)
    for (const name of c?.option ?? []) mergeOption(name, 'controller.option')
  }
  if (taskName) {
    const t = loaded.tasks.find((x) => x.name === taskName)
    for (const name of t?.option ?? []) mergeOption(name, 'task.option')
  }

  /* --option 的键必须有级别引用过它，否则用户以为改了、其实没进链 */
  for (const key of [...Object.keys(input.optionCases ?? {}), ...Object.keys(input.optionFields ?? {})]) {
    if (!reached.has(key)) {
      warns.push('--option 里的 ' + key + ' 没有被任何级别引用（global/resource/controller/task 都没列它），取值未生效')
    }
  }

  return { override: acc, warns, applied }
}
