/**
 * pipeline_override 合成（PI v2）。
 *
 * **输出是分层数组，不是预合并对象**（上游语义，MaaFramework @8061d5b 已核）：
 * `RuntimeParam::Task.pipeline_override` 是 `json::array`，Configurator 把 task 基底放
 * `[0]`、每个 option case / input 模板各占一层；`Context::override_pipeline` 逐层
 * `parse_node(node, layer, default=上一层结果)`——缺失字段继承前值，`recognition`/`action`
 * 的 `param` 在同 type 时按键继承。**边界在层间**：上一层把 recognition.type 换成别种，
 * param 就不能继承上一层的字段。若我们客户端先摊平成一个对象，跨层"换 type"后的
 * param 会被错认为"同 type 继承"——只有分层数组能保边界。
 *
 * 层序（与上游 Configurator 一致，后者覆盖先者）：
 * 1. **task 级 `pipeline_override`** 作 `[0]`（上游同样放数组首位）。
 * 2. **option 四级链**：global_option → resource.option → controller.option → task.option，
 *    每个生效 case / input 模板各占一层；进链前先按 option 的 controller/resource
 *    条件过滤（v2.3.0 / v2.3.1）。checkbox 多选按 cases 声明序各成一层；
 *    嵌套 option 紧跟其父 case 之后。
 * 3. **input / hotkey 的模板替换**：`option.<键>.pipeline_override` 是**整个 option 一份**
 *    的模板，里面有 `{字段名}` 占位——注意它与 `cases[].pipeline_override` 是协议里两处不同字段。
 *
 * 取值优先级（**协议未规定**，本工具自定）：CLI `--option` > preset > `default_case`。
 * preset 是把 GUI 用户选择搬进来的通道；CLI 表示"这一跑就按这个"，所以压过 preset。
 * input 字段还有第三档来源：`inputs[].default`（协议把它定义成默认值，本工具在无人输入时拿它替换）。
 */
import type { InterfaceOption, LoadedInterface, OptionCase } from './load.js'
import { hotkeyTableFor, resolveHotkeyTokens } from './hotkey.js'

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
  /** 分层 override：逐元素交给框架 `override_pipeline`，层间字段继承（数组尾=最高优先级） */
  override: Record<string, unknown>[]
  /** 需要人工注意的事项（选项无取值、preset 未找到等） */
  warns: string[]
  /** 人类可读的生效记录：option=值（级别） */
  applied: string[]
}

/**
 * 把调用方的覆盖（`--override`）追加到分层数组尾部 = 最高优先级。
 * 对象 = 一层；数组 = 逐层（框架本来就接受数组，逐层继承，别在这里预合并）。
 * 四级链、`run --override`、`timing --override` 共用这一个追加口——三处曾经各写一份，
 * 代价是同一个参数在不同命令里表现不同。
 */
