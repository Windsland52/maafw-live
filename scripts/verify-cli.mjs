#!/usr/bin/env node
/**
 * maafw-live CLI 装配级回归。
 *
 * 全部通过**真实子进程**断言，不 import 内部函数——因为技能与 CI 消费的是
 * 「stdout/stderr/退出码」这个外部契约，内部重构不该影响它，内部单测也测不到它。
 *
 * 最要紧的两条：
 *  - [4] 信封字段集必须与文档逐字一致。技能按字段名读取，改名等于静默破坏所有消费方。
 *  - [9] --json 时 stdout 必须是纯 JSON。ANSI 转义或多余提示混进去会让管道解析失败。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BIN = join(ROOT, 'bin', 'maafw-live.mjs')

/** 信封字段集：只增不改。改动此表必须同步 README 与 protocol.ts 的 SCHEMA_VERSION。 */
const ENVELOPE_KEYS = [
  'schemaVersion',
  'command',
  'ok',
  'exitCode',
  'root',
  'written',
  'removed',
  'skipped',
  'pending',
  'suggestedCommands',
  'warnings',
  'data',
  'error',
].sort()

/** 文档化的退出码集合 */
const KNOWN_EXIT_CODES = new Set([0, 1, 2, 3, 4])

const MISSING_DIR = process.platform === 'win32'
  ? 'C:/__maafw_run_definitely_missing__'
  : '/__maafw_run_definitely_missing__'

let pass = 0
let fail = 0

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    process.stdout.write(`  ok   ${name}\n`)
  } else {
    fail++
    process.stdout.write(`  FAIL ${name}${detail ? '  — ' + detail : ''}\n`)
  }
}

