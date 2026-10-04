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
}

export interface InterfaceResource {
  name: string
  /** 资源根目录（含 pipeline / image / model），相对 interface.json 所在目录，声明顺序即加载顺序 */
  paths: string[]
  /** 只对这些控制器生效；空数组 = 全部 */
  controllers: string[]
}

export interface InterfaceTask {
  name: string
  /** pipeline 入口节点名；缺省时入口即任务名 */
  entry?: string
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
    resources.push({ name, paths, controllers: strList(r.controller) })
  }

  const tasks: InterfaceTask[] = []
  for (const item of Array.isArray(o.task) ? o.task : []) {
    const t = obj(item)
    const name = t ? str(t.name) : undefined
    if (!t || !name) {
      problems.push({ message: 'task 项缺少 name，已跳过' })
      continue
    }
    tasks.push({ name, entry: str(t.entry) })
  }

  return {
    ...base,
    version: version ?? null,
    name: str(o.name) ?? null,
    controllers,
    resources,
    tasks,
    problems,
  }
}
