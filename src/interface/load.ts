/**
 * 载入项目 interface.json（ProjectInterface v2）。
 *
 * 只做本工具需要的窄解析：控制器声明（连接规划用）、资源声明（路径解析用）、任务入口
 * （run --project 用）。其余字段（task 参数、option、i18n 等）不属于 CLI 的职责，原样忽略。
 * 全过程不抛异常：问题进 problems[]，由调用方决定怎么呈现。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseJsonc } from './jsonc.js'

export interface InterfaceProblem {
  message: string
}

/** 控制器的显示声明；映射为 daemon connect 的 shortSide / longSide / rawSize。 */
export interface DisplayDecl {
  shortSide?: number
  longSide?: number
  raw?: boolean
  expand?: [number, number]
}

export interface Win32Decl {
  classRegex?: string
  windowRegex?: string
  screencap?: string
  mouse?: string
  keyboard?: string
}

export interface GamepadDecl {
  classRegex?: string
  windowRegex?: string
  gamepadType?: string
  screencap?: string
}

export interface InterfaceController {
  name: string
  /** Adb / Win32 / Gamepad / MacOS / PlayCover / Linux */
  type: string
  display?: DisplayDecl
  win32?: Win32Decl
  gamepad?: GamepadDecl
  /** v2.2.0：在 resource.path 之后追加加载的资源目录（相对 interface.json 所在目录） */
  attachResourcePath: string[]
  /** v2.3.0：控制器级配置项名单（override 链第三级） */
  option?: string[]
}

export interface InterfaceResource {
  name: string
  /** 资源根目录（含 pipeline / image / model），相对 interface.json 所在目录，声明顺序即加载顺序 */
  paths: string[]
  /** 只对这些控制器生效；空数组 = 全部 */
  controllers: string[]
  /** v2.3.0：资源级配置项名单（override 链第二级） */
  option?: string[]
}

export interface InterfaceTask {
  name: string
  /** pipeline 入口节点名；缺省时入口即任务名 */
  entry?: string
  /** 只在这些控制器下可用（隐藏/禁用语义）；空 = 全部 */
  controller?: string[]
  /** 只在这些资源下可用；空 = 全部 */
  resource?: string[]
  /** 配置项键名（按展示顺序）；对应 InterfaceOption 字典的键 */
  option?: string[]
}

/** option 字典条目：switch/select/checkbox 的 case 携带 pipeline_override。 */
export interface OptionCase {
  name: string
  pipelineOverride?: Record<string, unknown>
  /** 选中该 case 后生效的子配置项 */
  option?: string[]
}

export interface InterfaceOption {
  name: string
  type: string
  cases: OptionCase[]
  /** 初始选中：switch/select 单 case 名；checkbox 为 case 名数组 */
  defaultCase?: string | string[]
  /** 适用性过滤（v2.3.1：不满足的 option 不得产生 pipeline_override） */
  controller?: string[]
  resource?: string[]
}

/** preset：任务与 option 取值的快照（v2.3.0），应用时覆盖 default_case。 */
export interface InterfacePreset {
  name: string
  task: Array<{ name: string; enabled?: boolean; option?: Record<string, unknown> }>
}

/** PI `agent` 声明：宿主侧子进程（如 uv run python agent/main.py），经 agent 协议注册 custom
 * action / recognition。maa-node 绑定未暴露 AgentClient 桥接——本工具只能诊断，不能 spawn。 */
export interface InterfaceAgent {
  exec: string
  args: string[]
}

export interface LoadedInterface {
  /** interface.json 绝对路径；未找到为 null */
  file: string | null
  /** 所在目录——resource.path 与 attach_resource_path 的相对基准 */
  dir: string | null
  version: number | null
  name: string | null
  controllers: InterfaceController[]
  resources: InterfaceResource[]
  tasks: InterfaceTask[]
  /** option 字典（主文件 + import 合并，后导入覆盖同名） */
  options: Record<string, InterfaceOption>
  presets: InterfacePreset[]
  /** 全局配置项键名（override 链最低级） */
  globalOption: string[]
  /** controller 启动前任务；CLI 不执行，仅用于警告 */
  pretask: Array<{ name?: string; exec?: string }>
  /** agent 子进程声明；CLI 未桥接（绑定无 AgentClient），仅用于警告与失败归因 */
  agents: InterfaceAgent[]
  problems: InterfaceProblem[]
}

/** 找 interface.json：项目根优先，其次 assets/（部分项目把声明放资源目录下）。 */
const REL_CANDIDATES = ['interface.json', 'assets/interface.json']

