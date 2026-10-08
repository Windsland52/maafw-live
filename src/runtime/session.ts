/**
 * 会话装配：一次性命令如何在同一个 daemon 里先连上设备、再干活、最后收尾。
 *
 * 为什么需要它：daemon 的连接是进程态——命令跑完进程就退出，连接随之消失。所以涉及设备的
 * 命令（screencap / frame / run / click…）必须能在同一次调用里先完成连接，否则它们只会在
 * REPL 里可用。传入 --project（推荐，走 interface.json 规划）或 --kind/--target（手动）
 * 即可；两者都不给时交给命令自己处理。
 */
import type { DaemonClient } from '../client/daemon.js'
import { loadInterface, resolveResourcePaths } from '../interface/index.js'
import { planProject, connect, type ProjectPlan } from './actions.js'

export interface SessionOptions {
  /** Maa 项目目录：按 interface.json 的 controller[] 规划连接 */
  project?: string
  /** 项目模式下指定控制器名 */
  controller?: string
  resource?: string
  /** 项目模式下的窗口 / adb 地址覆盖（持久化选择由面板负责，CLI 不做持久化） */
  hwnd?: string
  address?: string
  /** 手动路径 */
  kind?: string
  target?: string
  shortSide?: number
  longSide?: number
  rawSize?: boolean
}

export interface SessionState {
  connected: boolean
  plan?: ProjectPlan
  session?: Record<string, unknown> | null
  notes?: string[]
  /** 本次连接重建了控制器、因而停掉了上一轮的帧流（daemon 回执 streamStopped）：调用方要接着看帧就重开流 */
  streamStopped?: boolean
}

export class SessionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'SessionError'
  }
}

/** 需要设备时连一次；项目模式下先规划控制器再连（拒绝猜设备）。 */
export async function ensureSession(client: DaemonClient, o: SessionOptions): Promise<SessionState> {
  if (!o.project && !o.kind) return { connected: false }

  if (o.project) {
    const planned = await planProject(client, o.project, {
      controller: o.controller,
      hwnd: o.hwnd,
      address: o.address,
      resource: o.resource,
      manualTarget: o.target ?? undefined,
    })
    if (!planned.plan) throw new SessionError(planned.error ?? '控制器规划失败', 'PLAN_FAILED')
    if (!planned.plan.ok) {
      const cands = (planned.plan.candidates ?? []).map((d) => d.name || d.id).slice(0, 10)
      throw new SessionError(
        planned.plan.error + (cands.length ? '（候选：' + cands.join(' / ') + '）' : ''),
        planned.plan.code || 'PLAN_FAILED',
      )
    }
    const conn = await connect(client, { ...planned.plan.connect })
    if (conn && conn.ok === false) throw new SessionError(conn.error ?? '连接失败', 'CONNECT_FAILED')
    return {
      connected: true, plan: planned, session: conn.session ?? null, notes: planned.plan.notes,
      ...(conn.streamStopped === true ? { streamStopped: true } : {}),
    }
  }

  const conn = await connect(client, {
    kind: o.kind,
    ...(o.target ? { target: o.target } : {}),
    ...(o.shortSide ? { shortSide: o.shortSide } : {}),
    ...(o.longSide ? { longSide: o.longSide } : {}),
    ...(o.rawSize ? { rawSize: true } : {}),
  })
  if (conn && conn.ok === false) throw new SessionError(conn.error ?? '连接失败', 'CONNECT_FAILED')
  return {
    connected: true, session: conn.session ?? null,
    ...(conn.streamStopped === true ? { streamStopped: true } : {}),
  }
}

/**
 * 离线资源解析：只读 interface.json 拿资源目录，不扫设备、不连接。
 *
 * 为什么需要它：从关键帧库留存帧裁模板这条动线**不需要设备**（这正是"不可复现状态"的意义——
 * 设备早已不在那个画面上）。但自匹配要加载资源，而资源声明在项目里。项目此刻只是资源的
 * 来源，不是连接的对象，所以走 interface 的规划函数而不走 planProject（后者要扫设备）。
 */
export function offlineResource(
  project: string,
  controller?: string,
  resource?: string,
): { paths: string[]; controllerName: string | null; error?: string } {
  const loaded = loadInterface(project)
  if (!loaded.file) {
    return { paths: [], controllerName: null, error: loaded.problems[0]?.message ?? '未找到 interface.json' }
  }
  const controllerName = controller ?? loaded.controllers[0]?.name ?? null
  const plan = resolveResourcePaths(loaded, controllerName ?? undefined, resource)
  return { paths: plan.paths, controllerName }
}

/** 连接结果的行渲染（human 输出与 --json 共用一份事实）。 */export function describeSession(s: SessionState): string[] {
  const lines: string[] = []
  if (!s.connected) return lines
  const sess = s.session ?? {}
  lines.push(
    '已连接：' + String(sess.kind ?? '?') + ' ' + String(sess.target ?? '') +
      (sess.name ? ' (' + String(sess.name) + ')' : ''),
  )
  const res = sess.resolution as { w?: number; h?: number } | null | undefined
  if (res && res.w) lines.push('  分辨率：' + res.w + 'x' + res.h)
  if (s.plan) {
    lines.push('  控制器：' + s.plan.controllerName + '（来自 interface.json）')
    if (s.plan.resource?.paths.length) lines.push('  资源：' + s.plan.resource.paths.join(' , '))
  }
  for (const n of s.notes ?? []) lines.push('  note: ' + n)
  return lines
}
