/**
 * 全局选项。
 *
 * 三条为自动化调用（agent / 脚本 / CI）服务的约定：
 *  - `--no-interactive` / `--yes`：当前版本没有交互式提问与确认步骤，标志照传即可——
 *    保留解析是防后续版本引入交互时挂住 agent 的自动化调用；
 *  - `--no-color`：ANSI 转义会混进 JSON；
 *  - `--json`：稳定信封，供技能与 CI 解析。
 *
 * `--dry-run` / `--verbose` / 全局 `--limit` 没有消费者：`index.ts` 在解析后直接退 2
 * （`FLAG_NOT_IMPLEMENTED`）——静默接受比报错更坏（"以为在试跑其实已经落盘"）。
 * 例外：命令自己声明并消费 `limit` 时（`events`）放行。要恢复预留语义再放开。
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
  /** 把命令转发到命名会话的常驻 daemon（`repl --session <name>` 起的那个） */
  session: { type: 'string' },
} satisfies ParseArgsOptionsConfig

export interface GlobalFlags {
  json: boolean
  /** 预留位：当前没有"只计算不落盘"的实现，值不被消费 */
  dryRun: boolean
  /** 预留授权位：当前版本没有确认步骤，值不被消费 */
  yes: boolean
  /** 预留门控位：当前版本没有交互式提问，值不被消费 */
  interactive: boolean
  color: boolean
  cwd: string
  /** 预留位：当前没有输出条数上限，值不被消费 */
  limit: number
  /** 预留位：当前没有详细输出，值不被消费 */
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
