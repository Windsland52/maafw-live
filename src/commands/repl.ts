/**
 * maafw-live repl —— 一次连接、多步操作的会话外壳。
 *
 * 为什么需要它：daemon 的连接是进程态，而设备操作天生是多步的（连上 → 看画面 → 点 → 再看）。
 * 一次性命令每次都要重连，所以把"连接一次、命令复用"做成一个前台循环：内部与一次性命令
 * 走同一批动作函数（runtime/actions），因此不存在第二套参数规则。
 *
 * 既能交互用，也能被脚本/agent 用管道驱动：printf 'probe\nquit\n' | maafw-live repl
 */
import readline from 'node:readline'
import { resolve } from 'node:path'
import { spawnDaemon, type DaemonClient } from '../client/daemon.js'
import { EXIT, fail, type Command, type CommandContext, type CommandResult, type ExitCode } from '../protocol.js'
import * as act from '../runtime/actions.js'
import { defaultFramesDir, describeRecord, loadManifest, resolveFrame } from '../runtime/keyframes.js'
import { roiOutOfBounds } from '../runtime/reco-args.js'
import { ensureSession, SessionError, type SessionOptions, type SessionState } from '../runtime/session.js'
import {
  pidAlive, readSessionMeta, sendToSession, SessionServer, sessionPipePath,
  spawnSessionServer, stopSession, validSessionName, waitPipeReady,
} from '../runtime/session-ipc.js'
import { CONNECT_OPTIONS, sessionOptions } from './runtime.js'

const HELP = [
  '命令：',
  '  probe                          自检运行时',
  '  device [all|adb|win32]         列设备',
  '  connect <win32|adb|gamepad> [target]   手动连接',
  '  connect project <dir> [hwnd|address]   按 interface.json 规划连接（推荐）',
  '  disconnect                     断开并销毁 Tasker/Controller',
  '  screencap [out.png] | screencap --out out.png    截一帧落盘（同时进 L0，可升格）',
  '  stream start [--fps n] [--scale n] [--l0-roll n] [--l0-anchor n] [--max-frames n] [--block-thresh n] [--change-global n] [--l0-bytes n]',
  '  stream stop | stream status',
  '  frame [seq] [--roi x,y,w,h] [--src auto|full|ring] [--out f.png]   取帧（--src full = 控制器分辨率原图）',
  '  frame diff --a <seq> --b <seq> --rois "x,y,w,h;x,y,w,h"   两帧在若干 ROI 上的差分（判断"改了哪几格"）',
  '  wait stable|change [--timeout ms] [--quiet ms] [--roi x,y,w,h] [--threshold n]   等状态谓词成立（别硬睡）',
  '  color [--roi x,y,w,h]        探色（均值/HSV/主色，最新缓冲帧）',
  '  crop --roi x,y,w,h | --point x,y [--pad n] [--out f.png] [--from-kf kf:...]   模板裁剪（原图 + 自匹配；--from-kf 走库内留存帧，离线）',
  '  annotate [--out f.png] [--som-limit n] [--som-max-area-ratio r] [--from-kf kf:...]   SoM 候选与编号回画（回画优先全分辨率；库帧路径离线、diff 不可用）',
  '  events [n]                     最近 n 条帧流事件（默认 10）',
  '  logs [n]                       daemon 原生 stderr 尾部（默认 20）',
  '  run <entry> [--timeout ms|0] [--override json] [--resource-dir d]   （异步执行，不阻塞提示符）',
  '  stop                           停止运行中的任务',
  '  click <x> <y> | swipe <x1> <y1> <x2> <y2> [--duration ms] [--via "x,y;x,y"] | key <code> | text <string>',
  '       swipe --via 走 touch_down→逐点 touch_move→touch_up：**一条笔画画折线**（中途不抬手）',
  '  press <x> <y> [--duration ms] | dbclick <x> <y> | keys <c[,c+..]> | scroll <dx> <dy> | move <dx> <dy>',
  '  touchdown <x> <y> | touchmove <x> <y> | touchup       裸触点原语（跨命令维持同一次按压）',
  '  reco <type> [k=v ...] [--image f.png|kf:…] [--seq n] [--from-kf kf:…] [--resource-dir d] [--sweep json]',
  '       识别单测。缺省用会话缓冲最新帧（L1 小图，roi 要按该图尺寸给）；--image 走文件',
  '       （控制器空间，roi 用 ctrl 坐标）；--from-kf 走库内留存帧、离线。roi 必须给数组：',
  '       `roi=1,2,3,4`（逗号写法即可，不必写方括号）。',
  '  kf status | kf promote [seq|latest] [--note s] | kf list | kf resolve <kf:...>',
  '  help | quit',
]

/** 分词：空格分隔，支持 --flag value 与 key=value；text 用整行剩余内容。
 *
 * **引号要剥掉**：脚本与 agent 习惯把带逗号的参数写进引号（`--roi "470,10,180,110"`），
 * 不剥就整串当参数：`Number('"470')` = NaN → 走 JSON 变 null → daemon `Number(null)` = 0，
 * 于是退化成一个**合法但错误**的框（实测 `--roi "400,20,200,60"` 变成 `w=200,h=0`）且不报错。
 * 剥引号让"带引号"与"不带引号"等价——这是调用方最自然的写法。
 *
 * **引号内的空格不是分隔符**：只按 `/\s+/` 切再逐 token 剥首尾引号，会把带空格的引号参数切碎，
 * 且残片各自都不成对、于是**原样留着引号**：`--note "活动大厅 主界面"` 变成
 * `--note '"活动大厅'`（`readFlag` 只取下一个 token）——数据侧被污染成"截断 + 残留引号"，
 * 而 `kf promote` 照收不误，`kf list` 里看起来像是显示层截断。同一个坑对
 * `--expected "选择 领队"`、`--override '{...带空格...}'` 一样成立。
 *
 * 所以这里按字符扫描：引号内的空白并入当前 token，引号本身不产出。
 * `\` 只转义引号与 `\` 自身（Windows 路径里的反斜杠必须原样保留）。
 * 未闭合的引号按"到行尾"收，并把内容原样给出——参数校验层会拿它报错，不在这里静默吞掉。 */
function tokenize(line: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\' && (line[i + 1] === quote || line[i + 1] === '\\')) {
        cur += line[++i]
        continue
      }
      if (ch === quote) { quote = null; continue }
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue }
    if (/\s/.test(ch)) {
      if (has) { tokens.push(cur); cur = ''; has = false }
      continue
    }
    cur += ch
    has = true
  }
  if (has) tokens.push(cur)
  return tokens
}

function readFlag(tokens: string[], name: string): string | undefined {
  const i = tokens.indexOf(name)
  return i >= 0 ? tokens[i + 1] : undefined
}

