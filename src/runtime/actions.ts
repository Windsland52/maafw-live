/**
 * 运行时动作层：把 daemon 的 JSON 行命令包成有类型、有超时、有默认值的函数。
 *
 * 命令（`src/commands/*`）与 `maafw-live repl` 都只调这一层——同一条链路上不允许出现第二份
 * 参数拼装逻辑，否则 CLI 与 REPL 会各长出一套规则。项目（interface.json）驱动的连接与运行
 * 也在这里收口，避免"手动连 vs 项目连"两条路径对资源与坐标系的解释分叉。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import {
  loadInterface, planController, resolveResourcePaths,
  type ControllerPlan, type DeviceLike, type LoadedInterface,
} from '../interface/index.js'
import { spawnDaemon, type DaemonClient, type SpawnOptions } from '../client/daemon.js'

/** 设备会话的连接参数（手动路径）。kind/target 之外全部来自 maafw 的控制器能力。 */
export interface ManualConnect {
  kind: 'adb' | 'win32' | 'gamepad'
  target?: string
  /** 截图缩放覆盖（会改变 Tasker 识别图像的坐标系，模板/roi 随之变化） */
  shortSide?: number
  longSide?: number
  rawSize?: boolean
  screencap?: string
  mouse?: string
  keyboard?: string
  gamepadType?: string
}

export interface ConnectSession {
  ok: boolean
  error?: string
  session?: Record<string, unknown> | null
  /** 本次连接重建了控制器、因而停掉了上一轮的帧流（需要看帧就重新 stream_start） */
  streamStopped?: boolean
}

/** 起一个 daemon、跑 fn、无论如何都收掉子进程。一次性命令用它，REPL 用长活客户端。 */
export async function withDaemon<T>(
  fn: (client: DaemonClient) => Promise<T>,
  options: SpawnOptions = {},
): Promise<T> {
  const client = spawnDaemon(options)
  try {
    return await fn(client)
  } finally {
    client.close()
  }
}

/* ─────────────────────────── 直通命令 ─────────────────────────── */

export const probe = (c: DaemonClient) => c.call<Record<string, unknown>>('probe', {}, 30000)
export const deviceList = (c: DaemonClient, kind: 'all' | 'adb' | 'win32' = 'all') =>
  c.call<DeviceLike[]>('device_list', { kind }, 40000)
export const connect = (c: DaemonClient, args: Record<string, unknown>) =>
  c.call<ConnectSession>('connect', args, 40000)
export const disconnect = (c: DaemonClient) => c.call<{ ok: boolean }>('disconnect', {}, 20000)
export const screencap = (c: DaemonClient, out?: string) =>
  c.call<Record<string, unknown>>('screencap', out ? { out } : {}, 30000)

/**
 * 一次性命令的"先产生一次观测"：截一帧进 daemon 的 L0，然后**把临时文件删掉**。
 *
 * 为什么需要这一帧：L0 是进程态，一次性命令（`crop` / `annotate` / `color`）每次 spawn 自己的
 * daemon，不先截一帧就没有原图可用。为什么必须删：daemon 收帧时就把像素读进缓冲了，
 * 落盘那份只为喂它一次——不删就是每跑一次在系统临时目录留一张 720p 截图（实测攒到 42 张 / 54MB）。
 * 失败不抛：没有观测时命令自己会报"先 screencap / stream"这类可行动的错。
 */
export async function seedObservation(c: DaemonClient, prefix: string): Promise<void> {
  const file = join(tmpdir(), 'maafw_' + prefix + '_' + Date.now() + '.png')
  try {
    await screencap(c, file).catch(() => null)
  } finally {
    try { rmSync(file, { force: true }) } catch { /* ignore */ }
  }
}
export const streamStart = (c: DaemonClient, args: { fps?: number; scale?: number; maxFrames?: number; l0Roll?: number; l0Anchor?: number; l0Bytes?: number; blockThresh?: number; changeGlobal?: number } = {}) =>
  c.call<Record<string, unknown>>('stream_start', args, 15000)
