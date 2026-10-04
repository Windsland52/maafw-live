/**
 * 命令注册表。
 *
 * 只注册**已经实现且能跑通**的命令。未实现的能力（timing、关键帧留存）列在 README 的
 * 路线图与 `--help` 里，不在这里挂空壳——挂空壳会让 `maa <cmd>` 的失败原因从
 * 「没这个命令」变成「没实现」，技能无法区分，也会让 help 撒谎。
 */
import type { Command } from '../protocol.js'
import { envCommand } from './env.js'
import { INPUT_COMMANDS } from './input.js'
import { RECO_COMMANDS } from './reco.js'
import { replCommand } from './repl.js'
import { RUNTIME_COMMANDS } from './runtime.js'
import { versionCommand } from './version.js'

/** 展示顺序：探针 → 运行时/设备 → 输入 → 识别 → 会话。 */
export const COMMANDS: Command[] = [
  envCommand,
  versionCommand,
  ...RUNTIME_COMMANDS,
  ...INPUT_COMMANDS,
  ...RECO_COMMANDS,
  replCommand,
]

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name)
}

/** 未知命令时给出「最接近的名字」建议（编辑距离），避免用户猜 */
export function suggestCommand(name: string, maxDistance = 3): string | undefined {
  let best: string | undefined
  let bestDist = maxDistance + 1
  for (const c of COMMANDS) {
    const d = distance(name, c.name)
    if (d < bestDist) {
      bestDist = d
      best = c.name
    }
  }
  return bestDist <= maxDistance ? best : undefined
}

function distance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[n]
}