/**
 * 取 count 个数字参数；任何一个不是有限数就返回 null。
 *
 * REPL 直接复用同一个设备会话，敲错一个坐标就是**真机上一次真实输入**——空参的 `click`
 * 会变成 `Number(undefined)` = NaN → JSON 里变 null → daemon `Number(null)` = 0，
 * 也就是"什么都没写"等于"点左上角"。CLI 侧（`input.ts`）每条都有这道校验，REPL 也得有。
 */
function nums(tokens: string[], from: number, count: number): number[] | null {
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const n = Number(tokens[from + i])
    if (!Number.isFinite(n)) return null
    out.push(n)
  }
  return out
}

/** `--flag` 的数字值：没给就用默认；给了但不是数字 → null（调用方报用法，不把 NaN 发给设备） */
function numFlag(tokens: string[], name: string, def: number): number | null {
  const raw = readFlag(tokens, name)
  if (raw === undefined) return def
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** reco 的 k=v 里**期望数组**的参数：单值写法（`roi=558,68,140,43`）必须落成数组。
 *
 * 为什么不能靠"看起来像数字"自动判断：`Number("558,68,140,43")` = NaN，于是旧代码把整串
 * 当字符串发出去，而 MaaFW 只认 `is_array()` —— 字符串被当**节点名**解析，回执 `ok:false`
 * 且无置信度，看起来像"模板没读到"。本文件里另外 8 处（frame/crop/color/wait/annotate/swipe）
 * 早就按逗号拆了，`reco` 是唯一遗漏。
 *
 * 为什么只列 `roi`：它是 MaaFW 里唯一"不给数组就必然用错空间"的参数（`roi` 也覆盖了
 * `roi_offset` 这类同族标量写法，那些在 pipeline 里可以是单值，不擅自升级）。`expected`
 * 不动——OCR 的 expected 字符串与数组**都命中**（实测），按逗号拆文本是凭空造规则。 */
const RECO_ARRAY_PARAMS = ['roi']

/** `[...]` / `a,b,c` 两种数组写法都收；有一个不是有限数就退回原字符串（不猜、不静默改成 NaN）。 */
function coerceRecoList(v: string): number[] | null {
  const body = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1) : v
  const parts = body.split(',').map((x) => x.trim())
  if (parts.some((x) => x === '')) return null
  const nums = parts.map((x) => Number(x))
  return nums.every((n) => Number.isFinite(n)) ? nums : null
}

/** repl `reco <type> k=v …` 的参数解析：沿用既有惯例（数字转 number），列表参数转数组。 */
export function recoParam(tokens: string[]): Record<string, unknown> {
  const param: Record<string, unknown> = {}
  for (const t of tokens.slice(2)) {
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const k = t.slice(0, eq)
    const v = t.slice(eq + 1)
    if (RECO_ARRAY_PARAMS.includes(k) && (v.includes(',') || (v.startsWith('[') && v.endsWith(']')))) {
      param[k] = coerceRecoList(v) ?? v
      continue
    }
    param[k] = Number.isFinite(Number(v)) && v !== '' ? Number(v) : v
  }
  return param
}

/** 库帧来源解析（`--from-kf kf:…` 与 `--image kf:…` 共用）：与一次性 CLI 同一份离线读侧。 */
function kfSourceFrom(id: string, tokens: string[]): { source?: act.CropKfSource; error?: string } {
  const dir = readFlag(tokens, '--frames-dir') ?? defaultFramesDir()
  const rr = resolveFrame(dir, id)
  if (rr.status !== 'available' || !rr.path || !rr.record) {
    return { error: '库帧不可用（' + rr.status + '）：' + String(rr.reason ?? '') + '（库 ' + dir + '）' }
  }
  return {
    source: {
      id: rr.record.id, path: rr.path, sha256: rr.record.sha256,
      ctrlW: rr.record.ctrlW, ctrlH: rr.record.ctrlH,
      captureSeq: rr.record.captureSeq, capturedAt: rr.record.capturedAt,
    },
  }
}

/** `screencap` 的参数面：**只认 `--out`**。
 *
 * 为什么在这里单独做白名单、而不是全局"位置参数不许以 -- 开头"：本文件的 `text` 吃整行剩余，
 * `frame`/`crop`/`wait`/`swipe --via` 各有自己的旗标表，全局规则会误伤。而 screencap 的坏参数
 * 特别贵：旧写法把 `--out` 当**位置参数**，于是真写出一个名为 `--out` 的文件（`ok:true` 掩盖），
 * 而 CLI 的 `screencap --out x.png` 是对的——同一条链路上两套规则，谁都记不住哪边对。 */
function screencapArgs(tokens: string[]): { out?: string; error?: string } {
  const out = readFlag(tokens, '--out')
  const positionals = tokens.slice(1).filter((t) => !t.startsWith('--') && t !== out)
  const unknown = tokens.slice(1).filter((t) => t.startsWith('--') && t !== '--out')
  if (unknown.length) {
    return { error: 'screencap 只认 --out <png>（收到未知选项 ' + unknown.join(' ') + '）；位置参数写法同样可用' }
  }
  if (positionals.length > 1) {
    return { error: 'screencap 只写一个文件（收到 ' + positionals.length + ' 个位置参数：' + positionals.join(' ') + '）' }
  }
  const path = out ?? positionals[0]
  return path === undefined ? {} : { out: path }
}

function short(v: unknown, max = 400): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > max ? s.slice(0, max) + ' …' : s
}

/** REPL 自己的词表（与 CLI 命令集**不同**：stream/wait/events/logs 只在会话里）。
 * 敲错时给最近的命令名——一次性 CLI 早有编辑距离建议，会话里没有，而会话里敲错更贵
 * （要么重新起会话，要么对着"未知命令"猜半天）。 */
const REPL_HEADS = [
  'probe', 'device', 'connect', 'disconnect', 'screencap', 'stream', 'wait', 'frame',
  'color', 'crop', 'annotate', 'events', 'logs', 'run', 'stop', 'click', 'swipe',
  'key', 'keys', 'press', 'dbclick', 'scroll', 'move', 'text', 'touchdown', 'touchmove',
  'touchup', 'reco', 'kf', 'help', 'quit',
]

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]!
}

function suggestHead(name: string, maxDistance = 3): string | undefined {
  let best: string | undefined
  let bestDist = maxDistance + 1
  for (const h of REPL_HEADS) {
    const d = editDistance(name, h)
    if (d < bestDist) { bestDist = d; best = h }
  }
  return bestDist <= maxDistance ? best : undefined
}

