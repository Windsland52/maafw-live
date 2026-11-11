/**
 * 运行期日志跟随：run 这类长任务在执行中不产出任何可观测信号（daemon 的帧流被框架
 * 截图链路占住，events 环为空），唯一还在更新的只有**项目 agent 自己写的日志**。
 * 所以「跑的时候能不能看见正在发生什么」这件事，实现上就是「跟着 tail 那几份日志」。
 *
 * 本模块只做跟随与筛选，不解释日志内容 —— 判读规则属于项目（每个项目的日志格式不同）。
 */
import fs from "node:fs"
import path from "node:path"

export interface WatchOptions {
  /** 要跟随的日志文件（绝对路径或相对 cwd） */
  paths?: string[]
  /** 条目级跟随：文件 / glob（含 * ? [ ]）/ 目录（取每 tick 最新 mtime 的一个文件）；
   * 每次 tick 重新解析——日更文件名（跨午夜换新名）不丢尾巴。 */
  entries?: string[]
  /** 推送间隔（ms）：攒够这么久的行再一次性回调，避免逐行刷屏 */
  intervalMs?: number
  /** 只推送匹配这些正则的行；缺省推全部 */
  include?: RegExp[]
  /** 丢弃匹配这些正则的行 */
  exclude?: RegExp[]
  /** 每次推送最多带多少行（超出折叠成一句「还有 N 行」） */
  maxLinesPerFlush?: number
}

export interface WatchHandle {
  /** 停止跟随并返回累计统计 */
  stop(): WatchStats
}

export interface WatchStats {
  /** 累计读到的原始行数 */
  lines: number
  /** 其中被推送给调用方的行数 */
  pushed: number
  /** 实际跟随成功的文件 */
  files: string[]
}

interface FileState {
  path: string
  offset: number
  /** 上次看到的 inode/mtime，用于识别轮转 */
  lastSize: number
}

/* 条目 → 当下实际要跟随的文件集合（每 tick 重算，覆盖日更轮转与 glob） */
function resolveEntryPaths(entry: string): string[] {
  if (/[*?\[\]]/.test(entry)) {
    try { return fs.globSync(entry) } catch { return [] }
  }
  try {
    if (fs.statSync(entry).isDirectory()) {
      const hits = fs.readdirSync(entry)
        .map((f) => { try { const p = path.join(entry, f); return { p, m: fs.statSync(p).mtimeMs } } catch { return null } })
        .filter((x): x is { p: string; m: number } => x !== null)
      hits.sort((a, b) => b.m - a.m)
      return hits.slice(0, 1).map((x) => x.p)
    }
  } catch { /* 不存在也是合法状态（等它出现） */ }
  return [entry]
}

export function watchLogs(opts: WatchOptions, onFlush: (lines: string[]) => void): WatchHandle {
  const intervalMs = opts.intervalMs ?? 1500
  const maxLines = opts.maxLinesPerFlush ?? 40
  const sources = opts.entries ?? opts.paths ?? []
  /* FileState 挂在「条目→文件」的映射上：同一条目解析出新文件时重置 offset 重读
   * （日更轮转 = 条目解析到另一个文件名），解析回原文件时保持原 offset。 */
  const byEntry = new Map<string, FileState[]>()
  const resolveStates = (): FileState[] => {
    const out: FileState[] = []
    for (const entry of sources) {
      const prev = byEntry.get(entry) ?? []
      const prevByPath = new Map(prev.map((s) => [s.path, s]))
      const states = resolveEntryPaths(entry).map((p) => {
        const seen = prevByPath.get(p)
        if (seen) return seen
        /* 新解析出来的文件保持"从尾部开始"的首次跟随语义（等价于 run 启动时只关心之后的事）。
         * 从 0 起读会把该文件的整份历史一次倒出来（目录条目首跑就踩这个）。 */
        let size = 0
        try { size = fs.statSync(p).size } catch { /* 还没出现：0 起读等它长出来 */ }
        return { path: p, offset: size, lastSize: size }
      })
      byEntry.set(entry, states)
      out.push(...states)
    }
    return out
  }
  /* resolveStates 已为每个条目 seed 好"新文件=尾部起读"，不需要再单独扫一遍。
   * 首次跟随语义（只关心从现在起的事）由 FileState 的 offset=statSync.size 体现。 */
  resolveStates()
  const stats: WatchStats = { lines: 0, pushed: 0, files: [] }
  let buffer: string[] = []
  let stopped = false

  const readNew = (): void => {
    /* 每 tick 重解析条目：文件在启动后新建、日更轮转（跨午夜换文件名）、目录里出现
     * 更新的文件都能跟上——这是 4.1 那次 `--watch log_20261110.txt` 跨午夜跟丢的修法。
     * 新解析出的文件 seed 到尾部起读（resolveStates），同一条目换文件不整份倒历史。 */
    for (const st of resolveStates()) {
      let s: fs.Stats
      try {
        s = fs.statSync(st.path)
      } catch {
        continue
      }
      if (!stats.files.includes(st.path)) stats.files.push(st.path)
      /* 轮转或截断：回到 0 重读 */
      if (s.size < st.offset) {
        st.offset = 0
      }
      if (s.size === st.offset) {
        st.lastSize = s.size
        continue
      }
      const len = s.size - st.offset
      const buf = Buffer.alloc(len)
      let fd: number | undefined
      try {
        fd = fs.openSync(st.path, "r")
        fs.readSync(fd, buf, 0, len, st.offset)
      } catch {
        continue
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd)
          } catch {
            /* ignore */
          }
        }
      }
      st.offset = s.size
      st.lastSize = s.size
      const text = buf.toString("utf8")
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        stats.lines += 1
        if (opts.include?.length && !opts.include.some((re) => re.test(line))) continue
        if (opts.exclude?.length && opts.exclude.some((re) => re.test(line))) continue
        buffer.push(line)
      }
    }
  }

  const timer = setInterval(() => {
    if (stopped) return
    readNew()
    if (!buffer.length) return
    const took = buffer.slice(0, maxLines)
    const rest = buffer.length - took.length
    buffer = []
    stats.pushed += took.length
    onFlush(rest > 0 ? [...took, "… 还有 " + String(rest) + " 行未显示"] : took)
  }, intervalMs)
  timer.unref?.()

  return {
    stop() {
      stopped = true
      clearInterval(timer)
      /* 收尾时把剩余行补推一次，避免最后几行丢在缓冲里 */
      readNew()
      if (buffer.length) {
        const rest = buffer
        buffer = []
        stats.pushed += rest.length
        onFlush(rest.slice(0, maxLines))
      }
      return stats
    },
  }
}
