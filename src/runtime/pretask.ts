/**
 * pretask：连接 Controller **之前**跑一次的子进程（PI v2.7.0+，过滤字段 v2.8.1）。
 *
 * 契约（MaaFW 5.14.2 `3.3-ProjectInterfaceV2协议`，pinned commit 8061d5bc）：
 * - 命令行 = `exec` + `args[]` + 可选末位 JSON（只有 `option` 非空时才追加）；
 * - 那个 JSON 是**单行紧凑**字符串，作为**单个 argv 元素**传递，值为 OptionValue
 *   （select/switch → `case.name`；checkbox → `case.name` 数组；input → `{字段: 值}`）；
 * - 按声明序串行、等它结束，CWD = interface.json 所在目录；
 * - **非零退出即中止本次启动**——任务根本不开始。
 *
 * 协议没规定、由本工具定的三处（写在这里，免得下一个人重新猜）：
 * 1. 声明了 `controller` / `resource` 过滤且当前不适用时**跳过并说明**。协议只说 Client
 *    可以隐藏/置灰，不保证跳过执行；但"启动模拟器"这类命令跑错控制器代价更大。
 * 2. 末位 JSON **不用 preset**：pretask 发生在任务选择之前，而 preset 是按任务的快照。
 *    这里只吃 CLI `--option` 与声明里的初始值（`default_case` / `inputs[].default`）。
 * 3. 超时协议没规定，本工具定 120s（`MAAFW_PRETASK_TIMEOUT_MS` 覆盖；<=0 关超时）：
 *    "启动模拟器"挂成死等时不能靠调用方 Ctrl-C 收摊（设计审查 P0-2）。超时杀的是
 *    **进程树**（Windows taskkill /T）——pretask 拉起模拟器的链式脚本只杀头部会留孙代。
 */
import { spawn, spawnSync } from 'node:child_process'
import type { InterfacePretask, LoadedInterface } from '../interface/load.js'
import { resolveOptionValue, type OptionValueCtx } from '../interface/override.js'

/** 子进程输出只留尾部：够归因，不会把大日志塞进上下文。 */
const TAIL_LIMIT = 4000

export interface PretaskOutcome {
  name: string
  exec: string
  argv: string[]
  code: number | null
  signal: string | null
  ms: number
  /** stdout+stderr 尾部（失败时给人看） */
  tail: string
}

export interface PretaskResult {
  ok: boolean
  ran: PretaskOutcome[]
  /** 因过滤/缺 exec 未执行的那些（带原因） */
  skipped: string[]
  notes: string[]
  warns: string[]
  error?: { code: string; message: string; hint?: string }
}

export interface PretaskInput {
  loaded: LoadedInterface
  controllerName: string | null
  resourceName: string | null
  optionCases?: Record<string, string | string[]>
  optionFields?: Record<string, Record<string, string>>
  /** 单条 pretask 的总时限；<=0 不限时。缺省 MAAFW_PRETASK_TIMEOUT_MS → 120s。 */
  timeoutMs?: number
}

/**
 * 拼一条 pretask 的完整 argv（含末位 JSON）。**纯函数**：执行与参数构造分开，
 * 参数形状可以离线单测——这部分错了就是"脚本收到了奇怪的参数但没人报错"。
 */
export function buildPretaskArgv(
  p: InterfacePretask,
  loaded: LoadedInterface,
  ctx: { controllerName: string | null; resourceName: string | null; valueCtx: OptionValueCtx },
): { argv: string[]; warns: string[] } {
  const warns: string[] = []
  const json: Record<string, unknown> = {}
  for (const key of p.option) {
    const o = loaded.options[key]
    if (!o) {
      warns.push('pretask ' + (p.name ?? p.exec) + ' 引用了未定义的 option ' + key + '，未写入末位 JSON')
      continue
    }
    /* 适用性过滤：不满足当前 controller / resource 的 option 不进这个对象 */
    if (o.controller?.length && ctx.controllerName && !o.controller.includes(ctx.controllerName)) continue
    if (o.resource?.length && ctx.resourceName && !o.resource.includes(ctx.resourceName)) continue
    const v = resolveOptionValue(o, ctx.valueCtx)
    if (!v) continue
    if (v.kind === 'fields') {
      json[key] = v.fields
      continue
    }
    /* case 型取值要校验：写一个不存在的 case 名进 JSON，脚本会按错的配置跑而不报错 */
    const known = o.type === 'checkbox' ? v.cases : [v.cases[0]]
    const bad = known.filter((c) => !o.cases.some((x) => x.name === c))
    if (bad.length) {
      warns.push('pretask ' + (p.name ?? p.exec) + ' 的 option ' + key + ' 取值 ' + bad.join(' / ') + ' 不是已声明的 case，未写入末位 JSON')
      continue
    }
    json[key] = o.type === 'checkbox' ? v.cases : v.cases[0]
  }
  const argv = [p.exec, ...p.args, ...(Object.keys(json).length ? [JSON.stringify(json)] : [])]
  return { argv, warns }
}

interface SpawnOutcome {
  code: number | null
  signal: string | null
  tail: string
  error?: string
  /** 超时树杀：与"非零退出"分开报，超时不是脚本自己的选择 */
  timedOut?: boolean
}

/** pretask 超时缺省 120s：够"启动模拟器到可连"的常态，又兜住真正挂死的脚本。 */
export const PRETASK_TIMEOUT_MS = 120000

function pretaskTimeoutMs(): number {
  const raw = process.env.MAAFW_PRETASK_TIMEOUT_MS
  if (raw === undefined) return PRETASK_TIMEOUT_MS
  const n = Number(raw)
  return Number.isFinite(n) ? n : PRETASK_TIMEOUT_MS
}

