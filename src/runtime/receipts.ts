/**
 * run 回执落盘（repl 与一次性 CLI 共用）：W1 runs 存储的种子。
 *
 * 目录默认 `~/.maafw-live/runs/`，可用 `MAAFW_LIVE_RUNS_DIR` 覆盖——
 * 单测必须指向临时目录，不许往真实 home 写桩数据（2026-10-26 实测污染过一轮）。
 * 落盘失败不属于任务结论：返回体没有 path 时，调用方自行退化（如打印完整 JSON）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function runsDir(): string {
  const override = process.env.MAAFW_LIVE_RUNS_DIR
  return override && override !== '' ? override : join(homedir(), '.maafw-live', 'runs')
}

export function writeRunReceipt(record: unknown, entry: string): { path?: string } {
  try {
    const dir = runsDir()
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 17)
    const safeEntry = entry.replace(/[\\/:*?"<>|\s]+/g, '_')
    const path = join(dir, 'run-' + stamp + '-' + safeEntry + '.json')
    writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
    return { path }
  } catch {
    /* 落盘失败：调用方按"没有 path"退化，不吞任务结论 */
    return {}
  }
}
