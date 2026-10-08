/** `maafw-live version` —— CLI 与运行环境版本。技能用它做版本对齐；`--check` 对 registry 查有没有新版。 */
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { cliPackage } from '../pkg.js'
import {
  compareVersions, fetchLatest, readState, shouldCheck, updateCheckDisabled, writeState,
} from '../update-check.js'

export const versionCommand: Command = {
  name: 'version',
  summary: '打印 maafw-live CLI 及依赖的版本；--check 顺带对 registry 查有没有新版',
  usage: 'maafw-live version [--check]',
  options: { check: { type: 'boolean' } },

  async run(ctx): Promise<CommandResult> {
    const pkg = cliPackage()

    const human = [
      `${pkg.name} ${pkg.version}`,
      // scoped 包最容易混的就是"装的名字"与"敲的命令"：装的是 @windsland52/maa-live，敲的是 maafw-live
      `  command    maafw-live`,
      `  node       ${process.version}`,
      `  platform   ${process.platform} ${process.arch}`,
    ]
    const data: Record<string, unknown> = {
      name: pkg.name,
      version: pkg.version,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    }

    const explicit = ctx.values.check === true
    /* 显式请求：不受 TTY/限频约束，查不到要如实说。自动路径：只在交互终端、限频、失败静默。 */
    const auto = !explicit && !updateCheckDisabled() && process.stdout.isTTY === true
    if (explicit || auto) {
      let latest = auto ? readState()?.latest ?? null : null
      let fresh = false
      const cached = readState()
      if (explicit || shouldCheck(cached, Date.now())) {
        const fetched = await fetchLatest(pkg.name)
        if (fetched) {
          latest = fetched
          writeState({ checkedAt: Date.now(), latest: fetched })
          fresh = true
        } else if (explicit) {
          return fail('UPDATE_CHECK_FAILED', '查询 registry 失败（离线 / 代理 / registry 抖动）',
            '加 --check 才需要联网；不带它 version 完全离线可用', EXIT.ENV)
        }
      } else if (cached) {
        latest = cached.latest
      }
      if (latest) {
        const cmp = compareVersions(latest, pkg.version)
        data.latest = latest
        data.updateAvailable = cmp > 0
        data.source = fresh ? 'registry' : 'cache'
        if (cmp > 0) {
          human.push(
            `  新版       ${latest}（当前 ${pkg.version}）`,
            `  升级       npm install --global ${pkg.name}@latest`,
          )
          /* 自动提示不改退出码：版本旧不是"这次调用发现的问题" */
          return { exitCode: explicit ? EXIT.FINDINGS : EXIT.OK, human, data, ...(explicit ? {} : {}) }
        }
        human.push(`  最新       ${latest}（已是最新）`)
      } else if (explicit) {
        human.push('  最新       查询不到（registry 不可达）')
      }
    }

    return { exitCode: EXIT.OK, human, data }
  },
}