export function appendOverride(
  layers: Record<string, unknown>[],
  ov: Record<string, unknown> | Record<string, unknown>[] | undefined,
): void {
  if (!ov) return
  const list = Array.isArray(ov) ? ov : [ov]
  for (const layer of list) if (layer && typeof layer === 'object' && Object.keys(layer).length) layers.push(layer)
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

export interface OptionValueCtx {
  /** 命中的 preset 任务条目（`preset[].task[]`）：取值快照 */
  presetTask?: { option?: Record<string, unknown> }
  /** CLI 按次取值：case 名 */
  optionCases?: Record<string, string | string[]>
  /** CLI 按次取值：字段映射 */
  optionFields?: Record<string, Record<string, string>>
}

export type ResolvedOptionValue =
  | { kind: 'cases'; cases: string[]; via: string }
  | { kind: 'fields'; fields: Record<string, string>; via: string }

/**
 * 解析一个 option 的当前取值（**唯一一份实现**）：pipeline_override 合成与 pretask 的末位 JSON
 * 都走这里，两边各写一套迟早会在"preset 的 input 值是对象还是字符串"上分叉。
 *
 * 优先级（协议未规定，本地约定）：CLI > preset > 声明里的初始值（`default_case` / `inputs[].default`）。
 */
export function resolveOptionValue(o: InterfaceOption, ctx: OptionValueCtx): ResolvedOptionValue | null {
  if (o.type === 'input' || o.type === 'hotkey') {
    const fields: Record<string, string> = {}
    let via = 'declared'
    for (const f of [...(o.inputs ?? []), ...(o.hotkeys ?? [])]) {
      if (f.default !== undefined) fields[f.name] = f.default
    }
    const pv = ctx.presetTask?.option?.[o.name]
    if (pv && typeof pv === 'object' && !Array.isArray(pv)) {
      for (const [k, v] of Object.entries(pv as Record<string, unknown>)) fields[k] = String(v)
      if (Object.keys(pv).length) via = 'preset'
    }
    const cli = ctx.optionFields?.[o.name]
    if (cli) {
      for (const [k, v] of Object.entries(cli)) fields[k] = v
      if (Object.keys(cli).length) via = 'cli'
    }
    return { kind: 'fields', fields, via }
  }
  const cli = ctx.optionCases?.[o.name]
  if (cli !== undefined) {
    return { kind: 'cases', cases: Array.isArray(cli) ? cli.map(String) : [String(cli)], via: 'cli' }
  }
  const pv = ctx.presetTask?.option?.[o.name]
  /* preset 里 input 的值是对象——这里只处理 case 型，对象值留给出上面的分支 */
  if (pv !== undefined && !(pv && typeof pv === 'object' && !Array.isArray(pv))) {
    return { kind: 'cases', cases: Array.isArray(pv) ? pv.map(String) : [String(pv)], via: 'preset' }
  }
  if (o.defaultCase !== undefined) {
    return {
      kind: 'cases',
      cases: Array.isArray(o.defaultCase) ? o.defaultCase.map(String) : [String(o.defaultCase)],
      via: 'default',
    }
  }
  return null
}

export function computePipelineOverride(input: OverrideInput): OverrideResult {
  const { loaded, controllerName, resourceName, taskName, presetName } = input
  const warns: string[] = []
  const applied: string[] = []
  /** 进过链的 option 键：用来抓"--option 给了值但没有任何级别引用它"这种静默失联 */
  const reached = new Set<string>()
  const layers: Record<string, unknown>[] = []
  const preset = presetName ? loaded.presets.find((p) => p.name === presetName) : undefined
  if (presetName && !preset) warns.push('preset ' + presetName + ' 不存在（可用：' + loaded.presets.map((p) => p.name).join(' / ') + '或无）')
  const presetTask = preset && taskName ? preset.task.find((t) => t.name === taskName) : undefined

  const applicable = (o: InterfaceOption): boolean => {
    if (o.controller?.length && controllerName && !o.controller.includes(controllerName)) return false
    if (o.resource?.length && resourceName && !o.resource.includes(resourceName)) return false
    return true
  }

  const valueCtx: OptionValueCtx = {
    ...(presetTask ? { presetTask } : {}),
    ...(input.optionCases ? { optionCases: input.optionCases } : {}),
    ...(input.optionFields ? { optionFields: input.optionFields } : {}),
  }

  /**
   * 把模板里的 `{字段名}` 换成取值：整串是占位时用转型后的值（int → 数字），
   * 出现在片段里时用它的文本形态（如 `MainChapter_{章节号}`）。
   * 有任何一个占位取不到值就整条模板放弃——写一半的 override 比不写更难查。
   */
  const substitute = (tpl: Record<string, unknown>, tokens: Record<string, unknown>): { value: Record<string, unknown>; missing: string[] } => {
    const missing: string[] = []
    const one = (name: string): unknown => {
      if (!(name in tokens)) {
        if (!missing.includes(name)) missing.push(name)
        return undefined
      }
      return tokens[name]
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
    return { value: walk(tpl) as Record<string, unknown>, missing }
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
      const resolved = resolveOptionValue(o, valueCtx)
      const fields = resolved && resolved.kind === 'fields' ? resolved.fields : {}
      const tokens: Record<string, unknown> = {}
      if (o.type === 'hotkey') {
        /* 占位符产出的是**当前控制器 type 的虚拟按键码整数**（Win32 VK / Android KeyEvent /
         * Carbon kVK / evdev）。没有表的控制器类型直接跳过并说明——按 Win32 猜等于写错键。 */
        const decl = controllerName ? loaded.controllers.find((x) => x.name === controllerName) : undefined
        const table = hotkeyTableFor(decl?.type ?? null, decl?.linux?.useWin32VkCode === true)
        if (!table) {
          warns.push(
            'option ' + name + '（' + level + '）是 hotkey：当前控制器' +
              (decl ? '类型 ' + decl.type + ' 没有键码映射表' : '未确定（没选中控制器）') +
              '，这一层覆盖已跳过',
          )
          return
        }
        for (const f of o.hotkeys ?? []) {
          const raw = fields[f.name]
          if (raw === undefined || raw === '') continue // 缺值交给下面的 missing 统一报
          const hk = resolveHotkeyTokens(f.name, raw, table)
          if (hk.error) {
            warns.push('option ' + name + '（' + level + '）的 hotkey 字段 ' + f.name + ' 解析失败：' + hk.error + '——整条覆盖已跳过')
            return
          }
          Object.assign(tokens, hk.tokens)
        }
      } else {
        const bad: string[] = []
        for (const [k, raw] of Object.entries(fields)) {
          const t = convert(raw, o.inputs?.find((f) => f.name === k)?.pipelineType)
          if (t === undefined) bad.push(k + '=' + raw)
          else tokens[k] = t
        }
        if (bad.length) {
          warns.push('option ' + name + '（' + level + '）的输入值按 pipeline_type 转不了型：' + bad.join(' / ') + '——整条覆盖已跳过')
          return
        }
      }
      const r = substitute(tpl, tokens)
      if (r.missing.length) {
        warns.push(
          'option ' + name + '（' + level + '）的 pipeline_override 模板里这些占位没有取值：' +
            r.missing.join(' / ') + '——整条覆盖已跳过（用 --option ' + name + '.<字段>=<值> 给值）',
        )
        return
      }
      layers.push(r.value)
      const shown = Object.entries(fields).map(([k, v]) => k + '=' + v).join('，')
      applied.push(name + '=（' + o.type + (shown ? '：' + shown : '') + '，' + level + '）')
      return
    }

    const v = resolveOptionValue(o, valueCtx)
    if (!v || v.kind !== 'cases') {
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
        layers.push(c.pipelineOverride)
        applied.push(name + '=' + cname + '（' + level + '，via ' + v.via + '）')
      }
      /* 嵌套子 option：父 case 生效后按声明顺序合并（更具体，晚于父级） */
      for (const child of c.option ?? []) mergeOption(child, level + ' > ' + name, [...chain, name])
    }
  }

  /* task 级覆盖是基底：协议只规定 option 四级顺序，没说它插在哪一级——这里按"先应用"处理。 */
  const taskDecl = taskName ? loaded.tasks.find((x) => x.name === taskName) : undefined
  if (taskDecl?.pipelineOverride && Object.keys(taskDecl.pipelineOverride).length) {
    layers.push(taskDecl.pipelineOverride)
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

  return { override: layers, warns, applied }
}
