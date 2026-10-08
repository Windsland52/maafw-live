/**
 * MaaFramework 设备 daemon 的客户端（本仓库唯一实现）。
 *
 * daemon 是 `daemon/framed.mjs`：一个独立子进程，经 stdin/stdout 说 JSON 行协议，持有
 * Controller / Resource / Tasker、帧流与环形缓冲。本模块负责 spawn、请求应答配对、超时硬杀
 * 自愈、原生 stderr 日志环、以及帧/事件汇聚——CLI 命令、`maafw-live repl`、宿主插件与任何 headless
 * harness 都用它，避免每个消费者各写一遍同一套管道。
 *
 * 两条不变量：
 *  - 一个 DaemonClient = 一个 daemon 子进程 = 一个设备会话（同一台设备同一时刻只能有一个）。
 *  - 调用超时即认为 daemon 卡死（maa-node 的 wait() 可能同步阻塞 worker），kill 后下次调用自动重生。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

/** 帧元数据（像素默认不出 daemon；预览帧落盘后给路径）。 */
export interface FrameMeta {
  seq: number
  t: number
  diff?: number
  w?: number
  h?: number
  preview?: string
}

/** 帧流事件：画面变化/稳定，以及 Tasker 的节点级消息（按帧序对齐）。 */
export interface StreamEvent {
  type: string
  seq?: number
  t: number
  diff?: number
  node?: string | null
  msg?: string
  id?: number | string | null
}

export interface DaemonEvents {
  frames: FrameMeta[]
  events: StreamEvent[]
  /** 流级异常与通知：`stream_error`（设备掉线等）与 `stream_stopped`（控制器销毁导致流被停） */
  errors: string[]
  logs: string[]
  /** 最新预览帧路径（daemon 收到 init 的 runDir 后写入 runDir/preview.png） */
  preview: string | null
}

/**
 * daemon 推送的消息种类。`subscribe` 的回调按种类拿不同载荷：
 * `frame` → FrameMeta、`event` → StreamEvent、`stream_error` → 错误文本、`stream_stopped` → 停流原因。
 */
export type DaemonMessageKind = 'frame' | 'event' | 'stream_error' | 'stream_stopped'

/** `init` 的回执：daemon 身份与落点（客户端 spawn 后立刻握手的那一次）。 */
export interface DaemonInit {
  previewPath: string | null
  daemonId: string
  framesDir: string
  kfQuota: number
}

/**
 * 握手结果。**失败不抛异常**：老实现用 `id:-1` 发出去就不管，回执在分发链里被丢弃，
 * init 失败无从得知；现在如实回报，同时不把"daemon 不回 init"变成调用方的致命错误
 * （协议要求每条请求都有应答，但客户端不该因为对方没回一条就全盘不进）。
 */
export type DaemonInitResult = { ok: true; data: DaemonInit } | { ok: false; error: string }