export const replCommand: Command = {
  name: 'repl',
  summary: '交互/管道会话：连接一次，后续命令复用同一个 daemon 与设备会话',
  usage: 'maafw-live repl [--project <dir>|--kind win32|adb|gamepad [--target ...]]\n' +
    '       maafw-live repl --session <name> [--cmd <命令>]…   命名常驻会话：首次起、之后复用（不必自建驱动）\n' +
    '        不带 --cmd：进入该会话的交互式提示符（等价于 repl，但连接状态跨调用保持）\n' +
    '        带 --cmd：把命令送进常驻会话并打印回执；可给多个 --cmd，逐条串行执行\n' +
    '          maafw-live repl --session cc --cmd "screencap a.png"\n' +
    '          maafw-live repl --session cc --cmd "run CritterCrashEntry --timeout 0" --cmd "events 20"\n' +
    '        **必须用 --cmd 传带选项的命令**：不加 --cmd 时参数会先被 repl 自己的选项表解析，\n' +
    '        `repl --session cc run X --timeout 0` 里的 `--timeout` 会被当成 repl 的选项而报错\n' +
    '       maafw-live repl --session <name> --session-status   看会话状态\n' +
    '       maafw-live repl --session <name> --session-stop     收掉会话\n' +
    '       --session-serve <name>  内部用：常驻侧（从命名管道读命令，不要手敲）',
  options: {
    ...CONNECT_OPTIONS,
    session: { type: 'string' },
    cmd: { type: 'string', multiple: true },
    'session-status': { type: 'boolean' },
    'session-stop': { type: 'boolean' },
    'session-serve': { type: 'string' },
  },

  async run(ctx): Promise<CommandResult> {
    /* ── 常驻侧：`--session-serve` 从命名管道收命令，把 repl 的输出按条回给调用方 ──
     * 这条分支不读 stdin（PowerShell 递不了管道给子进程），而是自己 listen。 */
    const serveName = typeof ctx.values['session-serve'] === 'string' ? ctx.values['session-serve'] : undefined
    if (serveName !== undefined) {
      if (!validSessionName(serveName)) {
        return fail('BAD_ARGUMENTS', '会话名只允许字母数字与 - _（1..48 字符）', undefined, EXIT.USAGE)
      }
      return await runSessionServer(serveName, ctx)
    }

    const name = typeof ctx.values.session === 'string' ? ctx.values.session : undefined
    if (name !== undefined) {
      if (!validSessionName(name)) {
        return fail('BAD_ARGUMENTS', '会话名只允许字母数字与 - _（1..48 字符）：' + JSON.stringify(name), undefined, EXIT.USAGE)
      }
      return await runNamedSession(name, ctx)
    }

    const client = spawnDaemon()
    const out = (line: string): void => { process.stdout.write(line + '\n') }
    const state: { session: string; plan: SessionState['plan'] | null } = { session: '(未连接)', plan: null }
    const remember = (s: SessionState): void => {
      state.session = String((s.session as { target?: unknown } | null)?.target ?? '(已连接)')
      state.plan = s.plan ?? null
    }

    const o: SessionOptions = sessionOptions(ctx.values)
    if (o.project || o.kind) {
      try {
        const s = await ensureSession(client, o)
        remember(s)
        out('已连接：' + state.session)
      } catch (e) {
        out('连接失败：' + (e instanceof Error ? e.message : String(e)))
      }
    } else {
      out('未连接设备。先 connect project <dir> 或 connect win32 <target>。输入 help 看命令。')
    }

    const rl = readline.createInterface({ input: process.stdin, terminal: process.stdin.isTTY === true })
    /* 行队列：readline 的 'line' 事件不排队——命令 await 期间到达的行会被 once('line') 直接丢失，
     * 管道驱动的多行脚本（printf 'connect…\nscreencap\nquit\n' | repl）就死在第二行。
     * 持续监听 + 队列缓冲，ask() 从队列取或挂起等新行/EOF。 */
    let rlEnded = false
    const lineQueue: string[] = []
    let lineWake: (() => void) | null = null
    rl.on('line', (l: string) => {
      lineQueue.push(l)
      if (lineWake) { const w = lineWake; lineWake = null; w() }
    })
    rl.on('close', () => {
      rlEnded = true
      if (lineWake) { const w = lineWake; lineWake = null; w() }
    })
    const ask = async (): Promise<string | null> => {
      for (;;) {
        if (lineQueue.length) return lineQueue.shift() ?? null
        if (rlEnded) return null
        await new Promise<void>((r) => { lineWake = r })
      }
    }

    try {
      for (;;) {
        if (process.stdin.isTTY) process.stdout.write('maa> ')
        const line = await ask()
        if (line === null) break
        const step = await runReplLine(line, { client, out, state, remember })
        if (step === 'quit') break
      }
    } finally {
      rl.close()
      client.close()
    }

    return { exitCode: EXIT.OK, human: ['会话结束。'] }
  },
}

/** 一条 REPL 命令的执行结果：`quit` 表示该收会话了（quit/exit 或 EOF）。 */
type ReplStep = 'continue' | 'quit'

/** 一条 REPL 命令的运行时依赖。
 *
 * 抽出来是为了让**命名常驻会话**（`--session`）复用同一份命令实现：它从命名管道收命令、
 * 把输出按条回给调用方，但 switch 里那几十条命令的语义必须与交互式 repl 完全一致——
 * 复制一份必然漂移（本仓最贵的一类返工就是"两处同义实现各自演化"）。 */
interface ReplRuntime {
  client: DaemonClient
  out: (line: string) => void
  state: { session: string; plan: SessionState['plan'] | null }
  remember: (s: SessionState) => void
}

