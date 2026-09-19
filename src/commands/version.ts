/** `maafw-run version` —— CLI 与依赖版本。技能用它做版本对齐。 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EXIT, type Command, type CommandResult } from '../protocol.js'
import { cliPackage } from '../pkg.js'

/**
 * 取 core 的版本。
 *
 * 走 package.json 而不是 `import { version }`——core 导出的是领域函数，
 * 没有一个叫 version 的符号，直接 import 会拿到 undefined 而不报错。
 */
function coreVersion(): string {
  try {
    const req = createRequire(import.meta.url)
    const p = req.resolve('@dsh-external/dsh-maafw-core/package.json')
    return (JSON.parse(readFileSync(p, 'utf8')) as { version?: string }).version ?? ''
  } catch {
    return ''
  }
}

export const versionCommand: Command = {
  name: 'version',
  summary: '打印 maafw-run CLI 及依赖的版本',
  usage: 'maafw-run version',

  async run(): Promise<CommandResult> {
    const pkg = cliPackage()
    const core = coreVersion()

    const human = [
      `${pkg.name} ${pkg.version}`,
      `  node       ${process.version}`,
      `  platform   ${process.platform} ${process.arch}`,
      `  core       ${core || '(不可用)'}`,
    ]

    return {
      exitCode: EXIT.OK,
      human,
      data: {
        name: pkg.name,
        version: pkg.version,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        core: core || null,
      },
    }
  },
}
