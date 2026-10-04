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
import { spawnDaemon, type DaemonClient } from '../client/daemon.js'
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import * as act from '../runtime/actions.js'
import { defaultFramesDir, describeRecord, loadManifest, resolveFrame } from '../runtime/keyframes.js'
import { ensureSession, SessionError, type SessionOptions, type SessionState } from '../runtime/session.js'
import { CONNECT_OPTIONS, sessionOptions } from './runtime.js'

const HELP = [
  '命令：',
  '  probe                          自检运行时',
  '  device [all|adb|win32]         列设备',
  '  connect <win32|adb|gamepad> [target]   手动连接',
  '  connect project <dir> [hwnd|address]   按 interface.json 规划连接（推荐）',
  '  disconnect                     断开并销毁 Tasker/Controller',
  '  screencap [out.png]            截一帧落盘（同时进 L0，可升格）',
  '  stream start [--fps n] [--scale n] | stream stop | stream status',
  '  frame [seq] [--roi x,y,w,h] [--out f.png]   从环形缓冲取帧',
  '  color [--roi x,y,w,h]        探色（均值/HSV/主色，最新缓冲帧）',
  '  crop --roi x,y,w,h | --point x,y [--pad n] [--out f.png]   模板裁剪（L0 原图 + 自匹配）',
  '  annotate [--out f.png]        SoM 候选与编号回画（OCR/diff/连通域/边缘）',
  '  events [n]                     最近 n 条帧流事件（默认 10）',
  '  logs [n]                       daemon 原生 stderr 尾部（默认 20）',
  '  run <entry> [--timeout ms|0] [--override json] [--resource-dir d]   （异步执行，不阻塞提示符）',
  '  stop                           停止运行中的任务',
  '  click <x> <y> | swipe <x1> <y1> <x2> <y2> [--duration ms] | key <code> | text <string>',
  '  press <x> <y> [--duration ms] | dbclick <x> <y> | keys <c[,c+..]> | scroll <dx> <dy> | move <dx> <dy>',
  '  reco <type> [k=v ...] [--sweep json]   识别单测（用缓冲最新帧）',
  '  kf status | kf promote [seq|latest] [--note s] | kf list | kf resolve <kf:...>',
  '  help | quit',
]

/** 极简分词：空格分隔，支持 --flag value 与 key=value；text 用整行剩余内容。 */
function tokenize(line: string): string[] {
  return line.trim().split(/\s+/).filter((t) => t !== '')
}

function readFlag(tokens: string[], name: string): string | undefined {
  const i = tokens.indexOf(name)
  return i >= 0 ? tokens[i + 1] : undefined
}

function short(v: unknown, max = 400): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > max ? s.slice(0, max) + ' …' : s
}