export const streamStop = (c: DaemonClient) => c.call<{ ok: boolean }>('stream_stop', {}, 10000)
export const streamStatus = (c: DaemonClient) => c.call<Record<string, unknown>>('stream_status', {}, 10000)
export const frameGet = (c: DaemonClient, args: { seq?: number; roi?: number[]; out?: string; src?: 'auto' | 'full' | 'ring' }) =>
  c.call<Record<string, unknown>>('frame_get', args, 30000)
/** 等状态谓词成立：stable=画面静下来 / change=画面动了。取代调用方硬睡时钟。 */
export const waitState = (c: DaemonClient, args: { mode?: 'stable' | 'change'; timeout?: number; quiet?: number; roi?: number[]; threshold?: number } = {}) =>
  c.call<Record<string, unknown>>('wait', args, Math.min(120000, Number(args.timeout ?? 10000)) + 5000)
/** 两帧在若干 ROI 上的差分：回答"这一步改了哪几格"。 */
export const frameDiff = (c: DaemonClient, args: { a: number; b: number; rois: number[][] }) =>
  c.call<Record<string, unknown>>('frame_diff', args, 30000)
export const colorProbe = (c: DaemonClient, args: { seq?: number; roi?: number[] }) =>
  c.call<Record<string, unknown>>('color_probe', args, 15000)
/** 裁剪源 = 关键帧库留存帧（离线解析出来的身份 + 路径；daemon 会复核 sha256 与像素尺寸）。 */
export interface CropKfSource {
  id: string
  path: string
  sha256: string
  ctrlW: number
  ctrlH: number
  captureSeq: number | null
  capturedAt: string | null
}
export const tplCrop = (c: DaemonClient, args: {
  seq?: number
  roi?: number[]
  point?: number[]
  pad?: number
  out?: string
  resourceDir?: string
  cross?: boolean
  kfSource?: CropKfSource
  prov?: boolean
  /** 出处侧车改写到该目录下（保持同名）；缺省写在模板旁 */
  provOut?: string
  /** 热缓存路径下把本次实际用的那一帧升格进库，出处随即带上可复核的 `kf:` 身份 */
  keepSource?: boolean
  /** snap 收紧阈值的**测量用覆盖**（定标 A/B）；缺省即生产常数 */
  snapTol?: number
  snapFrac?: number
}) => c.call<Record<string, unknown>>('tpl_crop', args, 240000)
export const annotate = (c: DaemonClient, args: {
  seq?: number
  out?: string
  resourceDir?: string
  kfSource?: CropKfSource
  /** 候选上限（缺省 30；截断按横向分带轮转，`mergedTotal` 才是去重后的真实规模） */
  somLimit?: number
  /** 边缘源门槛的**测量用覆盖**（定标 A/B）；缺省即生产常数 */
  somEdgeZ?: number
  somEdgeMin?: number
  /** 连通域合并 IoU 的测量用覆盖 */
  somIoU?: number
  /** 巨框剔除阈值（画面面积比，缺省 0.12；OCR 框不参与）——背景/立绘/整屏变化区不该占表 */
  somMaxAreaRatio?: number
  /** 只保留落在该区域（控制器空间）内的候选，且在**取上限之前**过滤：
   * 区域内的候选只跟自己竞争。上限截断的正解是收小搜索面，不是把上限调大。 */
  roi?: number[]
  /** 检测面：full(缺省，有 L0 时用控制器分辨率原图) | small（强制降采样小图，快但小目标会漏） */
  somScale?: 'full' | 'small'
}) => c.call<Record<string, unknown>>('annotate', args, 120000)
export const calibrate = (c: DaemonClient, args: { frames?: number; interval?: number } = {}) =>
  c.call<Record<string, unknown>>('calibrate', args, 120000)
