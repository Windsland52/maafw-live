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
  computePipelineOverride, loadInterface, appendOverride, planController, resolveResourcePaths,
  type ControllerPlan, type DeviceLike, type LoadedInterface,
} from '../interface/index.js'
import { spawnDaemon, type DaemonClient, type SpawnOptions } from '../client/daemon.js'
import { buildAgentEnv } from './pi-env.js'

/** 设备会话的连接参数（手动路径）。kind/target 之外全部来自 maafw 的控制器能力。
 * playcover/macos 仅 macOS、linux 仅 Linux；device_list 只枚举 adb/win32，
 * 其余三种没有自动发现，靠 connect 的 target/config 显式指定（doc: daemon-protocol.md:49）。 */
export interface ManualConnect {
  kind: 'adb' | 'win32' | 'gamepad' | 'playcover' | 'macos' | 'linux'
  target?: string
  /** playcover：uuid（也可写在 target 里） */
  uuid?: string
  /** linux：等价于 target 的 JSON */
  config?: string
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

/**
 * 给命令一个 daemon 客户端：ctx.client 有就借用（REPL / 命名会话，**不关**——
 * 会话的生命周期不归命令管）；没有才 spawn 一次性的，跑完即关。
 * 统一入口的意义：命令只需写一遍，`--session` 转发与 REPL 复用走的是同一份实现。
 */
export async function withDaemon<T>(
  ctx: { client?: DaemonClient },
  fn: (client: DaemonClient) => Promise<T>,
  options: SpawnOptions = {},
): Promise<T> {
  if (ctx.client) return await fn(ctx.client)
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
/** 事件环查询：一次性 CLI 用。事件环活在 daemon 里，跨进程只能现查（REPL 另有本地副本）。 */
export const eventsList = (c: DaemonClient, args: { since?: number; limit?: number } = {}) =>
  c.call<{ ok: boolean; total: number; matched: number; cap: number; truncated: boolean; events: Array<Record<string, unknown>> }>(
    'events_list', args, 10000)
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
  /** 边缘收紧那一路（默认 false）：true 时把"局部对比度"判据也放进候选池。
   * 常数可再覆盖（定标用）：edgeZ 环上对比度 p90 倍数（默认 2）、edgeMin 绝对地板（默认 24）、
   * edgeFrac 行/列命中比例门槛（默认 0.02）。 */
  edge?: boolean
  edgeZ?: number
  edgeMin?: number
  edgeFrac?: number
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

/** 识别单测。`timeoutMs` 供**多候选**调用方放宽（候选逐例串行，耗时随候选数线性增长：
 * daemon 侧的子进程预算也跟着用例数放宽，见 framed.mjs 的 recoChildBudget）。 */
export const recoTest = (c: DaemonClient, args: Record<string, unknown>, timeoutMs = 90000) =>
  c.call<Record<string, unknown>>('reco_test', args, timeoutMs)

/* ─────────────────────── 项目（interface.json）驱动 ─────────────────────── */

/**
 * 控制器类型 → 需要扫描的设备类型；**无设备可枚举的类型返回 null**（调用方跳过扫描）。
 * daemon 的 device_list 只枚举 adb/win32——PlayCover/MacOS/Linux 给 'win32' 会白白发起
 * 一次必然失败的扫描（曾经就是这样，把无关窗口列表塞进计划错误里）。
 */
export function deviceKindFor(loaded: LoadedInterface, controllerName: string | null): 'adb' | 'win32' | null {
  const c = controllerName ? loaded.controllers.find((x) => x.name === controllerName) : loaded.controllers[0]
  const t = String(c?.type)
  if (t === 'Adb') return 'adb'
  if (t === 'Win32' || t === 'Gamepad') return 'win32'
  return null
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
  overrides: { controller?: string; hwnd?: string; gamepadHwnd?: string; address?: string; resource?: string; manualTarget?: string; cwd?: string } = {},
): Promise<ProjectPlan> {
  const loaded = loadInterface(dir)
  if (!loaded.file) {
    return { loaded, plan: null, controllerName: null, resource: null, error: loaded.problems[0]?.message ?? '未找到 interface.json' }
  }
  const controllerName = overrides.controller ?? loaded.controllers[0]?.name ?? null
  const kind = deviceKindFor(loaded, controllerName)
  let devices: DeviceLike[] = []
  if (kind) {
    try {
      devices = await deviceList(c, kind)
    } catch (e) {
      return { loaded, plan: null, controllerName, resource: null, error: '扫描设备失败：' + String((e as Error).message || e) }
    }
  }
  /* kind=null（playcover/macos/linux）：没有可枚举设备，planController 走 --target 分支 */
  const plan = planController(loaded, {
    controller: controllerName ?? undefined,
    win32: { hwnd: overrides.hwnd ?? null },
    gamepad: { hwnd: overrides.gamepadHwnd ?? null },
    adb: { address: overrides.address ?? null },
    manualTarget: overrides.manualTarget ?? null,
  }, devices)
  const resource = resolveResourcePaths(loaded, controllerName ?? undefined, overrides.resource, overrides.cwd)
  return { loaded, plan, controllerName, resource }
}

/** `run` 的项目模式装配：入口解析、任务适用性、四级 override、agent 桥接。 */
export interface ProjectRunInput {
  /** 已规划的项目（`planProject` / REPL `connect project` 的产物） */
  project: ProjectPlan
  /** interface 的 task 名或 pipeline 入口名（两者都认，与一次性 CLI 同规则） */
  entry: string
  /** preset 名：取值覆盖 default_case（PI v2.3.0） */
  presetName?: string | null
  /** CLI 按次取值：option 键 → case 名（select/switch 单值；checkbox 数组） */
  optionCases?: Record<string, string | string[]>
  /** CLI 按次取值：option 键 → { 字段名: 原文 }（input / hotkey） */
  optionFields?: Record<string, Record<string, string>>
  /** 用户 --override：对象=追加一层 / 数组=逐层追加（最高优先级），框架逐层继承 */
  override?: Record<string, unknown> | Record<string, unknown>[]
}

/** 装配结果：要么可直接交给 `act.run`，要么是一份可行动的错误（不抛异常）。 */
export type ProjectRunPrep =
  | {
      ok: true
      /** 直接交给 act.run 的参数（资源整链 + 入口 + 合成 override + agent 声明） */
      args: Record<string, unknown>
      /** 解析后的 pipeline 入口名（interface task 名 → task.entry） */
      entry: string
      taskName: string | null
      /** 生效记录：option=值（级别，via preset/default） */
      applied: string[]
      /** 需要人工注意的事项（option 无取值、agent 缺位等） */
      warns: string[]
    }
  | {
      ok: false
      code: string
      error: string
      hint?: string
      warns: string[]
    }

/**
 * 项目模式 run 的唯一装配点：一次性 CLI 与 REPL `run` 都走这里。
 *
 * 为什么必须共享：REPL 曾经只吃 `--override`、不叠 interface 的四级链，同一项目同一入口
 * 在 REPL 里 option / preset / default_case 全部不生效——agent 主路径与一次性命令跑出两套
 * 行为，而且不报错。入口解析、task 适用性、pretask/agent 警示也一并收口，避免第二份规则。
 */
export function prepareProjectRun(input: ProjectRunInput): ProjectRunPrep {
  const { project, entry } = input
  const { loaded } = project
  const warns: string[] = []
  const paths = project.resource?.paths ?? []
  if (!paths.length) {
    return {
      ok: false,
      code: 'RESOURCE_NOT_FOUND',
      error: '项目里没有解析出资源路径：检查 interface.json 的 resource[] 声明',
      warns,
    }
  }

  const task = loaded.tasks.find((t) => t.name === entry || t.entry === entry)
  const resolvedEntry = task?.entry ?? entry
  const ctrlName = project.controllerName ?? null
  const resName = project.resource?.selected ?? null

  /* task 适用性（task.controller / task.resource 声明） */
  if (task?.controller?.length && ctrlName && !task.controller.includes(ctrlName)) {
    return {
      ok: false,
      code: 'TASK_NOT_APPLICABLE',
      error: '任务 ' + task.name + ' 不支持当前控制器 ' + ctrlName + '（声明：' + task.controller.join(' / ') + '）',
      hint: '换控制器（CLI 用 --controller <名>，REPL 重新 connect project）或选别的任务',
      warns,
    }
  }
  if (task?.resource?.length && resName && !task.resource.includes(resName)) {
    warns.push('任务 ' + task.name + ' 声明资源 ' + task.resource.join(' / ') + '，当前选中的是 ' + resName)
  }

  /* 多个资源条目都适用时 resource[] 只能选一个：plan 侧记下"选了哪个、还有谁适用"，
   * 在这里升成 warning——human 的 note 行机器消费面（--json）读不到。 */
  for (const n of project.resource?.notes ?? []) warns.push(n)

  /* pipeline_override 四级合并链（preset > default_case 取值） + 用户 --override 最后覆盖 */
  const chain = computePipelineOverride({
    loaded,
    controllerName: ctrlName,
    resourceName: resName,
    taskName: task?.name ?? null,
    presetName: input.presetName ?? null,
    ...(input.optionCases ? { optionCases: input.optionCases } : {}),
    ...(input.optionFields ? { optionFields: input.optionFields } : {}),
  })
  warns.push(...chain.warns)

  const agents = loaded.agents
  /* agent 子进程要的环境：PI_* 按 interface.json 的**当前选择**生成（控制器 / 资源 / 项目版本）。
   * 不注入时 agent 不会报错，只会落到自带默认值——这是最安静的一种"跑的不是同一个配置"。 */
  const agentEnv = buildAgentEnv({ loaded, controllerName: ctrlName, resourceName: resName })
  if (agents.length) {
    const injected = Object.keys(agentEnv)
    warns.push('项目声明了 ' + agents.length + ' 个 agent 子进程（' +
      agents.map((a) => [a.exec, ...a.args].join(' ')).join(' ; ') +
      '），run 时自动 spawn 并桥接' +
      (injected.length ? '（注入 ' + injected.join(' / ') + '）' : '') +
      '——注意 maa-node 与 agent 侧 maa 库须同版本（协议握手要求）')
  }

  /* 分层 override：四级链已按层序排好（task 基底 + 各 option 层），用户 --override
   * 追加到尾部=最高优先级。别在这里摊平——框架的层间字段继承（recognition/param 同
   * type 按键继承）只有数组形态能保住层边界（上游 @8061d5b 已核）。 */
  const override = [...chain.override]
  if (input.override) appendOverride(override, input.override)

  return {
    ok: true,
    args: {
      resourceDirs: paths,
      /* v2.6 资源完整性：只在加载完 path[] 后读 hash（attach 不能算进去），
       * 两段在 resolveResourcePaths 已经分好 */
      ...(project.resource?.hashCheck ? { resourceHashCheck: project.resource.hashCheck } : {}),
      entry: resolvedEntry,
      override,
      /* agent 桥接：daemon spawn 子进程（identifier 追加为末参）并 bind/connect 到本次 Resource */
      agents: agents.map((a) => ({ exec: a.exec, args: a.args })),
      agentCwd: loaded.dir ?? undefined,
      agentEnv,
    },
    entry: resolvedEntry,
    taskName: task?.name ?? null,
    applied: chain.applied,
    warns,
  }
}
