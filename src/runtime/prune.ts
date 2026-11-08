/**
 * 落盘目录的保留上限（runs/、png/ 共用）：按 mtime 留最新 keep 个，删其余。
 * 背景：~/.maafw-live 下这些目录以前没有上限——回执与截图只进不出，
 * 用久了会无声膨胀（实测 runs/ 44 个、frames 15MB）。修剪失败不抛：
 * 落盘/清理从来不是任务结论，最坏是目录多留几个。
 *
 * 只删 suffix 匹配的文件，不碰目录与其他扩展名；目录本身不存在时直接返回。
 * daemon 侧（framed.mjs）的 out/ 有同逻辑的内联副本——它自包含、不能 import lib。
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export function pruneDir(dir: string, opts: { keep: number; suffix?: string }): void {
  try {
    const suffix = opts.suffix ?? ''
    const names = readdirSync(dir)
      .filter((n) => n.endsWith(suffix))
      .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t) /* 新的在前 */
    for (const f of names.slice(Math.max(0, opts.keep))) {
      try { unlinkSync(join(dir, f.n)) } catch { /* 单个删不掉就留 */ }
    }
  } catch { /* 目录不存在/读不了：按没有要清的看 */ }
}
