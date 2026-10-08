/** `maafw-live version` —— CLI 与运行环境版本。技能用它做版本对齐。 */
import { EXIT, type Command, type CommandResult } from '../protocol.js'
import { cliPackage } from '../pkg.js'

export const versionCommand: Command = {
  name: 'version',
  summary: '打印 maafw-live CLI 及依赖的版本',
  usage: 'maafw-live version',

  async run(): Promise<CommandResult> {
    const pkg = cliPackage()

    const human = [
      `${pkg.name} ${pkg.version}`,
      // scoped 包最容易混的就是"装的名字"与"敲的命令"：装的是 @windsland52/maa-live，敲的是 maafw-live
      `  command    maafw-live`,
      `  node       ${process.version}`,
      `  platform   ${process.platform} ${process.arch}`,
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
      },
    }
  },
}
