/**
 * maafw-live CLI 入口：解析 → 分发 → 输出。
 *
 * 入口只做四件事，任何领域逻辑都不许放进来：
 *  1. 处理无命令 / --help / --version 这类不进入命令的路径
 *  2. 合并全局选项与命令选项并解析
 *  3. 解析并校验 cwd
 *  4. 执行命令、输出结果、返回退出码
 *
 * 未预期异常一律兜成 FAIL 信封——技能拿到的必须是结构化的错误，
 * 而不是一段堆栈（堆栈会直接灌进模型上下文）。
 */
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { findCommand, suggestCommand } from './commands/index.js'
import { GLOBAL_OPTIONS, readGlobalFlags } from './flags.js'
import { cliPackage } from './pkg.js'
import { EXIT, emit, fail, type CommandResult } from './protocol.js'
import { commandUsage, topLevelUsage } from './usage.js'

function print(lines: string[], toStderr = false): void {
  const text = lines.join('\n') + '\n'
  if (toStderr) process.stderr.write(text)
  else process.stdout.write(text)
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function main(argv: string[]): Promise<number> {
  const head = argv[0]

  // 不进入命令的路径
  if (head === undefined || head === 'help') {
    const topic = argv[1]
    if (topic) {
      const cmd = findCommand(topic)
      if (cmd) {
        print(commandUsage(cmd))
        return EXIT.OK
      }
      print([`未知命令：${topic}`], true)
      print(topLevelUsage(), true)
      return EXIT.USAGE
    }
    print(topLevelUsage())
    return head === undefined ? EXIT.USAGE : EXIT.OK
  }

  if (head === '--version' || head === '-V') {
    const pkg = cliPackage()
    print([`${pkg.name} ${pkg.version}`])
    return EXIT.OK
  }

  if (head === '--help' || head === '-h') {
    print(topLevelUsage())
    return EXIT.OK
  }

  const cmd = findCommand(head)
  if (!cmd) {
    const suggestion = suggestCommand(head)
    const result: CommandResult = {
      exitCode: EXIT.USAGE,
      error: {
        code: 'UNKNOWN_COMMAND',
        message: `未知命令：${head}`,
        ...(suggestion ? { hint: `是否想执行 ${cliPackage().name} ${suggestion}？` } : {}),
      },
    }
    emit(head, result, { json: argv.includes('--json'), color: false })
    if (!argv.includes('--json')) print(topLevelUsage(), true)
    return EXIT.USAGE
  }

  // 解析选项：全局 + 命令私有
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
    const result = fail('BAD_ARGUMENTS', message(e), `用法：${cmd.usage}`, EXIT.USAGE)
    emit(cmd.name, result, { json: argv.includes('--json'), color: false })
    return EXIT.USAGE
  }

  // cwd 先解析，因为 --json 之外的所有输出都要用到它
  let cwd = process.cwd()
  if (typeof parsed.values.cwd === 'string' && parsed.values.cwd !== '') {
    cwd = resolve(parsed.values.cwd)
  }

  const flags = readGlobalFlags(parsed.values, cwd)

  if (flags.help) {
    print(commandUsage(cmd))
    return EXIT.OK
  }

  if (!isDirectory(cwd)) {
    const result = fail('CWD_NOT_FOUND', `工作目录不存在：${cwd}`, '用 --cwd 指定一个存在的目录', EXIT.ENV)
    emit(cmd.name, result, { json: flags.json, color: flags.color })
    return EXIT.ENV
  }

  let result: CommandResult
  try {
    result = await cmd.run({ positionals: parsed.positionals, values: parsed.values, flags, cwd })
  } catch (e) {
    result = fail(
      'UNEXPECTED',
      message(e),
      '这是未预期异常，请把 --json 输出一并反馈',
      EXIT.FAIL,
    )
  }

  emit(cmd.name, result, { json: flags.json, color: flags.color })
  return result.exitCode
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/* 允许 `node lib/index.js` 直接运行（bin/maafw-live.mjs 是常规入口） */
const directRun = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
})()

if (directRun) {
  process.exitCode = await main(process.argv.slice(2))
}
