/**
 * 项目驱动的连接规划：把 interface.json 的控制器声明与枚举到的设备对上，
 * 产出 daemon `connect` 的参数；对不上时给出候选与可操作的原因。
 *
 * 为什么不猜设备：猜错不只是连错窗口，还会把 roi 与模板的坐标系一起猜错。
 */
import { resolve } from 'node:path'
import type { LoadedInterface } from './load.js'

/** daemon device_list 的条目：adb 的 id 是 address，win32 的 id 是 hwnd。 */
export interface DeviceLike {
  kind?: string
  id?: string
  name?: string
  cls?: string
}

export interface PlanOverrides {
  controller?: string
  win32?: { hwnd?: string | null }
  gamepad?: { hwnd?: string | null }
  adb?: { address?: string | null }
}

export interface ControllerPlan {
  ok: boolean
  code?: string
  error?: string
  controllerName: string | null
  /** 直接展开给 daemon 的 connect 参数 */
  connect: Record<string, unknown>
  /** 失败时的候选设备，供调用方提示用户显式指定 */
  candidates?: DeviceLike[]
  notes?: string[]
}

export interface ResourcePlan {
  paths: string[]
  names: string[]
}

const KIND_BY_TYPE: Record<string, string> = { Adb: 'adb', Win32: 'win32', Gamepad: 'gamepad' }

function safeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

function fail(
  c: { name: string },
  code: string,
  error: string,
  candidates: DeviceLike[],
  connect: Record<string, unknown>,
  notes: string[],
): ControllerPlan {
  return { ok: false, code, error, controllerName: c.name, connect, candidates, notes }
}

