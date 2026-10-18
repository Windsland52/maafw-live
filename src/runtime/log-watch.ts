/**
 * 运行期日志跟随：run 这类长任务在执行中不产出任何可观测信号（daemon 的帧流被框架
 * 截图链路占住，events 环为空），唯一还在更新的只有**项目 agent 自己写的日志**。
 * 所以「跑的时候能不能看见正在发生什么」这件事，实现上就是「跟着 tail 那几份日志」。
 *
 * 本模块只做跟随与筛选，不解释日志内容 —— 判读规则属于项目（每个项目的日志格式不同）。
 */
import fs from "node:fs"

export interface WatchOptions {
  /** 要跟随的日志文件（绝对路径或相对 cwd） */
  paths: string[]
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

export function watchLogs(opts: WatchOptions, onFlush: (lines: string[]) => void): WatchHandle {
  const intervalMs = opts.intervalMs ?? 1500
  const maxLines = opts.maxLinesPerFlush ?? 40
  const states: FileState[] = opts.paths.map((p) => ({ path: p, offset: 0, lastSize: 0 }))
  /* 首次跟随从文件末尾开始：默认只关心「从现在起新发生的事」，历史不重复刷 */
  for (const st of states) {
    try {
      const s = fs.statSync(st.path)
      st.offset = s.size
      st.lastSize = s.size
    } catch {
      /* 文件还不存在（进程刚起、日志未创建）：从 0 开始，出现即读 */
    }
  }
  const stats: WatchStats = { lines: 0, pushed: 0, files: [] }
  let buffer: string[] = []
  let stopped = false

  const readNew = (): void => {
    for (const st of states) {
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