async function runReplLine(line: string, rt: ReplRuntime): Promise<ReplStep> {
  const { client, out, state, remember } = rt
  const tokens = tokenize(line)
  if (!tokens.length) return 'continue'
  const head = tokens[0]
  if (head === 'quit' || head === 'exit') return 'quit'
  if (head === 'help') { for (const h of HELP) out(h); return 'continue' }

  try {
    switch (head) {
            case 'probe':
              out(short(await act.probe(client)))
              break
            case 'device':
              out(short(await act.deviceList(client, (tokens[1] as 'all' | 'adb' | 'win32') ?? 'all')))
              break
            case 'connect': {
              let s
              if (tokens[1] === 'project') {
                s = await ensureSession(client, { project: tokens[2], hwnd: tokens[3], address: tokens[3] })
              } else {
                s = await ensureSession(client, { kind: tokens[1], target: tokens[2] })
              }
              remember(s)
              out('已连接：' + state.session)
              break
            }
            case 'disconnect':
              out(short(await act.disconnect(client)))
              state.session = '(未连接)'
              break
            case 'screencap': {
              /* --out 与位置参数都收（与 CLI 一致）；未知选项按上面白名单报错，不再写脏文件。 */
              const a = screencapArgs(tokens)
              if (a.error) { out(a.error); break }
              const r = await act.screencap(client, a.out)
              out(short(r))
              /* 回执路径与请求路径不一致要说：调用方拿到的"写到哪了"必须可信 */
              if (a.out && r.path && resolve(String(r.path)) !== resolve(a.out)) {
                out('警告：实际写入 ' + String(r.path) + '，与请求的 ' + a.out + ' 不一致')
              }
              break
            }
            case 'stream': {
              const sub = tokens[1] ?? 'status'
              if (sub === 'start') {
                const fps = readFlag(tokens, '--fps')
                const scale = readFlag(tokens, '--scale')
                const blockThresh = readFlag(tokens, '--block-thresh')
                const changeGlobal = readFlag(tokens, '--change-global')
                const l0Bytes = readFlag(tokens, '--l0-bytes')
                /* 观测策略参数：l0-roll 决定"我有多久回看窗口"（默认 16 帧 ≈ 1.6s @10fps），
                 * max-frames 决定环形缓冲长度。协议本就支持，命令面必须可达——
                 * 不可达的参数会被调用方当成"没有"。 */
                const maxFrames = readFlag(tokens, '--max-frames')
                const l0Roll = readFlag(tokens, '--l0-roll')
                const l0Anchor = readFlag(tokens, '--l0-anchor')
                out(short(await act.streamStart(client, {
                  ...(fps ? { fps: Number(fps) } : {}),
                  ...(scale ? { scale: Number(scale) } : {}),
                  ...(blockThresh ? { blockThresh: Number(blockThresh) } : {}),
                  ...(changeGlobal ? { changeGlobal: Number(changeGlobal) } : {}),
                  ...(l0Bytes ? { l0Bytes: Number(l0Bytes) } : {}),
                  ...(maxFrames ? { maxFrames: Number(maxFrames) } : {}),
                  ...(l0Roll ? { l0Roll: Number(l0Roll) } : {}),
                  ...(l0Anchor ? { l0Anchor: Number(l0Anchor) } : {}),
                })))
              } else if (sub === 'stop') out(short(await act.streamStop(client)))
              else out(short(await act.streamStatus(client)))
              break
            }
            case 'wait': {
              /* 状态谓词：等到条件成立再往下读，取代硬睡时钟。超时不算错误（satisfied=false）。 */
              const modeRaw = tokens[1]
              if (modeRaw !== 'stable' && modeRaw !== 'change') {
                out('用法：wait stable|change [--timeout ms] [--quiet ms] [--roi x,y,w,h] [--threshold n]'
                  + '（模式只认 stable / change'
                  + (modeRaw ? '；收到 ' + JSON.stringify(modeRaw)
                    + (suggestHead(modeRaw) ? '，是想输入 ' + String(suggestHead(modeRaw)) + ' 吗' : '') : '')
                  + '）')
                break
              }
              /* 数值 flag 必须校验：`--timeout abc` 会变成 NaN 一路传下去，
               * 客户端超时算成 NaN → 调用秒超时，看起来像"工具坏了"。 */
              const numOr = (name: string): number | undefined | null => {
                const raw = readFlag(tokens, name)
                if (raw === undefined) return undefined
                const n = Number(raw)
                return Number.isFinite(n) ? n : null
              }
              const tmo = numOr('--timeout')
              const qt = numOr('--quiet')
              const thr = numOr('--threshold')
              if (tmo === null || qt === null || thr === null) {
                out('--timeout / --quiet / --threshold 必须是数字'
                  + (tmo === null ? '（--timeout 收到 ' + JSON.stringify(readFlag(tokens, '--timeout')) + '）' : ''))
                break
              }
              const roiRaw = readFlag(tokens, '--roi')
              const r = await act.waitState(client, {
                mode: modeRaw,
                ...(tmo !== undefined ? { timeout: tmo } : {}),
                ...(qt !== undefined ? { quiet: qt } : {}),
                ...(thr !== undefined ? { threshold: thr } : {}),
                ...(roiRaw ? { roi: roiRaw.split(',').map((x) => Number(x)) } : {}),
              })
              out(short(r, 500))
              break
            }
            case 'frame': {
              const roiRaw = readFlag(tokens, '--roi')
              const srcRaw = readFlag(tokens, '--src')
              const seq = tokens[1] && !tokens[1].startsWith('--') ? Number(tokens[1]) : undefined
              if (tokens[1] === 'diff') {
                /* 两帧在若干 ROI 上的差分：离散网格要的是"哪几格变了"，不是整帧 bbox。 */
                const a = readFlag(tokens, '--a')
                const b = readFlag(tokens, '--b')
                const roisRaw = readFlag(tokens, '--rois')
                if (a === undefined || b === undefined || !roisRaw) {
                  out('用法：frame diff --a <seq> --b <seq> --rois "x,y,w,h;x,y,w,h"')
                  break
                }
                const rois = roisRaw.split(';').map((s) => s.split(',').map((x) => Number(x)))
                if (rois.some((r) => r.length !== 4 || r.some((n) => !Number.isFinite(n)))) {
                  out('--rois 每段要 4 个数字，段间用 ; 分隔')
                  break
                }
                const d = await act.frameDiff(client, { a: Number(a), b: Number(b), rois })
                out(short(d, 900))
                break
              }
              out(short(await act.frameGet(client, {
                ...(seq !== undefined ? { seq } : {}),
                ...(roiRaw ? { roi: roiRaw.split(',').map((x) => Number(x)) } : {}),
                ...(readFlag(tokens, '--out') ? { out: readFlag(tokens, '--out') } : {}),
                ...(srcRaw ? { src: srcRaw as 'auto' | 'full' | 'ring' } : {}),
              })))
              break
            }
            case 'color': {
              const roiRaw = readFlag(tokens, '--roi')
              out(short(await act.colorProbe(client, {
                ...(roiRaw ? { roi: roiRaw.split(',').map((x) => Number(x)) } : {}),
              }), 400))
              break
            }
            case 'crop': {
              const roiRaw = readFlag(tokens, '--roi')
              const pointRaw = readFlag(tokens, '--point')
              const padRaw = readFlag(tokens, '--pad')
              /* --from-kf：源换成库内留存帧（跨会话可用）。解析走与一次性 CLI 同一份离线读侧。 */
              const kfId = readFlag(tokens, '--from-kf')
              let kfSource: act.CropKfSource | undefined
              if (kfId) {
                const k = kfSourceFrom(kfId, tokens)
                if (k.error) { out(k.error); break }
                kfSource = k.source
              }
              const ck = await act.tplCrop(client, {
                ...(roiRaw ? { roi: roiRaw.split(',').map((x) => Number(x)) } : {}),
                ...(pointRaw ? { point: pointRaw.split(',').map((x) => Number(x)) } : {}),
                ...(padRaw ? { pad: Number(padRaw) } : {}),
                ...(readFlag(tokens, '--out') ? { out: readFlag(tokens, '--out') } : {}),
                ...(kfSource ? { kfSource, cross: false } : {}),
                ...(readFlag(tokens, '--resource-dir')
                  ? { resourceDir: readFlag(tokens, '--resource-dir') }
                  : (state.plan?.resource?.paths.length ? { resourceDir: state.plan.resource.paths[0] } : {})),
              })
              out(short(ck, 600))
              if (ck.ok !== false && ck.provPath) out('L2 出处：' + String(ck.provPath))
              break
            }
            case 'annotate': {
              /* --from-kf：源换成库内留存帧（离线；diff 源不可用，工具会如实报） */
              const kfSom = readFlag(tokens, '--from-kf')
              let somKf: act.CropKfSource | undefined
              if (kfSom) {
                const k = kfSourceFrom(kfSom, tokens)
                if (k.error) { out(k.error); break }
                somKf = k.source
              }
              const somLimitRaw = readFlag(tokens, '--som-limit')
              const somLimit = somLimitRaw === undefined ? undefined : Number(somLimitRaw)
              if (somLimitRaw !== undefined && (!Number.isFinite(somLimit) || somLimit! <= 0)) {
                out('--som-limit 必须是正整数（收到 ' + JSON.stringify(somLimitRaw) + '）；0 不等于"不限量"')
                break
              }
              const somRatioRaw = readFlag(tokens, '--som-max-area-ratio')
              const somRatio = somRatioRaw === undefined ? undefined : Number(somRatioRaw)
              if (somRatioRaw !== undefined && (!Number.isFinite(somRatio) || somRatio! <= 0 || somRatio! >= 1)) {
                out('--som-max-area-ratio 要在 (0,1) 之间（收到 ' + JSON.stringify(somRatioRaw) + '）；0 不等于"关闭剔除"')
                break
              }
              const r = await act.annotate(client, {
                ...(readFlag(tokens, '--out') ? { out: readFlag(tokens, '--out') } : {}),
                ...(somKf ? { kfSource: somKf } : {}),
                ...(somLimit !== undefined ? { somLimit } : {}),
                ...(somRatio !== undefined ? { somMaxAreaRatio: somRatio } : {}),
                ...(readFlag(tokens, '--roi') ? { roi: String(readFlag(tokens, '--roi')).split(',').map((x) => Number(x)) } : {}),
                ...(readFlag(tokens, '--resource-dir')
                  ? { resourceDir: readFlag(tokens, '--resource-dir') }
                  : (state.plan?.resource?.paths.length ? { resourceDir: state.plan.resource.paths[0] } : {})),
              })
              if (r.ok === false) { out('annotate 失败：' + String(r.error)); break }
              out('SoM ' + String(r.count) + ' 候选 → ' + String(r.out) + (somKf ? '（源：留存帧）' : ''))
              /* 可用性三列：不读它就会把"30 条"当成"画面就这些可点区域"。 */
              const av = r.availability as {
                limit?: number; mergedTotal?: number; truncated?: number
                dropped?: { tooSmall?: number; tooBig?: number; duplicated?: number }
                byBand?: Array<{ inPool: number; inTable: number }>
                outResolution?: { w: number; h: number; source: string }
              } | undefined
              if (av) {
                out('  可用性：合并池 ' + String(av.mergedTotal ?? '?') + ' → 进表 ' + String(r.count)
                  + '（上限 ' + String(av.limit ?? '?') + '，截断 ' + String(av.truncated ?? 0) + '）'
                  + '；剔除 巨框 ' + String(av.dropped?.tooBig ?? 0) + ' / 重复 ' + String(av.dropped?.duplicated ?? 0))
                if (av.byBand) out('  分带（上/中/下）进表/池：' + av.byBand.map((b) => String(b.inTable) + '/' + String(b.inPool)).join('  '))
                if (av.outResolution) out('  回画分辨率：' + String(av.outResolution.w) + 'x' + String(av.outResolution.h) + '（' + String(av.outResolution.source) + '）')
              }
              for (const c of (r.candidates as Array<{ id: number; source: string; ctrl: number[]; text?: string; score?: number; areaRatio?: number }>) ?? []) {
                out('  #' + c.id + ' [' + c.source + '] ctrl=' + c.ctrl.join(',')
                  + (typeof c.areaRatio === 'number' ? ' 面积比=' + c.areaRatio : '')
                  + (typeof c.score === 'number' ? ' score=' + c.score : '')
                  + (c.text ? '  "' + c.text + '"' : ''))
              }
              break
            }
            case 'events': {
              const n = Number(tokens[1] ?? 10)
              const evs = client.events.events.slice(-n)
              out('事件 ' + evs.length + ' 条（共 ' + client.events.events.length + '）')
              /* 每条事件显式带出画面锚点：seq 单独给没有用（L0 是滚动淘汰的，得知道还能不能取到）。
               * 保留 `short(e, 200)` 的其余字段，但锚点不能被截断掉——它是这条事件唯一可行动的部分。 */
              for (const e of evs) {
                const ev = e as { seq?: number; frame?: { seq?: number; retained?: string; source?: string | null } }
                const f = ev.frame
                const anchor = !f
                  ? '  frame=?（旧 daemon 回执，无锚点）'
                  : f.retained === 'l0'
                    ? '  frame=l0:' + String(f.seq) + (f.source ? '（' + f.source + '）' : '') + ' → frame get ' + String(f.seq)
                    : '  frame=gone（seq ' + String(f.seq) + ' 已滚出 L0，取不到了）'
                out('  ' + short(e, 200) + anchor)
              }
              break
            }
            case 'logs': {
              const n = Number(tokens[1] ?? 20)
              for (const l of client.logTail(n)) out('  ' + l)
              break
            }
            case 'run': {
              const entry = tokens[1]
              if (!entry) { out('用法：run <entry> [--timeout ms|0] [--override json] [--resource-dir d]'); break }
              /* 任务名 → pipeline 入口解析（与一次性 CLI 同规则）：interface 的 task 名（如中文
               * "启动游戏"）不是 pipeline 节点名，不解析会 task not exist 秒败 */
              const task = state.plan?.loaded.tasks.find((t) => t.name === entry || t.entry === entry)
              const resolvedEntry = task?.entry ?? entry
              const timeout = Number(readFlag(tokens, '--timeout') ?? 30000)
              const overrideRaw = readFlag(tokens, '--override')
              let override: Record<string, unknown> = {}
              if (overrideRaw) {
                try { override = JSON.parse(overrideRaw) as Record<string, unknown> }
                catch { out('--override 不是合法 JSON'); break }
              }
              /* 资源目录：--resource-dir 优先，其次当前项目规划（connect project 的 interface.json） */
              const resDirs = state.plan?.resource?.paths ?? []
              const explicitDir = readFlag(tokens, '--resource-dir')
              if (!explicitDir && !resDirs.length) {
                out('缺资源：给 --resource-dir <dir>，或先 connect project <dir>')
                break
              }
              /* 异步执行不阻塞提示符：--timeout 0 的长任务靠 stop 中断（同一条客户端连接） */
              out('已提交 ' + resolvedEntry + (task && task.name !== resolvedEntry ? '（任务 ' + task.name + '）' : '') + '（timeout=' + timeout + '，结果异步打印；stop 可中断）')
              const plan = state.plan
              act.run(client, explicitDir
                ? { resourceDir: explicitDir, entry: resolvedEntry, override, timeoutMs: timeout }
                : {
                    resourceDirs: resDirs, entry: resolvedEntry, override, timeoutMs: timeout,
                    ...(plan?.loaded.agents.length
                      ? { agents: plan.loaded.agents.map((a) => ({ exec: a.exec, args: a.args })), agentCwd: plan.loaded.dir ?? undefined }
                      : {}),
                  }, timeout)
                .then((r) => {
                  const rec = (r as {
                    record?: { ok?: boolean, stopped?: boolean, timeoutMs?: number, durationMs?: number, agent?: { ok?: boolean } }
                  }).record
                  /* 与一次性 CLI 同一份三态判据：`status:0 + stopped:true` 不是"完成"。
                   * 判据用 record 自带的 timeoutMs，不靠调用方回忆刚才给了什么。 */
                  const budget = rec && typeof rec.timeoutMs === 'number' ? rec.timeoutMs : null
                  const ranFull = rec?.stopped === true && budget !== null && budget > 0
                    && typeof rec.durationMs === 'number' && rec.durationMs >= budget
                  const verdict = !rec ? '未知'
                    : rec.ok ? 'ok'
                      : ranFull ? '超时截断（非成功，也非失败）'
                        : rec.stopped === true ? '被停止（未成功）'
                          : 'FAIL'
                  out('run 完成：任务级 ' + verdict +
                    (rec?.agent ? '，agent ' + (rec.agent.ok ? '已连接' : '失败') : '') + '  ' + short(r, 700))
                })
                .catch((e) => out('run 失败：' + (e instanceof Error ? e.message : String(e))))
              break
            }
            case 'stop':
              out(short(await act.runStop(client)))
              break
            case 'click': {
              const a = nums(tokens, 1, 2)
              if (!a) { out('用法：click <x> <y>'); break }
              out(short(await act.input(client, { kind: 'click', x: a[0], y: a[1] })))
              break
            }
            case 'swipe': {
              const a = nums(tokens, 1, 4)
              const duration = numFlag(tokens, '--duration', 300)
              if (!a || duration === null) { out('用法：swipe <x1> <y1> <x2> <y2> [--duration ms] [--via "x,y;x,y"]'); break }
              /* --via：中途路径点。走的是 touch_down→逐点 touch_move→touch_up —— **一条笔画画折线**，
               * 中途不抬手。连线/谱曲/拖拽排序这类玩法要的正是这个；只有两端点时走原生 post_swipe。 */
              const viaRaw = readFlag(tokens, '--via')
              let via: number[][] | undefined
              if (viaRaw) {
                via = viaRaw.split(';').map((s) => s.split(',').map((x) => Number(x)))
                if (via.some((p) => p.length !== 2 || p.some((n) => !Number.isFinite(n)))) {
                  out('--via 每段要 2 个数字（x,y），段间用 ; 分隔')
                  break
                }
              }
              out(short(await act.input(client, {
                kind: 'swipe', x1: a[0], y1: a[1], x2: a[2], y2: a[3], duration,
                ...(via ? { via } : {}),
              })))
              break
            }
            case 'touchdown': {
              const a = nums(tokens, 1, 2)
              if (!a) { out('用法：touchdown <x> <y>'); break }
              out(short(await act.input(client, { kind: 'touch_down', x: a[0], y: a[1] })))
              break
            }
            case 'touchmove': {
              const a = nums(tokens, 1, 2)
              if (!a) { out('用法：touchmove <x> <y>'); break }
              out(short(await act.input(client, { kind: 'touch_move', x: a[0], y: a[1] })))
              break
            }
            case 'touchup':
              out(short(await act.input(client, { kind: 'touch_up' })))
              break
            case 'key': {
              const a = nums(tokens, 1, 1)
              if (!a) { out('用法：key <code>（Android KeyEvent 码：3=Home、4=返回）'); break }
              out(short(await act.input(client, { kind: 'key', code: a[0] })))
              break
            }
            case 'keys': {
              /* 键码只保留正整数：与 CLI/daemon 同一条口径，空集合直接报用法 */
              const codes = String(tokens[1] ?? '').split(/[+,]/)
                .map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
              if (!codes.length) { out('用法：keys <code[,code+...]>（至少一个正整数键码，如 17,67）'); break }
              out(short(await act.input(client, { kind: 'keys', codes })))
              break
            }
            case 'press': {
              const a = nums(tokens, 1, 2)
              const duration = numFlag(tokens, '--duration', 800)
              if (!a || duration === null) { out('用法：press <x> <y> [--duration ms]'); break }
              out(short(await act.input(client, { kind: 'press', x: a[0], y: a[1], duration })))
              break
            }
            case 'dbclick': {
              const a = nums(tokens, 1, 2)
              if (!a) { out('用法：dbclick <x> <y>'); break }
              out(short(await act.input(client, { kind: 'dbclick', x: a[0], y: a[1] })))
              break
            }
            case 'scroll': {
              const a = nums(tokens, 1, 2)
              if (!a) { out('用法：scroll <dx> <dy>（建议 120 的倍数）'); break }
              out(short(await act.input(client, { kind: 'scroll', dx: a[0], dy: a[1] })))
              break
            }
            case 'move': {
              const a = nums(tokens, 1, 2)
              if (!a) { out('用法：move <dx> <dy>'); break }
              out(short(await act.input(client, { kind: 'move', dx: a[0], dy: a[1] })))
              break
            }
            case 'text':
              out(short(await act.input(client, { kind: 'text', text: line.trim().slice(5) })))
              break
            case 'reco': {
              const type = tokens[1] ?? 'TemplateMatch'
              const param = recoParam(tokens)
              const sweepRaw = readFlag(tokens, '--sweep')
              /* 资源目录：--resource-dir 优先，其次 connect project 规划出的第一个资源路径
               * （与 crop / annotate 同规则）。缺了它 daemon 只会给出零例数（模板/OCR 模型
               * 都读不到）——这是 G16 证据里 `[]` 与 `ok:false` 两种签名并存的第三个混淆变量，
               * 所以**前置拦下并说清**，不再让它静默。 */
              const planRes = state.plan?.resource?.paths
              const resourceDir = readFlag(tokens, '--resource-dir') ?? planRes?.[0] ?? ''
              if (resourceDir === '') {
                out('缺资源目录：reco 的模板/OCR 模型要靠它加载，不给只会得到零例数（看不出病因）。'
                  + '先给 --resource-dir <dir>，或 connect project <dir>')
                break
              }
              /* --image / --seq / --from-kf：图像来源三条与一次性 CLI 一致，由 daemon 按
               * 「kfSource → image → 缓冲帧」的次序取（`--image` 优先于 `--seq`，不另行报错——
               * 那会再造一套 repl/CLI 规则差）。 */
              const imageRaw = readFlag(tokens, '--image')
              const seqRaw = readFlag(tokens, '--seq')
              const kfId = readFlag(tokens, '--from-kf') ?? (imageRaw?.startsWith('kf:') ? imageRaw : undefined)
              let kfSource: act.CropKfSource | undefined
              if (kfId) {
                const k = kfSourceFrom(kfId, tokens)
                if (k.error) { out(k.error); break }
                kfSource = k.source
              }
              const seqNum = seqRaw === undefined ? undefined : Number(seqRaw)
              if (seqRaw !== undefined && !Number.isFinite(seqNum)) {
                out('--seq 必须是数字（收到 ' + JSON.stringify(seqRaw) + '）')
                break
              }
              const r = await act.recoTest(client, {
                resourceDir, type, param,
                ...(imageRaw && !kfId ? { image: imageRaw } : {}),
                ...(seqNum !== undefined ? { seq: seqNum } : {}),
                ...(kfSource ? { kfSource } : {}),
                ...(sweepRaw ? { sweep: JSON.parse(sweepRaw) } : {}),
              })
              /* roi 越界：repl 没有单命令退出码（末行统一 EXIT.OK），照本文件既有惯例
               * 「打印显式错误 + break」；一次性 CLI 侧同一判据走 EXIT.FINDINGS。 */
              const meta = r.meta as { w?: unknown; h?: unknown } | undefined
              const oob = roiOutOfBounds(typeof param.roi === 'object' ? (param.roi as number[]) : undefined, meta?.w, meta?.h)
              if (oob) { out(oob); break }
              out(short(r, 800))
              break
            }
            case 'kf': {
              const sub = tokens[1] ?? 'status'
              if (sub === 'status') {
                out(short(await act.l0Status(client), 600))
              } else if (sub === 'promote') {
                const what = tokens[2]
                const note = readFlag(tokens, '--note')
                const r = await act.kfPromote(client, /^\d+$/.test(String(what))
                  ? { seq: Number(what), ...(note ? { note } : {}) }
                  : { latest: true, ...(note ? { note } : {}) })
                if (r.ok === false) out('升格失败：' + String(r.error))
                else out('已升格 ' + String(r.id) + ' → ' + String(r.path) + (r.idempotent ? '（幂等重试）' : ''))
              } else if (sub === 'list') {
                const { manifest, error } = loadManifest(defaultFramesDir())
                if (error) { out('库不可读：' + error); break }
                if (!manifest) { out('关键帧库尚无留存'); break }
                out('关键帧库 ' + manifest.frames.length + ' 条（libraryId ' + manifest.libraryId + '）')
                for (const f of manifest.frames) out('  ' + describeRecord(f))
              } else if (sub === 'resolve') {
                const r = resolveFrame(defaultFramesDir(), String(tokens[2] ?? ''))
                out(r.status + (r.reason ? '（' + r.reason + '）' : '') + (r.path ? '  ' + r.path : ''))
              } else {
                out('用法：kf status | kf promote [seq|latest] [--note s] | kf list | kf resolve <kf:...>')
              }
              break
            }
            default:
              out('未知命令：' + head
                + (suggestHead(head) ? '（是想输入 ' + String(suggestHead(head)) + ' 吗？）' : '')
                + '（输入 help 看命令表）')
    }
  } catch (e) {
    if (e instanceof SessionError) out('会话错误 [' + e.code + ']：' + e.message)
    else out('错误：' + (e instanceof Error ? e.message : String(e)))
  }
  return 'continue'
}

