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
 * 3. 不设超时：协议没有超时语义。挂住只能靠调用方中断（信号处理仍是待办）。
 */
import { spawn } from 'node:child_process'
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
}

function spawnOnce(exe: string, args: string[], cwd: string | null): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let tail = ''
    let settled = false
    const done = (r: SpawnOutcome): void => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, args, { cwd: cwd ?? undefined, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      done({ code: null, signal: null, tail: '', error: String((e as Error).message || e) })
      return
    }
    const feed = (b: unknown): void => { tail = (tail + String(b)).slice(-TAIL_LIMIT) }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    child.on('error', (e) => done({ code: null, signal: null, tail, error: e.message }))
    child.on('exit', (code, signal) => done({ code, signal, tail }))
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
    const r = await spawnOnce(exe, args, loaded.dir)
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
