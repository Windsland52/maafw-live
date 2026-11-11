/**
 * 命令分发的唯一实现：argv → CommandResult。
 *
 * 为什么单列一个模块：一次性 CLI（index.ts）与命名会话常驻进程（repl --session-serve）
 * 必须把 argv 走**同一条**解析→闸门→run 路径——会话里再写一份 switch 就必然漂移
 *（设计审查 P0-3：REPL 的 connect project 选不了 controller、run 不吃 --option，就是这么来的）。
 *
 * 与入口（index.ts main）的分工：这里只做"argv 落到哪个命令、给它什么 ctx、拿回什么结果"；
 * 顶层 help/version/建议、--session 转发、emit 输出是入口的事，不在这里。
 */
import { parseArgs } from 'node:util'
import { statSync } from 'node:fs'
import type { DaemonClient } from '../client/daemon.js'
import { GLOBAL_OPTIONS, readGlobalFlags, type GlobalFlags } from '../flags.js'
import { EXIT, fail, type Command, type CommandContext, type CommandResult } from '../protocol.js'

/* 命令注册表延迟 import：commands/index 会把全部命令模块求值一遍（含 repl.ts——
 * 而 repl.ts 又 import 本模块）。顶层静态 import 就是"谁先进来谁炸"的循环
 * （Cannot access before initialization）。函数体里第一次调用时才加载注册表，
 * 此时模块图早已稳定；同一条 import 只付一次。 */
let registryPromise: Promise<typeof import('./index.js')> | null = null
function registry(): Promise<typeof import('./index.js')> {
  registryPromise ??= import('./index.js')
  return registryPromise
}

export interface DispatchEnv {
  /** 复用既有 daemon（命名会话 / REPL 注入）；一次性路径留空，由 withDaemon 现起现关。 */
  client?: DaemonClient
  /** 命令看到的工作目录（一次性 CLI 是 --cwd 解析结果；会话侧是 serve 进程的 cwd） */
  cwd: string
}

export interface DispatchOutcome {
  cmd: Command | null
  /** emit 需要的全局旗标（--json / --color 也在这里解析过） */
  flags: GlobalFlags
  result: CommandResult
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 分发一条 argv（含命令名，即 `argv[0]` 是命令名）。
 * 永不抛异常：BAD_ARGUMENTS / UNKNOWN_COMMAND / SESSION_REQUIRED / UNEXPECTED 都收敛成
 * CommandResult——会话常驻进程不能因为一条坏命令挂掉。
 */
export async function dispatchArgv(argv: string[], env: DispatchEnv): Promise<DispatchOutcome> {
  const { findCommand, suggestCommand } = await registry()
  const head = argv[0] ?? ''
  const cmd = findCommand(head)
  if (!cmd) {
    const suggestion = suggestCommand(head)
    return {
      cmd: null,
      flags: readGlobalFlags({}, env.cwd),
      result: {
        exitCode: EXIT.USAGE,
        error: {
          code: 'UNKNOWN_COMMAND',
          message: `未知命令：${head}`,
          ...(suggestion ? { hint: `是否想执行 ${suggestion}？` } : {}),
        },
      },
    }
  }

  const options = { ...GLOBAL_OPTIONS, ...(cmd.options ?? {}) }
  let parsed: { values: Record<string, unknown>; positionals: string[] }
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      options,
      allowPositionals: true,
      strict: true,
    }) as { values: Record<string, unknown>; positionals: string[] }
  } catch (e) {
    return { cmd, flags: readGlobalFlags({}, env.cwd), result: fail('BAD_ARGUMENTS', message(e), `用法：${cmd.usage}`, EXIT.USAGE) }
  }

  const flags = readGlobalFlags(parsed.values, env.cwd)

  /* 预留旗标没有消费者：传了就退 2 而不是静默吞掉——"以为在试跑其实已经落盘"
   * 是 agent 最坏的失败模式。`--limit`/`--verbose` 例外：events 自己消费同名列；
   * verbose 已接 describeSession 的 note 行门控。 */
  const unimpl: string[] = []
  if (flags.dryRun) unimpl.push('--dry-run')
  if (parsed.values.limit !== undefined && !(cmd.options && 'limit' in cmd.options)) unimpl.push('--limit')
  if (unimpl.length > 0) {
    return {
      cmd, flags,
      result: fail(
        'FLAG_NOT_IMPLEMENTED',
        `未实现的旗标：${unimpl.join(' ')}（接受但不生效是最坏的失败模式，所以直接报错）`,
        '要"只校验不落盘"用 validate；要截断输出用命令自己的分页参数',
        EXIT.USAGE,
      ),
    }
  }

  if (flags.help) {
    /* usage.ts 也 import commands/index（顶层 usage 列表）：同一条环，同样延迟到
     * 真用到才求值（只有 --help 才需要）。 */
    const { commandUsage } = await import('../usage.js')
    return { cmd, flags, result: { exitCode: EXIT.OK, human: commandUsage(cmd) } }
  }

  const ctx: CommandContext = {
    positionals: parsed.positionals,
    values: parsed.values,
    flags,
    cwd: env.cwd,
    ...(env.client ? { client: env.client } : {}),
  }

  /* requiresSession 闸门：一次性形态（env.client 为空）下跑的是刚起的空 daemon，
   * 这类命令只能给出假信号（stop 停空 daemon 回 ok、frame get 恒 NO_FRAME）——
   * 退 2 + 指路，比"看起来成功了"安全得多。会话内（env.client 已注入）天然放行。 */
  const needsSession =
    !env.client &&
    (typeof cmd.requiresSession === 'function' ? cmd.requiresSession(ctx) : cmd.requiresSession === true)
  if (needsSession) {
    return {
      cmd, flags,
      result: fail(
        'SESSION_REQUIRED',
        cmd.name + ' 需要会话态（一次性命令的 daemon 用完即关，这条命令依赖的会话内状态不存在）',
        '先起会话：maafw-live repl --session <name> --project <dir>，然后 ' + cmd.name + ' --session <name>（或直接在 REPL 里用）',
        EXIT.USAGE,
      ),
    }
  }

  try {
    return { cmd, flags, result: await cmd.run(ctx) }
  } catch (e) {
    return {
      cmd, flags,
      result: fail('UNEXPECTED', message(e), '这是未预期异常，请把 --json 输出一并反馈', EXIT.FAIL),
    }
  }
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