export interface DaemonClient {
  readonly events: DaemonEvents
  /** spawn 后那次 `init` 握手的回执（framesDir / daemonId / kfQuota）；需要时才会 spawn daemon。 */
  init(): Promise<DaemonInitResult>
  /** 发一条命令并等应答；超时会硬杀 daemon（下次调用自动重生）。 */
  call<T = unknown>(cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>
  /** daemon stderr + 非 JSON stdout 行（maa 原生日志，识别失败根因常在这）。 */
  logTail(n?: number): string[]
  /** 订阅帧/事件/流错误/流停止；返回退订函数。 */
  subscribe(kind: DaemonMessageKind, cb: (message: unknown) => void): () => void
  stats(): { calls: number; restarts: number; alive: boolean; pid: number | null; daemonPath: string }
  /** 停流 + 断开 + 结束子进程。 */
  close(): void
}

export interface SpawnOptions {
  /** 预览帧与临时产物的目录；默认 ~/.maafw-live */
  runDir?: string
  /** 显式 daemon 路径；默认包内 lib/daemon/framed.mjs，可用 MAA_DAEMON 覆盖 */
  daemonPath?: string
  /** 默认调用超时 */
  timeoutMs?: number
  /** 关键帧库磁盘配额（字节，>0 生效；缺省 1GiB，daemon 侧 env MAAFW_KF_QUOTA_BYTES 亦可覆盖） */
  kfQuotaBytes?: number
}

const CAP = { frames: 2000, events: 2000, logs: 400 }
const DEFAULT_TIMEOUT = 30000

export function defaultRunDir(): string {
  return join(homedir(), '.maafw-live')
}

/** 定位 daemon 脚本：显式参数 → MAA_DAEMON → 包内 lib/daemon/framed.mjs。 */
export function resolveDaemonPath(explicit?: string): string {
  const candidates = [explicit, process.env.MAA_DAEMON, fileURLToPath(new URL('../daemon/framed.mjs', import.meta.url))]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  throw new Error('找不到 daemon 脚本，候选：' + candidates.filter(Boolean).join(' | '))
}

function push<T>(list: T[], item: T, cap: number): void {
  list.push(item)
  if (list.length > cap) list.splice(0, list.length - cap)
}

/** 错误对象 → 一行文本（抛出来的形态不可控：Error、字符串、别的什么都有可能） */
const message = (e: unknown): string => String((e as Error)?.message ?? e)

export function spawnDaemon(options: SpawnOptions = {}): DaemonClient {
  const daemonPath = resolveDaemonPath(options.daemonPath)
  const runDir = options.runDir ?? defaultRunDir()
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT
  const kfQuotaBytes = options.kfQuotaBytes

  const events: DaemonEvents = { frames: [], events: [], errors: [], logs: [], preview: null }
  const listeners = new Map<DaemonMessageKind, Set<(m: unknown) => void>>()
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  let child: ChildProcess | null = null
  let exited = false
  let reqId = 0
  let calls = 0
  let restarts = 0
  /** 当前这次 spawn 的 init 握手（daemon 重启会换新的一条） */
  let initResult: Promise<DaemonInitResult> | null = null

  const emit = (kind: DaemonMessageKind, message: unknown): void => {
    for (const cb of listeners.get(kind) ?? []) {
      try { cb(message) } catch { /* 订阅者的异常不能拖垮客户端 */ }
    }
  }

  const wire = (c: ChildProcess): void => {
    const rl = readline.createInterface({ input: c.stdout!, crlfDelay: Infinity })
    rl.on('line', (line: string) => {
      let m: Record<string, unknown>
      try {
        m = JSON.parse(line) as Record<string, unknown>
      } catch {
        /* 非 JSON 行 = maa 原生日志 */
        push(events.logs, line, CAP.logs)
        return
      }
      const kind = String(m.kind ?? '')
      if (kind === 'reply') {
        const id = Number(m.id)
        const p = pending.get(id)
        if (!p) return
        pending.delete(id)
        clearTimeout(p.timer)
        if (m.ok === false) p.reject(new Error(String(m.error ?? 'daemon error')))
        else p.resolve(m.data)
      } else if (kind === 'frame') {
        const meta = m.meta as FrameMeta
        push(events.frames, meta, CAP.frames)
        if (typeof m.preview === 'string') events.preview = m.preview
        else if (meta && typeof meta.preview === 'string') events.preview = meta.preview
        emit('frame', meta)
      } else if (kind === 'event') {
        const ev = m.ev as StreamEvent
        push(events.events, ev, CAP.events)
        emit('event', ev)
      } else if (kind === 'stream_error') {
        push(events.errors, String(m.error ?? ''), CAP.logs)
        emit('stream_error', m.error)
      } else if (kind === 'stream_stopped') {
        /* daemon 在控制器被销毁（connect 会重建）时主动停流并推这条：它是"你盯着的流没了"的通知，
         * 必须进错误环 + 推给订阅者。曾经只发了不收，调用方只能从 connect 回执间接推断。 */
        push(events.errors, '帧流已停止：' + String(m.reason ?? ''), CAP.logs)
        emit('stream_stopped', m.reason)
      }
    })
    c.stderr?.on('data', (d: Buffer) => push(events.logs, String(d), CAP.logs))
    c.on('error', (e: Error) => push(events.errors, 'child error: ' + e.message, CAP.logs))
    c.on('exit', (code: number | null) => {
      exited = true
      for (const [, p] of pending) {
        clearTimeout(p.timer)
        p.reject(new Error('daemon 已退出 (code=' + code + ')，会话失效，请重新 connect'))
      }
      pending.clear()
    })
  }

  /**
   * spawn 后立刻发 init 并等回执：daemon 身份与落点是宿主真需要的东西（面板要 framesDir、
   * 配额要 kfQuota 才能提前提示），而失败也必须可见——旧实现用 id=-1 发了就不管，
   * 回执被分发链当"未知 id"丢弃，init 失败（比如 runDir 建不出来）完全无从得知。
   * 与 `call` 共用同一条 stdin 管道，所以 init 一定排在后续请求之前。
   */
  const handshake = (c: ChildProcess): Promise<DaemonInitResult> =>
    new Promise<DaemonInitResult>((resolve) => {
      const id = ++reqId
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ ok: false, error: 'init 无应答（' + defaultTimeout + 'ms）：对方可能不是本协议的实现' })
      }, defaultTimeout)
      pending.set(id, {
        resolve: (d) => resolve({ ok: true, data: d as DaemonInit }),
        reject: (e) => resolve({ ok: false, error: e.message }),
        timer,
      })
      try {
        c.stdin!.write(JSON.stringify({ id, cmd: 'init', runDir, ...(kfQuotaBytes ? { kfQuotaBytes } : {}) }) + '\n')
      } catch (e) {
        /* spawn 到写入之间子进程就死了 → write 同步抛（EPIPE）。这条也要落到 {ok:false}，
         * 否则 init() 会 reject，而它的契约是"失败如实回报，不抛"。 */
        clearTimeout(timer)
        pending.delete(id)
        resolve({ ok: false, error: 'init 发送失败：' + message(e) })
      }
    })

  const ensure = (): ChildProcess => {
    if (child && !exited) return child
    if (child) restarts += 1
    child = spawn(process.execPath, [daemonPath, '--child'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    exited = false
    wire(child)
    initResult = handshake(child).then((r) => {
      if (!r.ok) push(events.errors, 'init 失败：' + r.error, CAP.logs)
      return r
    })
    return child
  }

  const kill = (): void => {
    if (!child) return
    try { child.kill() } catch { /* ignore */ }
  }

  const call = <T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = defaultTimeout): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let c: ChildProcess
      try {
        c = ensure()
      } catch (e) {
        reject(e as Error)
        return
      }
      const id = ++reqId
      calls += 1
      const timer = setTimeout(() => {
        pending.delete(id)
        /* 卡死自愈：maa-node 的 wait() 可能同步阻塞 daemon，超时即硬杀，下次调用自动重生 */
        kill()
        reject(new Error('daemon 调用超时：' + cmd + '（' + timeoutMs + 'ms 无应答，已重启 daemon，会话需重新 connect）'))
      }, timeoutMs)
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      try {
        c.stdin!.write(JSON.stringify({ id, cmd, ...args }) + '\n')
      } catch (e) {
        /* 子进程在 spawn 与写入之间就死了 → write 同步抛（EPIPE）。报成可读的失败，
         * 别把 ERR_STREAM_DESTROYED 直接甩给调用方。 */
        clearTimeout(timer)
        pending.delete(id)
        reject(new Error('daemon 请求发送失败（' + cmd + '）：' + message(e)))
      }
    })

  return {
    events,
    call,
    init() {
      ensure()
      return initResult ?? Promise.resolve({ ok: false, error: '尚未 spawn daemon' })
    },
    logTail(n = 60) { return events.logs.slice(-n) },
    subscribe(kind, cb) {
      const set = listeners.get(kind) ?? new Set()
      set.add(cb)
      listeners.set(kind, set)
      return () => { set.delete(cb) }
    },
    stats: () => ({ calls, restarts, alive: !exited && child !== null, pid: child?.pid ?? null, daemonPath }),
    close() {
      if (!child) return
      try { child.stdin!.write(JSON.stringify({ id: -1, cmd: 'shutdown' }) + '\n') } catch { /* ignore */ }
      const dying = child
      setTimeout(() => { try { dying.kill() } catch { /* ignore */ } }, 1500).unref()
    },
  }
}