export const replCommand: Command = {
  name: 'repl',
  summary: '交互/管道会话：连接一次，后续命令复用同一个 daemon 与设备会话',
  usage: 'maafw-live repl [--project <dir>|--kind win32|adb|gamepad [--target ...]]',
  options: { ...CONNECT_OPTIONS },

  async run(ctx): Promise<CommandResult> {
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
        const tokens = tokenize(line)
        if (!tokens.length) continue
        const head = tokens[0]
        if (head === 'quit' || head === 'exit') break
        if (head === 'help') { for (const h of HELP) out(h); continue }

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
            case 'screencap':
              out(short(await act.screencap(client, tokens[1])))
              break
            case 'stream': {
              const sub = tokens[1] ?? 'status'
              if (sub === 'start') {
                const fps = readFlag(tokens, '--fps')
                const scale = readFlag(tokens, '--scale')
                const blockThresh = readFlag(tokens, '--block-thresh')
                const changeGlobal = readFlag(tokens, '--change-global')
                out(short(await act.streamStart(client, {
                  ...(fps ? { fps: Number(fps) } : {}),
                  ...(scale ? { scale: Number(scale) } : {}),
                  ...(blockThresh ? { blockThresh: Number(blockThresh) } : {}),
                  ...(changeGlobal ? { changeGlobal: Number(changeGlobal) } : {}),
                })))
              } else if (sub === 'stop') out(short(await act.streamStop(client)))
              else out(short(await act.streamStatus(client)))
              break
            }
            case 'frame': {
              const roiRaw = readFlag(tokens, '--roi')
              const seq = tokens[1] && !tokens[1].startsWith('--') ? Number(tokens[1]) : undefined
              out(short(await act.frameGet(client, {
                ...(seq !== undefined ? { seq } : {}),
                ...(roiRaw ? { roi: roiRaw.split(',').map((x) => Number(x)) } : {}),
                ...(readFlag(tokens, '--out') ? { out: readFlag(tokens, '--out') } : {}),
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
              out(short(await act.tplCrop(client, {
                ...(roiRaw ? { roi: roiRaw.split(',').map((x) => Number(x)) } : {}),
                ...(pointRaw ? { point: pointRaw.split(',').map((x) => Number(x)) } : {}),
                ...(padRaw ? { pad: Number(padRaw) } : {}),
                ...(readFlag(tokens, '--out') ? { out: readFlag(tokens, '--out') } : {}),
                ...(state.plan?.resource?.paths.length ? { resourceDir: state.plan.resource.paths[0] } : {}),
              }), 600))
              break
            }
            case 'annotate': {
              const r = await act.annotate(client, {
                ...(readFlag(tokens, '--out') ? { out: readFlag(tokens, '--out') } : {}),
                ...(state.plan?.resource?.paths.length ? { resourceDir: state.plan.resource.paths[0] } : {}),
              })
              if (r.ok === false) { out('annotate 失败：' + String(r.error)); break }
              out('SoM ' + String(r.count) + ' 候选 → ' + String(r.out))
              for (const c of (r.candidates as Array<{ id: number; source: string; ctrl: number[]; text?: string }>) ?? []) {
                out('  #' + c.id + ' [' + c.source + '] ctrl=' + c.ctrl.join(',') + (c.text ? '  "' + c.text + '"' : ''))
              }
              break
            }
            case 'events': {
              const n = Number(tokens[1] ?? 10)
              const evs = client.events.events.slice(-n)
              out('事件 ' + evs.length + ' 条（共 ' + client.events.events.length + '）')
              for (const e of evs) out('  ' + short(e, 200))
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
              out('已提交 ' + entry + '（timeout=' + timeout + '，结果异步打印；stop 可中断）')
              act.run(client, explicitDir
                ? { resourceDir: explicitDir, entry, override, timeoutMs: timeout }
                : { resourceDirs: resDirs, entry, override, timeoutMs: timeout }, timeout)
                .then((r) => {
                  const rec = (r as { record?: { ok?: boolean } }).record
                  out('run 完成：任务级 ' + (rec ? (rec.ok ? 'ok' : 'FAIL') : '未知') + '  ' + short(r, 700))
                })
                .catch((e) => out('run 失败：' + (e instanceof Error ? e.message : String(e))))
              break
            }
            case 'stop':
              out(short(await act.runStop(client)))
              break
            case 'click':
              out(short(await act.input(client, { kind: 'click', x: Number(tokens[1]), y: Number(tokens[2]) })))
              break
            case 'swipe':
              out(short(await act.input(client, {
                kind: 'swipe',
                x1: Number(tokens[1]), y1: Number(tokens[2]),
                x2: Number(tokens[3]), y2: Number(tokens[4]),
                duration: Number(readFlag(tokens, '--duration') ?? 300),
              })))
              break
            case 'key':
              out(short(await act.input(client, { kind: 'key', code: Number(tokens[1]) })))
              break
            case 'keys':
              out(short(await act.input(client, {
                kind: 'keys',
                codes: String(tokens[1] ?? '').split(/[+,]/).map((s) => Number(s.trim())),
              })))
              break
            case 'press':
              out(short(await act.input(client, {
                kind: 'press', x: Number(tokens[1]), y: Number(tokens[2]),
                duration: Number(readFlag(tokens, '--duration') ?? 800),
              })))
              break
            case 'dbclick':
              out(short(await act.input(client, { kind: 'dbclick', x: Number(tokens[1]), y: Number(tokens[2]) })))
              break
            case 'scroll':
              out(short(await act.input(client, { kind: 'scroll', dx: Number(tokens[1]), dy: Number(tokens[2]) })))
              break
            case 'move':
              out(short(await act.input(client, { kind: 'move', dx: Number(tokens[1]), dy: Number(tokens[2]) })))
              break
            case 'text':
              out(short(await act.input(client, { kind: 'text', text: line.trim().slice(5) })))
              break
            case 'reco': {
              const type = tokens[1] ?? 'TemplateMatch'
              const param: Record<string, unknown> = {}
              for (const t of tokens.slice(2)) {
                const eq = t.indexOf('=')
                if (eq > 0) {
                  const k = t.slice(0, eq)
                  const v = t.slice(eq + 1)
                  param[k] = Number.isFinite(Number(v)) && v !== '' ? Number(v) : v
                }
              }
              const sweepRaw = readFlag(tokens, '--sweep')
              const resourceDir = readFlag(tokens, '--resource-dir') ?? ''
              out(short(await act.recoTest(client, {
                resourceDir, type, param,
                ...(sweepRaw ? { sweep: JSON.parse(sweepRaw) } : {}),
              }), 800))
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
              out('未知命令：' + head + '（输入 help）')
          }
        } catch (e) {
          if (e instanceof SessionError) out('会话错误 [' + e.code + ']：' + e.message)
          else out('错误：' + (e instanceof Error ? e.message : String(e)))
        }
      }
    } finally {
      rl.close()
      client.close()
    }

    return { exitCode: EXIT.OK, human: ['会话结束。'] }
  },
}

export function replFail(e: unknown): CommandResult {
  return fail('REPL_FAILED', e instanceof Error ? e.message : String(e))
}