export function findInterfaceFile(dir: string): string | null {
  const base = resolve(dir)
  for (const rel of REL_CANDIDATES) {
    const p = join(base, rel)
    if (existsSync(p)) return p
  }
  return null
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function strList(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.length > 0)
  return []
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

export function loadInterface(dir: string): LoadedInterface {
  const file = findInterfaceFile(dir)
  const base: LoadedInterface = {
    file,
    dir: file ? dirname(file) : null,
    version: null,
    name: null,
    controllers: [],
    resources: [],
    tasks: [],
    options: {},
    presets: [],
    globalOption: [],
    pretask: [],
    agents: [],
    problems: [],
  }
  if (!file) {
    return { ...base, problems: [{ message: '未找到 interface.json（找过 ' + REL_CANDIDATES.join(' / ') + '）' }] }
  }

  let raw: unknown
  try {
    raw = parseJsonc(readFileSync(file, 'utf8'))
  } catch (e) {
    return { ...base, problems: [{ message: 'interface.json 解析失败：' + String((e as Error).message) }] }
  }
  const o = obj(raw)
  if (!o) return { ...base, problems: [{ message: 'interface.json 顶层必须是对象' }] }

  const problems: InterfaceProblem[] = []
  const version = num(o.interface_version)
  if (version === undefined) problems.push({ message: '缺少 interface_version（ProjectInterface v2 应为 2）' })
  else if (version !== 2) problems.push({ message: 'interface_version=' + version + '；本工具按 v2 解析，可能有出入' })

  const controllers: InterfaceController[] = []
  for (const item of Array.isArray(o.controller) ? o.controller : []) {
    const c = obj(item)
    const name = c ? str(c.name) : undefined
    const type = c ? str(c.type) : undefined
    if (!c || !name || !type) {
      problems.push({ message: 'controller 项缺少 name 或 type，已跳过' })
      continue
    }
    const display: DisplayDecl = {}
    const ss = num(c.display_short_side)
    if (ss !== undefined) display.shortSide = ss
    const ls = num(c.display_long_side)
    if (ls !== undefined) display.longSide = ls
    if (c.display_raw === true) display.raw = true
    if (Array.isArray(c.display_expand) && c.display_expand.length === 2) {
      const a = num(c.display_expand[0])
      const b = num(c.display_expand[1])
      if (a !== undefined && b !== undefined) display.expand = [a, b]
    }
    const w = obj(c.win32)
    const g = obj(c.gamepad)
    controllers.push({
      name,
      type,
      display: Object.keys(display).length ? display : undefined,
      win32: w
        ? {
            classRegex: str(w.class_regex),
            windowRegex: str(w.window_regex),
            screencap: str(w.screencap),
            mouse: str(w.mouse),
            keyboard: str(w.keyboard),
          }
        : undefined,
      gamepad: g
        ? {
            classRegex: str(g.class_regex),
            windowRegex: str(g.window_regex),
            gamepadType: str(g.gamepad_type),
            screencap: str(g.screencap),
          }
        : undefined,
      attachResourcePath: strList(c.attach_resource_path),
      option: strList(c.option),
    })
  }
  if (!controllers.length) problems.push({ message: 'controller[] 为空：项目没有声明任何控制器' })

  const resources: InterfaceResource[] = []
  for (const item of Array.isArray(o.resource) ? o.resource : []) {
    const r = obj(item)
    const name = r ? str(r.name) : undefined
    const paths = r ? strList(r.path) : []
    if (!r || !name || !paths.length) {
      problems.push({ message: 'resource 项缺少 name 或 path，已跳过' })
      continue
    }
    resources.push({ name, paths, controllers: strList(r.controller), option: strList(r.option) })
  }

  const tasks: InterfaceTask[] = []
  const options: Record<string, InterfaceOption> = {}
  const presets: InterfacePreset[] = []
  const globalOption: string[] = []
  const pretask: Array<{ name?: string; exec?: string }> = []
  const agents: InterfaceAgent[] = []

  const readAgents = (list: unknown): void => {
    for (const item of Array.isArray(list) ? list : (list !== undefined ? [list] : [])) {
      const a = obj(item)
      const exec = a ? str(a.child_exec) : undefined
      if (!a || !exec) continue
      agents.push({ exec, args: strList(a.child_args) })
    }
  }

  const readTasks = (list: unknown, src: string): void => {
    for (const item of Array.isArray(list) ? list : []) {
      const t = obj(item)
      const name = t ? str(t.name) : undefined
      if (!t || !name) {
        problems.push({ message: 'task 项缺少 name，已跳过（' + src + '）' })
        continue
      }
      tasks.push({
        name,
        entry: str(t.entry),
        controller: strList(t.controller),
        resource: strList(t.resource),
        option: strList(t.option),
      })
    }
  }
  const readOptions = (dict: unknown, src: string): void => {
    const d = obj(dict)
    if (!d) {
      if (dict !== undefined) problems.push({ message: 'option 应为对象（键=配置项名），已忽略（' + src + '）' })
      return
    }
    for (const [key, val] of Object.entries(d)) {
      const v = obj(val)
      if (!v || !str(v.type)) {
        problems.push({ message: 'option ' + key + ' 缺少 type，已跳过（' + src + '）' })
        continue
      }
      const cases: OptionCase[] = []
      for (const cs of Array.isArray(v.cases) ? v.cases : []) {
        const c2 = obj(cs)
        const cname = c2 ? str(c2.name) : undefined
        if (!c2 || !cname) continue
        const po = obj(c2.pipeline_override)
        cases.push({
          name: cname,
          ...(po ? { pipelineOverride: po } : {}),
          option: strList(c2.option),
        })
      }
      options[key] = {
        name: key,
        type: String(v.type),
        cases,
        ...(v.default_case !== undefined ? { defaultCase: v.default_case as string | string[] } : {}),
        controller: strList(v.controller),
        resource: strList(v.resource),
      }
    }
  }
  const readPresets = (list: unknown): void => {
    for (const item of Array.isArray(list) ? list : []) {
      const p = obj(item)
      const name = p ? str(p.name) : undefined
      if (!p || !name) continue
      const tlist: InterfacePreset['task'] = []
      for (const tp of Array.isArray(p.task) ? p.task : []) {
        const t2 = obj(tp)
        const tname = t2 ? str(t2.name) : undefined
        if (!t2 || !tname) continue
        const pv = obj(t2.option)
        tlist.push({ name: tname, enabled: t2.enabled !== false, ...(pv ? { option: pv } : {}) })
      }
      presets.push({ name, task: tlist })
    }
  }

  readTasks(o.task, '主文件')
  readOptions(o.option, '主文件')
  readPresets(o.preset)
  readAgents(o.agent)
  for (const g of strList(o.global_option)) if (!globalOption.includes(g)) globalOption.push(g)
  const mainPretasks = Array.isArray(o.pretask) ? o.pretask : (o.pretask !== undefined ? [o.pretask] : [])
  for (const pt of mainPretasks) {
    const p2 = obj(pt)
    if (p2) pretask.push({ name: str(p2.name), exec: str(p2.exec) })
  }

  /* import 合并（v2.2.0）：只合 task/option/preset/global_option/pretask（及 group/setting，本工具不消费）。
   * controller/resource 不可导入——子文件声明了也忽略并记 problems。循环导入用 visited 集合挡住。
   *
   * 上游口径（MaaFW 5.14.2 @ 8061d5b，逐条核过）：
   *  - 被 import 的文件由 tools/interface_import.schema.json 约束（描述原文："用于 interface.json 的
   *    import 字段引用的文件"），顶层只有 task/option/pretask/global_option/setting/preset，且
   *    `additionalProperties: false` → **`import` 不可嵌套**、`agent` 也不在其中；
   *  - 协议文档 3.3 的 import 节把 `group` 列进可导入字段（v2.4.0，合并表里也有 group 行），
   *    而 5.14.2 的 import schema 顶层**没有 group** → 文档与 schema 不一致（上游漂移）。
   *    **后续：上游已就这条提 PR，结论是"改 schema"**（即 import 文件将来可以合法带 group）。
   *    我们的行为不变——group 本工具不消费，因此既不合并也不报错；真要用到 UI 分组时再说。
   *  - `agent` 不在 import schema 里，但本工具**宽容读取**（下面的 readAgents）：这是超出协议的扩展，
   *    只影响"文件结构校验收紧的工具"与我们的行为差异，实现上进 candidates 前仍会如实报 problems。 */
  const seen = new Set([file])
  const imports = strList(o.import)
  for (const rel of imports) {
    const childFile = join(dirname(file), rel)
    if (seen.has(childFile)) {
      problems.push({ message: 'import 循环引用，已跳过：' + rel })
      continue
    }
    seen.add(childFile)
    let child: Record<string, unknown> | null = null
    try {
      child = obj(parseJsonc(readFileSync(childFile, 'utf8')))
    } catch (e) {
      problems.push({ message: 'import 文件读取/解析失败：' + rel + '（' + String((e as Error).message) + '）' })
      continue
    }
    if (!child) continue
    if (child.controller !== undefined || child.resource !== undefined) {
      problems.push({ message: 'import 文件 ' + rel + ' 声明了 controller/resource：协议不可导入，已忽略' })
    }
    /* import 不可嵌套：被引用的文件由 interface_import.schema.json 约束（MaaFW 5.14.2，
     * 顶层只有 task/option/pretask/global_option/setting/preset 且 additionalProperties: false，
     * 文档 3.3 的 import 节也没有嵌套写法）。静默吞掉会让"二级文件"整份消失得无影无踪，
     * 所以这里记一条 problem——它通常意味着拆分方式需要改成平铺。 */
    if (child.import !== undefined) {
      problems.push({ message: 'import 文件 ' + rel + ' 里还有 import：import 不可嵌套（该文件的 schema 顶层没有 import 字段），其引用的文件已忽略' })
    }
    readTasks(child.task, rel)
    readOptions(child.option, rel)
    readPresets(child.preset)
    readAgents(child.agent)
    for (const g of strList(child.global_option)) if (!globalOption.includes(g)) globalOption.push(g)
    for (const pt of Array.isArray(child.pretask) ? child.pretask : []) {
      const p2 = obj(pt)
      if (p2) pretask.push({ name: str(p2.name), exec: str(p2.exec) })
    }
  }

  return {
    ...base,
    version: version ?? null,
    name: str(o.name) ?? null,
    controllers,
    resources,
    tasks,
    options,
    presets,
    globalOption,
    pretask,
    agents,
    problems,
  }
}
