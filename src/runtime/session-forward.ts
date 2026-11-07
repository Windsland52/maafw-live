/**
 * `--session <name>` 转发：一次性 CLI 把 argv 送进命名会话的常驻进程执行。
 *
 * 为什么命令自己不用关心：转发发生在命令分发**之前**（index.ts 的拦截），命令拿到的
 * 是会话侧 dispatchArgv 注入 client 后跑出来的同一个 CommandResult——信封、退出码、
 * data 与直接执行同形（设计审查 P0-3 L2）。
 *
 * 死会话自愈：meta 在但 pid 已死时，用 meta.connectArgs 原样重起（连接参数在
 * 起会话时就存了），调用方不必记得这条会话当初怎么连的。
 */
import {
  pidAlive, readSessionMeta, sendToSessionExec, sessionServeLogTail,
  spawnSessionServer, stopSession, waitPipeReady,
} from './session-ipc.js'
import { EXIT, fail, type CommandResult } from '../protocol.js'

const FORWARD_TIMEOUT_MS = 600_000

/**
 * 从命令行 argv（含命令名）剥掉 `--session` 旗标本体，剩下的就是要送去会话执行的命令。
 */
export function stripSessionFlag(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--session') { i++; continue }
    if (t.startsWith('--session=')) continue
    out.push(t)
  }
  return out
}

/**
 * 转发一条命令到命名会话。返回的 CommandResult 就当作本命令的结果——
 * 调用方（index.ts）直接 emit，不再二次加工。
 */
export async function forwardToSession(name: string, argv: string[]): Promise<CommandResult> {
  let meta = readSessionMeta(name)
  if (!meta) {
    return fail(
      'SESSION_NOT_FOUND',
      `会话 '${name}' 不存在（没有 meta）`,
      `先起会话：maafw-live repl --session ${name} --project <dir>（或 --kind win32 --target <title>）`,
      EXIT.USAGE,
    )
  }
  if (!pidAlive(meta.pid)) {
    /* 死会话自愈：清掉残留后用 meta 里存的连接参数原样重起 */
    const savedArgs = meta.connectArgs
    stopSession(name)
    meta = spawnSessionServer(name, process.argv[1] ?? '', savedArgs)
    const ready = await waitPipeReady(meta.pipe, 20000)
    if (!ready) {
      const tail = sessionServeLogTail(name)
      stopSession(name)
      return fail(
        'SESSION_NOT_READY',
        `会话 '${name}' 已死且自动重起失败：管道 ${meta.pipe} 20s 内不可连`,
        (tail.length ? '常驻进程日志尾部：\n    ' + tail.join('\n    ') : '重起参数 ' + JSON.stringify(savedArgs)),
        EXIT.FAIL,
      )
    }
  }
  try {
    const rep = await sendToSessionExec(meta, argv, FORWARD_TIMEOUT_MS)
    if (rep.result) {
      /* rep.lines = 待认领输出（异步收尾、连接横幅）+ 本命令 human。直接当 human 用：
       * 比只看 result.human 多了异步尾巴，与非转发形态观感一致。 */
      if (rep.lines.length) rep.result.human = rep.lines
      return rep.result
    }
    /* exec 回执却没有 result：常驻进程版本过旧（起会话用的还是旧包），让它明说怎么修 */
    return fail(
      'SESSION_REPLY',
      `会话 '${name}' 的回执里没有结构化结果（常驻进程是旧版本起的）`,
      `maafw-live repl --session-stop ${name} 后重试`,
      EXIT.FAIL,
    )
  } catch (e) {
    return fail(
      'SESSION_IO',
      `会话 '${name}' 不可达：${e instanceof Error ? e.message : String(e)}`,
      `用 maafw-live repl --session-status ${name} 查状态；死了会自动重起`,
      EXIT.FAIL,
    )
  }
}