/** 进程树杀：pretask 常是"拉起模拟器"的壳脚本，只杀头部会留孙代占设备。 */
function killTree(child: { pid?: number; kill: (s?: NodeJS.Signals) => void }): void {
  const pid = child.pid
  if (pid === undefined) { try { child.kill() } catch { /* ignore */ } return }
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 5000 }) } catch { /* ignore */ }
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* ignore */ } }
}

/**
 * 执行一条 pretask；timeoutMs<=0 不限时。
 * Windows 的 .cmd/.bat 必须过 cmd.exe（CreateProcess 只认 exe；不带 shell 的 spawn 同步抛
 * EINVAL，原实现却提示"检查 PATH"——把用户往完全错的方向带）。args 逐元素传给 cmd.exe：
 * Node 会自己做 cmd 元字符转义，不经 shell:true（那个走全串拼接，空格参数必坏）。
 */
function spawnOnce(exe: string, args: string[], cwd: string | null, timeoutMs: number): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let tail = ''
    let settled = false
    const done = (r: SpawnOutcome): void => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }
    const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)
    const realExe = isBatch ? 'cmd.exe' : exe
    const realArgs = isBatch ? ['/d', '/s', '/c', exe, ...args] : args
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(realExe, realArgs, {
        cwd: cwd ?? undefined, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        /* POSIX 单独成组，超时才能 -pid 收整棵树；Windows 不靠 detached（它另有语义），taskkill /T 收。 */
        ...(isBatch || process.platform === 'win32' ? {} : { detached: true }),
      })
    } catch (e) {
      done({ code: null, signal: null, tail: '', error: String((e as Error).message || e) })
      return
    }
    const feed = (b: unknown): void => { tail = (tail + String(b)).slice(-TAIL_LIMIT) }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    child.on('error', (e) => done({ code: null, signal: null, tail, error: e.message }))
    child.on('exit', (code, signal) => done({ code, signal, tail }))
    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        killTree(child)
        done({ code: null, signal: null, tail, timedOut: true })
      }, timeoutMs)
      timer.unref?.()
    }
  })
}

/**
 * 按声明序执行全部适用的 pretask。任一条失败即返回 ok:false（调用方据此中止连接）。
 * 不抛异常：失败是一种结果，由调用方决定怎么呈现。
 */
export async function runPretasks(input: PretaskInput): Promise<PretaskResult> {
  const { loaded } = input
  const ran: PretaskOutcome[] = []
  const skipped: string[] = []
  const notes: string[] = []
  const warns: string[] = []
  const valueCtx: OptionValueCtx = {
    ...(input.optionCases ? { optionCases: input.optionCases } : {}),
    ...(input.optionFields ? { optionFields: input.optionFields } : {}),
  }

  for (const p of loaded.pretask ?? []) {
    const label = p.name ?? p.exec
    if (p.controller?.length && input.controllerName && !p.controller.includes(input.controllerName)) {
      skipped.push(label + '（声明只适用于控制器 ' + p.controller.join(' / ') + '）')
      continue
    }
    if (p.resource?.length && input.resourceName && !p.resource.includes(input.resourceName)) {
      skipped.push(label + '（声明只适用于资源 ' + p.resource.join(' / ') + '）')
      continue
    }
    const built = buildPretaskArgv(p, loaded, {
      controllerName: input.controllerName,
      resourceName: input.resourceName,
      valueCtx,
    })
    warns.push(...built.warns)
    const [exe, ...args] = built.argv
    const started = Date.now()
    const r = await spawnOnce(exe, args, loaded.dir, input.timeoutMs ?? pretaskTimeoutMs())
    const outcome: PretaskOutcome = {
      name: label, exec: exe, argv: built.argv, code: r.code, signal: r.signal, ms: Date.now() - started, tail: r.tail,
    }
    ran.push(outcome)
    if (r.error) {
      return {
        ok: false, ran, skipped, notes, warns,
        error: {
          code: 'PRETASK_SPAWN',
          message: 'pretask ' + label + ' 启动失败：' + r.error,
          hint: '检查 exec 是否在 PATH 里（协议的 exec 不走 shell，不能写管道/重定向）',
        },
      }
    }
    if (r.timedOut) {
      return {
        ok: false, ran, skipped, notes, warns,
        error: {
          code: 'PRETASK_TIMEOUT',
          message: 'pretask ' + label + ' 超时（' + (input.timeoutMs ?? pretaskTimeoutMs()) + 'ms）已树杀，本次启动中止',
          hint: (r.tail ? '子进程输出尾部：\n' + r.tail + '\n' : '') +
            '启动模拟器类脚本确实需要更久时，用 MAAFW_PRETASK_TIMEOUT_MS 放宽（毫秒），不是去掉超时',
        },
      }
    }
    if (r.code !== 0) {
      return {
        ok: false, ran, skipped, notes, warns,
        error: {
          code: 'PRETASK_FAILED',
          message: 'pretask ' + label + ' 以 ' + (r.signal ? '信号 ' + r.signal : '退出码 ' + r.code) +
            ' 结束，本次启动中止（PI 契约：非零退出即中止）',
          ...(r.tail ? { hint: '子进程输出尾部：\n' + r.tail } : {}),
        },
      }
    }
    notes.push('pretask 已执行：' + label + '（' + outcome.ms + 'ms）')
  }

  if (skipped.length) notes.push('跳过 ' + skipped.length + ' 条 pretask：' + skipped.join('；'))
  return { ok: true, ran, skipped, notes, warns }
}
