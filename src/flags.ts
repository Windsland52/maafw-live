/**
 * 全局选项。
 *
 * 三条为自动化调用（agent / 脚本 / CI）服务的约定：
 *  - `--no-interactive` / `--yes`：当前版本没有交互式提问与确认步骤，标志照传即可——
 *    保留解析是防后续版本引入交互时挂住 agent 的自动化调用；
 *  - `--no-color`：ANSI 转义会混进 JSON；
 *  - `--json`：稳定信封，供技能与 CI 解析。
 */
import type { ParseArgsOptionsConfig } from 'node:util'

export const GLOBAL_OPTIONS = {
  json: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean' },
  'no-interactive': { type: 'boolean' },
  'no-color': { type: 'boolean' },
  cwd: { type: 'string' },
  limit: { type: 'string' },
  verbose: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
} satisfies ParseArgsOptionsConfig

export interface GlobalFlags {
  json: boolean
  dryRun: boolean
  /** 预留授权位：当前版本没有确认步骤，值不被消费 */
  yes: boolean
  /** 预留门控位：当前版本没有交互式提问，值不被消费 */
  interactive: boolean
  color: boolean
  cwd: string
  limit: number
  verbose: boolean
  help: boolean
  version: boolean
}

const DEFAULT_LIMIT = 200

/**
 * 从 parseArgs 的 values 推导全局标志。
 *
 * `--no-color` 只关闭颜色；未指定时按 TTY 自动判断（管道里自动无色）。
 * 注意不能用 NO_COLOR 环境变量以外的方式覆盖显式传入的值。
 */
export function readGlobalFlags(values: Record<string, unknown>, cwd: string): GlobalFlags {
  const rawLimit = values.limit
  let limit = DEFAULT_LIMIT
  if (typeof rawLimit === 'string' && rawLimit !== '') {
    const n = Number(rawLimit)
    limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LIMIT
  }

  const noColor = values['no-color'] === true
  const color = !noColor && process.env.NO_COLOR === undefined && process.stdout.isTTY === true

  return {
    json: values.json === true,
    dryRun: values['dry-run'] === true,
    yes: values.yes === true,
    interactive: values['no-interactive'] !== true && process.env.MAAFW_RUN_NON_INTERACTIVE === undefined,
    color,
    cwd,
    limit,
    verbose: values.verbose === true,
    help: values.help === true,
    version: values.version === true,
  }
}
