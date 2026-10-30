/**
 * run 回执落盘（repl 与一次性 CLI 共用）：W1 runs 存储的种子。
 *
 * 目录默认 `~/.maafw-live/runs/`，可用 `MAAFW_LIVE_RUNS_DIR` 覆盖——
 * 单测必须指向临时目录，不许往真实 home 写桩数据（2026-10-26 实测污染过一轮）。
 * 落盘失败不属于任务结论：返回体没有 path 时，调用方自行退化（如打印完整 JSON）。
 *
 * 文件名带完整毫秒时间戳，且**独占创建**（flag 'wx'）：回执是"当时只能观测一次"的证据，
 * 被后来的同名写入静默覆盖就等于丢证据——所以撞名不覆盖，改为加序号重试。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function runsDir(): string {
  const override = process.env.MAAFW_LIVE_RUNS_DIR
  return override && override !== '' ? override : join(homedir(), '.maafw-live', 'runs')
}

/** 回执文件名：`run-<ISO 时间戳去分隔符>-<entry>.json`（时间戳保留到毫秒，含 Z 时区标记）。
 *  `now` 可注入：单测据此制造"同一毫秒撞名"，不必靠 sleep。 */
export function receiptFileName(entry: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '')
  const safeEntry = entry.replace(/[\\/:*?"<>|\s]+/g, '_')
  return 'run-' + stamp + '-' + safeEntry + '.json'
}

/** 同一毫秒内最多重试到这个序号（撞名说明并发落盘，实际不会逼近这个量级） */
const MAX_SAME_NAME = 100

export function writeRunReceipt(record: unknown, entry: string, now: Date = new Date()): { path?: string } {
  try {
    const dir = runsDir()
    mkdirSync(dir, { recursive: true })
    const base = receiptFileName(entry, now)
    const body = JSON.stringify(record, null, 2) + '\n'
    for (let n = 0; n < MAX_SAME_NAME; n++) {
      const name = n === 0 ? base : base.replace(/\.json$/, '-' + n + '.json')
      const path = join(dir, name)
      try {
        writeFileSync(path, body, { flag: 'wx' })
        return { path }
      } catch (e) {
        /* 撞名是"已有同名回执"，换序号重试；别的 IO 错误按落盘失败处理 */
        if ((e as { code?: string }).code !== 'EEXIST') throw e
      }
    }
    return {}
  } catch {
    /* 落盘失败：调用方按"没有 path"退化，不吞任务结论 */
    return {}
  }
}
