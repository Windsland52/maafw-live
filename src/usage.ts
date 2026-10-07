/** 帮助文本。全局选项的说明集中在这里，命令只声明自己的选项。 */
import { COMMANDS } from './commands/index.js'
import { cliPackage } from './pkg.js'
import type { Command } from './protocol.js'

const GLOBAL_HELP: Array<[string, string]> = [
  ['--json', '输出统一 JSON 信封（stdout 保持纯 JSON）'],
  ['--dry-run', '只计算不落盘'],
  ['--yes', '授权标志（当前版本无确认步骤，照传）'],
  ['--no-interactive', '防交互挂住自动化（当前版本无提问，照传）'],
  ['--no-color', '关闭颜色（管道下自动关闭）'],
  ['--cwd <dir>', '指定工作目录'],
  ['--limit <n>', '输出条数上限，默认 200'],
  ['--verbose', '详细输出'],
  ['-h, --help', '显示帮助'],
  ['-V, --version', '显示版本'],
]

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

export function topLevelUsage(): string[] {
  const pkg = cliPackage()
  const nameWidth = Math.max(...COMMANDS.map((c) => c.name.length), 7)

  return [
    `${pkg.name} ${pkg.version} — MaaFramework 设备运行时与观测底座`,
    '',
    '用法：',
    '  maafw-live <command> [options]',
    '',
    '命令：',
    ...COMMANDS.map((c) => `  ${pad(c.name, nameWidth + 2)}${c.summary}`),
    '',
    '全局选项：',
    ...GLOBAL_HELP.map(([f, d]) => `  ${pad(f, 20)}${d}`),
  ]
}

export function commandUsage(cmd: Command): string[] {
  const lines = [cmd.summary, '', '用法：', '  ' + cmd.usage]

  const own = Object.entries(cmd.options ?? {})
  if (own.length > 0) {
    lines.push('', '选项：')
    for (const [flag, spec] of own) {
      const isBool = (spec as { type?: string }).type === 'boolean'
      lines.push(`  ${pad('--' + flag + (isBool ? '' : ' <value>'), 20)}`)
    }
  }

  lines.push('', '全局选项：')
  for (const [f, d] of GLOBAL_HELP) lines.push(`  ${pad(f, 20)}${d}`)

  return lines
}
