/**
 * CLI 协议层：统一 JSON 信封 + 命令契约 + 退出码语义。
 *
 * 信封结构抄 create-maa-project 的 `--report`——它已被真实消费方验证过，
 * 属于本生态的既有事实标准。目的：让「技能 / 脚本 / CI / 人」消费同一份稳定结构，
 * 不必各自解析文本输出，也不必各自发明字段名。
 *
 * 注意（这是本文件的唯一不变量）：信封字段只增不改。技能会按字段名读取，
 * 改名等于静默破坏所有消费方。
 */
import type { ParseArgsOptionsConfig } from 'node:util'
import type { GlobalFlags } from './flags.js'

/** 信封结构版本。字段增删时递增，消费方可据此拒绝不认识的形状。 */
export const SCHEMA_VERSION = 1

/**
 * 退出码语义。
 *
 * 关键区分：`FAIL` 是「命令没跑成」，`FINDINGS` 是「跑成了，但发现了问题」。
 * 技能与 CI 必须能分开这两种情况——reco 识别未命中不是执行失败，
 * 但也不该返回 0 让调用方以为一切正常。
 */
export const EXIT = {
  /** 命令正常完成，未发现问题 */
  OK: 0,
  /** 命令自身失败（未预期异常、IO 错误） */
  FAIL: 1,
  /** 参数 / 用法错误 */
  USAGE: 2,
  /** 命令正常跑完，但发现了问题（reco 未命中、run 调用级失败、观测类命令的警告等） */
  FINDINGS: 3,
  /** 前置环境缺失（缺 maa-node / 缺 checkout / 缺设备） */
  ENV: 4,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export interface CliError {
  message: string
  /** 稳定的机器可读标识，供技能分支判断；不要用 message 做判断 */
  code: string
  hint?: string
}

export interface Envelope {
  schemaVersion: number
  command: string
  /** 命令本身是否执行成功。FINDINGS 仍算 ok=true——它跑成了，只是有发现 */
  ok: boolean
  exitCode: number
  /** 本次操作的项目根，无法确定时为 null */
  root: string | null
  written: string[]
  removed: string[]
  skipped: string[]
  /** 需要人工跟进的事项（如「先跑 maa project sync」） */
  pending: string[]
  suggestedCommands: string[]
  warnings: string[]
  /** 命令特定载荷 */
  data: unknown
  error: CliError | null
}

/** 命令返回的结果。信封字段在此给默认值，命令只填关心的部分。 */
export interface CommandResult {
  exitCode: ExitCode
  data?: unknown
  /** 非 --json 时逐行打印的内容。命令自己决定怎么排版 */
  human?: string[]
  warnings?: string[]
  written?: string[]
  removed?: string[]
  skipped?: string[]
  pending?: string[]
  suggestedCommands?: string[]
  error?: CliError
  root?: string | null
}

export interface CommandContext {
  /** 命令名之后的位置参数 */
  positionals: string[]
  /** 已解析的全部选项（含全局选项） */
  values: Record<string, unknown>
  flags: GlobalFlags
  /** 已解析并校验过存在性的工作目录（绝对路径） */
  cwd: string
}

export interface Command {
  name: string
  /** 一行说明，用于顶层 help 列表 */
  summary: string
  /** 完整用法行，如 `maafw-live env [--deep] [--maafw <dir>]` */
  usage: string
  /** 命令私有选项；全局选项由入口自动合并 */
  options?: ParseArgsOptionsConfig
  run(ctx: CommandContext): Promise<CommandResult>
}

export function toEnvelope(command: string, r: CommandResult): Envelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    ok: r.exitCode === EXIT.OK || r.exitCode === EXIT.FINDINGS,
    exitCode: r.exitCode,
    root: r.root ?? null,
    written: r.written ?? [],
    removed: r.removed ?? [],
    skipped: r.skipped ?? [],
    pending: r.pending ?? [],
    suggestedCommands: r.suggestedCommands ?? [],
    warnings: r.warnings ?? [],
    data: r.data ?? null,
    error: r.error ?? null,
  }
}

/* ─────────────────────────── 输出 ─────────────────────────── */

export interface EmitOptions {
  json: boolean
  color: boolean
}

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
  cyan: '\u001b[36m',
}

function paint(text: string, code: string, on: boolean): string {
  return on ? code + text + ANSI.reset : text
}

/**
 * 输出命令结果。
 *
 * --json 时只输出信封（stdout 保持纯 JSON，可被管道解析）；
 * 否则输出命令自己的 human 渲染 + 警告 + 建议命令。
 * 错误与警告一律走 stderr，避免污染 stdout 的 JSON。
 */
export function emit(command: string, r: CommandResult, o: EmitOptions): void {
  if (o.json) {
    process.stdout.write(JSON.stringify(toEnvelope(command, r), null, 2) + '\n')
    return
  }

  for (const line of r.human ?? []) process.stdout.write(line + '\n')

  for (const w of r.warnings ?? []) {
    process.stderr.write(paint('warning: ', ANSI.yellow, o.color) + w + '\n')
  }

  if (r.error) {
    process.stderr.write(
      paint('error: ', ANSI.red, o.color) + r.error.message +
        paint(' [' + r.error.code + ']', ANSI.dim, o.color) + '\n',
    )
    if (r.error.hint) {
      process.stderr.write(paint('  hint: ' + r.error.hint, ANSI.dim, o.color) + '\n')
    }
  }

  if (r.pending?.length) {
    process.stdout.write('\n待办：\n')
    for (const p of r.pending) process.stdout.write('  - ' + p + '\n')
  }

  if (r.suggestedCommands?.length) {
    process.stdout.write('\n建议下一步：\n')
    for (const c of r.suggestedCommands) {
      process.stdout.write('  ' + paint(c, ANSI.cyan, o.color) + '\n')
    }
  }
}

/** 失败结果的快捷构造 */
export function fail(code: string, message: string, hint?: string, exitCode: ExitCode = EXIT.FAIL): CommandResult {
  return { exitCode, error: { code, message, ...(hint ? { hint } : {}) } }
}