/* ─────────────────── 命名常驻会话（`--session <name>`）─────────────────── */

/** 调用侧：复用已存在的会话，或首次起一个再送命令。 */
async function runNamedSession(name: string, ctx: CommandContext): Promise<CommandResult> {
  const wantStatus = ctx.values['session-status'] === true
  const wantStop = ctx.values['session-stop'] === true

  /* 命令收集：**只认 `--cmd`**。
   *
   * 为什么不用裸位置参数：位置参数会先被 repl 自己的选项表解析，于是
   *   `repl --session cc run X --timeout 0`
   * 里的 `--timeout` 被当成 repl 的选项直接 BAD_ARGUMENTS 拒掉。而绕开的写法
   * （整条命令加引号）是个"必须记住"的坑，且退化形态更危险——实测
   *   `repl --session cc screencap out.png`
   * 里的位置参数被当成**两条命令**：`screencap`（用默认路径真截了一张、丢掉结果）
   * + `out.png`（报未知命令），也就是**静默执行了错误的动作**。
   * 所以这里只收 `--cmd`（可重复），并把裸位置参数当成明确的用法错误报出来，
   * 不给"看起来成功了"的歧义空间。 */
  const rawCmds = ctx.values.cmd
  const cmds: string[] = Array.isArray(rawCmds)
    ? rawCmds.filter((c): c is string => typeof c === 'string')
    : typeof rawCmds === 'string' ? [rawCmds] : []
  if (ctx.positionals.length) {
    return fail('BAD_ARGUMENTS',
      '命名会话的命令要用 --cmd 传（收到位置参数 ' + JSON.stringify(ctx.positionals) + '）',
      '例：maafw-live repl --session ' + name + ' --cmd "run X --timeout 0"\n' +
      '       位置参数不加 --cmd 时会被当成多条独立命令（`screencap out.png` 会被拆成两条），\n' +
      '       所以这里直接拒掉，不猜你的意图',
      EXIT.USAGE)
  }

  if (wantStop) {
    const meta = readSessionMeta(name)
    if (!meta) return { exitCode: EXIT.OK, human: ['会话 ' + name + ' 不存在（无需收）'], data: { name, existed: false } }
    stopSession(name)
    return { exitCode: EXIT.OK, human: ['已收掉会话 ' + name + '（pid ' + meta.pid + '）'], data: { name, pid: meta.pid } }
  }

  const existing = readSessionMeta(name)
  if (wantStatus) {
    if (!existing) return { exitCode: EXIT.OK, human: ['会话 ' + name + '：不存在'], data: { name, exists: false } }
    const alive = pidAlive(existing.pid)
    return {
      exitCode: EXIT.OK,
      human: [
        '会话 ' + name + '：' + (alive ? '在跑' : '**已死**（meta 还在，但进程没了——用 --session-stop 清掉重起）'),
        '  pid ' + existing.pid + '，起于 ' + existing.startedAt,
        '  管道 ' + existing.pipe,
        '  连接参数 ' + JSON.stringify(existing.connectArgs),
      ],
      data: { ...existing, alive },
    }
  }

  /* 起会话：把本次的连接参数原样交给常驻进程（同一套 CLI 旗标，不另造参数面） */
  let meta = existing
  if (!meta || !pidAlive(meta.pid)) {
    if (meta) stopSession(name)
    const connectArgs: Record<string, unknown> = {}
    for (const k of ['project', 'controller', 'resource', 'hwnd', 'address', 'kind', 'target']) {
      const v = ctx.values[k]
      if (typeof v === 'string') connectArgs[k] = v
    }
    meta = spawnSessionServer(name, process.argv[1] ?? '', connectArgs)
    const ready = await waitPipeReady(meta.pipe, 20000)
    if (!ready) {
      stopSession(name)
      return fail('SESSION_NOT_READY',
        '会话 ' + name + ' 起了但管道 ' + meta.pipe + ' 20s 内不可连（常驻进程可能启动即失败）',
        '检查连接参数是否正确；必要时用 --session-stop ' + name + ' 清掉再试', EXIT.FINDINGS)
    }
  }

  /* 不带 --cmd = 交互式：把本进程的 stdin 逐行送进常驻会话，输出照原样打印。
   * 这样 `repl --session x` 的手感与普通 repl 一致，但连接状态跨调用保持。 */
  if (!cmds.length) {
    const rl = readline.createInterface({ input: process.stdin, terminal: process.stdin.isTTY === true })
    const lines: string[] = []
    let wake: (() => void) | null = null
    let ended = false
    rl.on('line', (l: string) => { lines.push(l); if (wake) { const w = wake; wake = null; w() } })
    rl.on('close', () => { ended = true; if (wake) { const w = wake; wake = null; w() } })
    const ask = async (): Promise<string | null> => {
      for (;;) {
        if (lines.length) return lines.shift() ?? null
        if (ended) return null
        await new Promise<void>((r) => { wake = r })
      }
    }
    try {
      for (;;) {
        if (process.stdin.isTTY) process.stdout.write('maa[' + name + ']> ')
        const l = await ask()
        if (l === null) break
        if (!l.trim()) continue
        const rep = await sendToSession(meta, l, 600000)
        for (const o of rep.lines) process.stdout.write(o + '\n')
        if (rep.error) process.stdout.write('错误：' + rep.error + '\n')
        if (rep.closing || /^(quit|exit)\s*$/i.test(l.trim())) break
      }
    } finally {
      rl.close()
    }
    return { exitCode: EXIT.OK, human: ['会话 ' + name + ' 保持运行（用 --session-stop ' + name + ' 收掉）'], data: { name, pid: meta.pid } }
  }

  /* 带 --cmd：逐条串行送进会话，把回执按序打印。任一条 quit/exit 就结束会话。 */
  const human: string[] = []
  let exitCode: ExitCode = EXIT.OK
  for (const cmd of cmds) {
    const rep = await sendToSession(meta, cmd, 600000)
    human.push(...rep.lines)
    if (rep.error) {
      human.push('错误：' + rep.error)
      exitCode = EXIT.FAIL
    }
    if (rep.closing || /^(quit|exit)\s*$/i.test(cmd.trim())) {
      stopSession(name)
      break
    }
  }
  return { exitCode, human, data: { name, pid: meta.pid } }
}