export const runStop = (c: DaemonClient) => c.call<{ ok: boolean }>('run_stop', {}, 10000)
export const l0Status = (c: DaemonClient) => c.call<Record<string, unknown>>('l0_status', {}, 10000)
export const kfPromote = (c: DaemonClient, args: { seq?: number; latest?: boolean; note?: string }) =>
  c.call<Record<string, unknown>>('kf_promote', args, 30000)

export function run(c: DaemonClient, args: Record<string, unknown>, timeoutMs = 30000) {
  /* timeoutMs=0 = 不自动停（停止权交调用方）：客户端调用超时放到 24h 档。
   * 不用 Infinity——Node 的 setTimeout 上限 2^31-1，超限会立即触发，反而误杀。 */
  const t = Number(timeoutMs)
  const budget = t === 0 ? 86400000 : Math.min(86400000, Math.max(500, t || 30000))
  return c.call<Record<string, unknown>>('run', { ...args, timeoutMs: t === 0 ? 0 : budget }, budget + 15000)
}

export const input = (c: DaemonClient, payload: Record<string, unknown>, timeoutMs = 20000) =>
  c.call<Record<string, unknown>>('input', payload, timeoutMs)

export const recoTest = (c: DaemonClient, args: Record<string, unknown>) =>
  c.call<Record<string, unknown>>('reco_test', args, 90000)

/* ─────────────────────── 项目（interface.json）驱动 ─────────────────────── */

/** 控制器类型 → 需要扫描的设备类型。控制器没声明时按第一个控制器推断。 */
export function deviceKindFor(loaded: LoadedInterface, controllerName: string | null): 'adb' | 'win32' {
  const c = controllerName ? loaded.controllers.find((x) => x.name === controllerName) : loaded.controllers[0]
  return String(c?.type) === 'Adb' ? 'adb' : 'win32'
}

export interface ProjectPlan {
  loaded: LoadedInterface
  plan: ControllerPlan | null
  controllerName: string | null
  resource: ReturnType<typeof resolveResourcePaths> | null
  error?: string
}

/**
 * 载入项目 → 扫设备 → 规划控制器 → 解析资源路径。
 *
 * 为什么不猜设备：interface.json 的 controller[] 已经声明了 Adb/Win32、窗口类名与标题正则、
 * 截图与输入方法、以及识别缩放（display_short_side）——猜错不只是连错窗口，还会把 roi 与
 * 模板的坐标系一起猜错。interface.json 的读法只有 src/interface/ 一份，别处不许再解析一遍。
 */
export async function planProject(
  c: DaemonClient,
  dir: string,
  overrides: { controller?: string; hwnd?: string; gamepadHwnd?: string; address?: string; resource?: string; manualTarget?: string } = {},
): Promise<ProjectPlan> {
  const loaded = loadInterface(dir)
  if (!loaded.file) {
    return { loaded, plan: null, controllerName: null, resource: null, error: loaded.problems[0]?.message ?? '未找到 interface.json' }
  }
  const controllerName = overrides.controller ?? loaded.controllers[0]?.name ?? null
  const kind = deviceKindFor(loaded, controllerName)
  let devices: DeviceLike[] = []
  try {
    devices = await deviceList(c, kind)
  } catch (e) {
    return { loaded, plan: null, controllerName, resource: null, error: '扫描设备失败：' + String((e as Error).message || e) }
  }
  const plan = planController(loaded, {
    controller: controllerName ?? undefined,
    win32: { hwnd: overrides.hwnd ?? null },
    gamepad: { hwnd: overrides.gamepadHwnd ?? null },
    adb: { address: overrides.address ?? null },
    manualTarget: overrides.manualTarget ?? null,
  }, devices)
  const resource = resolveResourcePaths(loaded, controllerName ?? undefined, overrides.resource)
  return { loaded, plan, controllerName, resource }
}