export function planController(
  loaded: LoadedInterface,
  overrides: PlanOverrides,
  devices: DeviceLike[],
): ControllerPlan {
  const wanted = overrides.controller
  const c = wanted ? loaded.controllers.find((x) => x.name === wanted) : loaded.controllers[0]
  if (!c) {
    const names = loaded.controllers.map((x) => x.name).join(' / ')
    return {
      ok: false,
      code: wanted ? 'CONTROLLER_NOT_FOUND' : 'NO_CONTROLLER',
      controllerName: null,
      connect: {},
      candidates: [],
      error: wanted
        ? 'interface.json 里没有控制器 ' + wanted + (names ? '（可用：' + names + '）' : '')
        : 'interface.json 没有声明任何控制器',
    }
  }
  const kind = KIND_BY_TYPE[c.type]
  if (!kind) {
    return {
      ok: false,
      code: 'CONTROLLER_UNSUPPORTED',
      controllerName: c.name,
      connect: {},
      candidates: [],
      error: '控制器 ' + c.name + ' 的类型 ' + c.type + ' 暂不受支持（本 CLI 支持 Adb / Win32 / Gamepad）',
    }
  }

  const notes: string[] = ['控制器 ' + c.name + '（来自 interface.json）']
  const connect: Record<string, unknown> = { kind }
  if (c.display?.shortSide !== undefined) connect.shortSide = c.display.shortSide
  if (c.display?.longSide !== undefined) connect.longSide = c.display.longSide
  if (c.display?.raw) connect.rawSize = true
  if (c.display?.expand) notes.push('display_expand 暂不生效（daemon 未接入），已忽略')

  if (kind === 'adb') {
    const addr = overrides.adb?.address ?? null
    let hit: DeviceLike | undefined
    if (addr) hit = devices.find((d) => String(d.id ?? '') === addr)
    if (addr && !hit) {
      return fail(c, 'DEVICE_NOT_FOUND', 'adb 地址 ' + addr + ' 不在已发现设备中（共 ' + devices.length + ' 台）', devices, connect, notes)
    }
    if (!hit && devices.length === 0) {
      return fail(c, 'NO_DEVICES', '没有发现 adb 设备（检查 adb 连接与模拟器）', [], connect, notes)
    }
    if (!hit && devices.length === 1) hit = devices[0]
    if (!hit) {
      return fail(c, 'DEVICE_AMBIGUOUS', '发现 ' + devices.length + ' 台 adb 设备，请用 --address 显式指定', devices, connect, notes)
    }
    connect.target = String(hit.id ?? '')
    notes.push('设备：' + (hit.name || hit.id || '?'))
    return { ok: true, controllerName: c.name, connect, notes }
  }

  /* Win32 / Gamepad：窗口类名与标题正则两条都生效（与本体 boost::regex_search 语义一致）。 */
  const decl: {
    classRegex?: string
    windowRegex?: string
    screencap?: string
    mouse?: string
    keyboard?: string
    gamepadType?: string
  } = kind === 'gamepad' ? { ...(c.gamepad ?? {}) } : { ...(c.win32 ?? {}) }
  const hwnd = (kind === 'gamepad' ? overrides.gamepad?.hwnd : overrides.win32?.hwnd) ?? null

  let hit: DeviceLike | undefined
  if (hwnd) {
    hit =
      devices.find((d) => String(d.id ?? '') === hwnd) ??
      devices.find((d) => String(d.name ?? '').includes(hwnd) || String(d.cls ?? '').includes(hwnd))
    if (!hit) {
      return fail(c, 'WINDOW_NOT_FOUND', '窗口未找到：' + hwnd + '（hwnd 变了或窗口已关闭）', devices, connect, notes)
    }
  } else {
    const clsRe = decl.classRegex ? safeRegExp(decl.classRegex) : null
    const winRe = decl.windowRegex ? safeRegExp(decl.windowRegex) : null
    if (decl.classRegex && !clsRe) notes.push('class_regex 不是合法正则，已忽略：' + decl.classRegex)
    if (decl.windowRegex && !winRe) notes.push('window_regex 不是合法正则，已忽略：' + decl.windowRegex)
    if (clsRe || winRe) {
      const matched = devices.filter(
        (d) => (!clsRe || clsRe.test(String(d.cls ?? ''))) && (!winRe || winRe.test(String(d.name ?? ''))),
      )
      if (matched.length === 1) hit = matched[0]
      else if (matched.length === 0) {
        const cond = [
          decl.classRegex && 'class~' + decl.classRegex,
          decl.windowRegex && 'title~' + decl.windowRegex,
        ]
          .filter(Boolean)
          .join(' + ')
        return fail(c, 'WINDOW_NOT_FOUND', '没有窗口同时匹配 ' + cond + '（当前 ' + devices.length + ' 个窗口）', devices, connect, notes)
      } else {
        return fail(c, 'WINDOW_AMBIGUOUS', '有 ' + matched.length + ' 个窗口匹配，请用 --hwnd 显式指定', matched, connect, notes)
      }
    } else if (devices.length === 1) {
      hit = devices[0]
      notes.push('控制器未声明窗口匹配规则，使用唯一窗口')
    } else {
      return fail(c, 'WINDOW_AMBIGUOUS', '控制器未声明窗口匹配规则，且当前有 ' + devices.length + ' 个窗口，请用 --hwnd 指定', devices, connect, notes)
    }
  }

  connect.target = String(hit.id ?? '')
  if (decl.screencap) connect.screencap = decl.screencap
  if (kind === 'win32') {
    if (decl.mouse) connect.mouse = decl.mouse
    if (decl.keyboard) connect.keyboard = decl.keyboard
  } else if (decl.gamepadType) {
    connect.gamepadType = decl.gamepadType
  }
  notes.push('窗口：' + (hit.name || hit.cls || hit.id || '?'))
  return { ok: true, controllerName: c.name, connect, notes }
}

/**
 * 解析资源路径：声明目录相对 interface.json、按声明顺序叠加（后者覆盖前者），
 * 只取适用于所选控制器的条目；attach_resource_path 在选中控制器后追加。
 * override（--resource）直接替换整组。
 */
export function resolveResourcePaths(
  loaded: LoadedInterface,
  controllerName?: string,
  override?: string,
): ResourcePlan {
  if (override) return { paths: [resolve(override)], names: ['(--resource)'] }
  const dir = loaded.dir
  if (!dir) return { paths: [], names: [] }

  const paths: string[] = []
  const names: string[] = []
  for (const r of loaded.resources) {
    if (controllerName && r.controllers.length && !r.controllers.includes(controllerName)) continue
    for (const p of r.paths) paths.push(resolve(dir, p))
    names.push(r.name)
  }
  if (controllerName) {
    const c = loaded.controllers.find((x) => x.name === controllerName)
    for (const p of c?.attachResourcePath ?? []) paths.push(resolve(dir, p))
  }
  return { paths: [...new Set(paths)], names }
}