function runCli(args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function parseEnvelope(stdout) {
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

process.stdout.write('maafw-live CLI 装配级回归\n')

/* [1] 帮助路径 */
{
  const help = runCli(['--help'])
  check('[1] --help 退出 0', help.code === 0, `code=${help.code}`)
  check('[1] --help 列出已实现命令', help.stdout.includes('env') && help.stdout.includes('version') &&
    help.stdout.includes('timing') && help.stdout.includes('kf'))
  check('[1] --help 不再声明路线图（只描述现状）', !help.stdout.includes('路线图'))

  const bare = runCli([])
  check('[2] 无参数退出 2（用法错误）', bare.code === 2, `code=${bare.code}`)
  check('[2] 无参数仍打印用法', bare.stdout.includes('用法'))
}

/* [3] version */
{
  const v = runCli(['version'])
  check('[3] version 退出 0', v.code === 0, `code=${v.code}`)
  /* 包名可能带 scope（@owner/name），所以按 package.json 自称的名字断言，别写死字面量 */
  const selfName = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name
  const selfVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  check('[3] version 打出包名与版本号', v.stdout.includes(`${selfName} ${selfVersion}`), v.stdout.split('\n')[0])
  check('[3] version 打出命令名（scoped 包与命令名不同）', /command\s+maafw-live/.test(v.stdout), v.stdout.split('\n')[1])

  const vj = runCli(['version', '--json'])
  const e = parseEnvelope(vj.stdout)
  check('[3] version --json 可解析', e !== null)
  check('[3] version --json 带 node 版本', typeof e?.data?.node === 'string')
}

/* [4] 信封契约 */
{
  const r = runCli(['env', '--json'])
  const e = parseEnvelope(r.stdout)
  check('[4] env --json 输出可解析的 JSON', e !== null, r.stdout.slice(0, 120))

  if (e) {
    const keys = Object.keys(e).sort()
    const same = keys.length === ENVELOPE_KEYS.length && keys.every((k, i) => k === ENVELOPE_KEYS[i])
    check('[4] 信封字段集与文档逐字一致', same, `实际=${keys.join(',')}`)
    check('[4] schemaVersion 为 1', e.schemaVersion === 1, String(e.schemaVersion))
    check('[4] command 字段正确', e.command === 'env', String(e.command))
    check('[4] exitCode 在文档集合内', KNOWN_EXIT_CODES.has(e.exitCode), String(e.exitCode))
    check('[4] ok 与 exitCode 语义一致', e.ok === (e.exitCode === 0 || e.exitCode === 3), `ok=${e.ok} code=${e.exitCode}`)
    check('[4] 数组字段均为数组', ['written', 'removed', 'skipped', 'pending', 'suggestedCommands', 'warnings']
      .every((k) => Array.isArray(e[k])))
    check('[4] data 携带 runtime 探针', e.data?.runtime?.node !== undefined)
    /* 契约：应用开发者不传 --checkout 时，探针里不该出现框架源码相关项 */
    check('[4] data.framework 缺省为 null（不要求 clone 框架源码）', e.data?.framework === null)
    check('[4] data 携带工具探针', e.data?.tools?.git !== undefined)
  }

  /* 建议命令必须指向本 CLI，否则调用方会去执行不存在的命令 */
  const dev = parseEnvelope(runCli(['device', '--json']).stdout)
  const suggested = Array.isArray(dev?.suggestedCommands) ? dev.suggestedCommands : []
  check('[4] suggestedCommands 指向本 CLI', suggested.every((c) => String(c).startsWith('maafw-live')), JSON.stringify(suggested))
}

/* [5] 退出码随环境缺失变化，且 stdout 仍是纯 JSON */
{
  const r = runCli(['env', '--json'])
  const e = parseEnvelope(r.stdout)
  const hasMissing = Array.isArray(e?.warnings) && e.warnings.length > 0
  check('[5] 有缺失项时退出 4（ENV）', !hasMissing || r.code === 4, `code=${r.code}`)
  check('[5] 无缺失项时退出 0', hasMissing || r.code === 0, `code=${r.code}`)
}

/* [6] 未知命令 */
{
  const r = runCli(['definitely-not-a-command'])
  check('[6] 未知命令退出 2', r.code === 2, `code=${r.code}`)
  const rj = runCli(['definitely-not-a-command', '--json'])
  const e = parseEnvelope(rj.stdout)
  check('[6] 未知命令错误码为 UNKNOWN_COMMAND', e?.error?.code === 'UNKNOWN_COMMAND', String(e?.error?.code))

  const typo = runCli(['versin'])
  check('[6] 拼错命令给出建议', typo.stderr.includes('version'), typo.stderr.split('\n')[1] ?? '')
}

/* [7] 参数错误 */
{
  const r = runCli(['env', '--no-such-flag'])
  check('[7] 未知选项退出 2', r.code === 2, `code=${r.code}`)
  const rj = runCli(['env', '--no-such-flag', '--json'])
  const e = parseEnvelope(rj.stdout)
  check('[7] 参数错误码为 BAD_ARGUMENTS', e?.error?.code === 'BAD_ARGUMENTS', String(e?.error?.code))
}

/* [8] cwd 校验 */
{
  const r = runCli(['env', '--cwd', MISSING_DIR])
  check('[8] 不存在的 cwd 退出 4', r.code === 4, `code=${r.code}`)
  const rj = runCli(['env', '--cwd', MISSING_DIR, '--json'])
  const e = parseEnvelope(rj.stdout)
  check('[8] cwd 错误码为 CWD_NOT_FOUND', e?.error?.code === 'CWD_NOT_FOUND', String(e?.error?.code))
}

/* [9] stdout 纯净性 */
{
  const r = runCli(['env', '--json'])
  check('[9] --json 的 stdout 无 ANSI 转义', !/\u001b\[/.test(r.stdout))
  check('[9] --json 的 stdout 无多余前后缀', r.stdout.trimStart().startsWith('{') && r.stdout.trimEnd().endsWith('}'))
  check('[9] --json 单次输出即可完整解析', parseEnvelope(r.stdout) !== null)
}

/* [10] 命令帮助 */
{
  const r = runCli(['env', '--help'])
  check('[10] 命令级 --help 退出 0', r.code === 0, `code=${r.code}`)
  check('[10] 命令级 --help 含用法行', r.stdout.includes('maafw-live env'))

  const h = runCli(['help', 'env'])
  check('[10] help <cmd> 等价', h.code === 0 && h.stdout.includes('maafw-live env'), `code=${h.code}`)

  const bad = runCli(['help', 'nope'])
  check('[10] help <未知> 退出 2', bad.code === 2, `code=${bad.code}`)
}

/* [11] skill 自检与漂移比对（随包 skill 的装配面） */
{
  const self = runCli(['skill', '--json'])
  const e = parseEnvelope(self.stdout)
  check('[11] skill 列出包内副本', self.code === 0 && typeof e?.data?.payload === 'string', `code=${self.code}`)
  check('[11] skill 报告文件指纹', Array.isArray(e?.data?.files) && e.data.files.every((f) => f.path && f.sha256))

  const same = runCli(['skill', '--check', join(ROOT, 'skills')])
  check('[11] --check 自身副本逐字节一致（退出 0）', same.code === 0 && same.stdout.includes('一致'), `code=${same.code} ${same.stdout.slice(0, 120)}`)

  const missing = runCli(['skill', '--check', join(MISSING_DIR, 'nope'), '--json'])
  const em = parseEnvelope(missing.stdout)
  check('[11] --check 目标不存在 → 退出 4 / SKILL_DIR_NOT_FOUND',
    missing.code === 4 && em?.error?.code === 'SKILL_DIR_NOT_FOUND', `code=${missing.code} code=${em?.error?.code}`)
}

process.stdout.write(`\n${pass} 通过 / ${fail} 失败\n`)
process.exitCode = fail === 0 ? 0 : 1