/** 常驻侧：从命名管道收命令，交给与交互式 repl 同一份 `runReplLine` 执行。 */
async function runSessionServer(name: string, ctx: CommandContext): Promise<CommandResult> {
  const client = spawnDaemon()
  const state: { session: string; plan: SessionState['plan'] | null } = { session: '(未连接)', plan: null }
  const remember = (s: SessionState): void => {
    state.session = String((s.session as { target?: unknown } | null)?.target ?? '(已连接)')
    state.plan = s.plan ?? null
  }

  const server = new SessionServer((line, reply) => {
    void runReplLine(line, { client, out: (l) => server.pushOutput(l), state, remember })
      .then((step) => {
        reply({ ok: true, lines: [], ...(step === 'quit' ? { closing: true } : {}) })
        if (step === 'quit') {
          /* 收尾延后一拍：先把回执写出去，调用方才能读到"会话已结束"而不是连接被掐 */
          setTimeout(() => {
            server.close()
            try { client.close() } catch { /* ignore */ }
            process.exit(0)
          }, 150)
        }
      })
      .catch((e) => reply({ ok: false, lines: [], error: e instanceof Error ? e.message : String(e) }))
  })

  /* 先建连接、再 listen：反过来的话命令可能在 `ensureSession` 完成**之前**到达，
   * 那条命令会跑在一个还没连接的会话上（表现为"第一条命令报未连接，第二条才好"）。
   * 而调用侧有 `waitPipeReady` 轮询，所以推迟 listen 不会让它空等——
   * 它只是在管道就绪前一直重试，拿到的一定是连接完成的会话。 */
  const o: SessionOptions = sessionOptions(ctx.values)
  const startup: string[] = []
  if (o.project || o.kind) {
    try {
      const s = await ensureSession(client, o)
      remember(s)
      startup.push('已连接：' + state.session)
    } catch (e) {
      startup.push('连接失败：' + (e instanceof Error ? e.message : String(e)))
    }
  } else {
    startup.push('未连接设备。先 connect project <dir> 或 connect win32 <target>。')
  }

  const pipe = sessionPipePath(name)
  try {
    await server.listen(pipe)
  } catch (e) {
    try { client.close() } catch { /* ignore */ }
    return fail('SESSION_PIPE_FAILED', '命名管道 ' + pipe + ' 监听失败：' + (e instanceof Error ? e.message : String(e)),
      '同名会话可能已在跑；用 --session-status ' + name + ' 查，或 --session-stop ' + name + ' 收掉', EXIT.FINDINGS)
  }
  /* 横幅在 listen 之后入待认领队列：它在第一条命令的回执里出现，与交互式 repl 的"先报连接"一致 */
  for (const l of startup) server.pushStartup(l)

  /* 常驻：等管道上的命令，直到收到 quit/exit 或父侧 stopSession 把进程杀掉 */
  await new Promise<void>(() => { /* 永不 resolve；退出走上面的 process.exit 或外部 kill */ })
  return { exitCode: EXIT.OK, human: [] }
}
