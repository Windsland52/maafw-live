/**
 * run 阻塞期信号处理（审计 #6/#9）：Ctrl-C / SIGTERM 时不许让 daemon 里的任务裸跑。
 *
 * 第一下：向 daemon 发 run_stop（post_stop），run 回执照常落盘，退出码走 128+signo
 * （SIGINT=130 / SIGTERM=143）。第二下：直接退出——第一次没杀掉说明 daemon 已不应答，
 * 再等没有现场可留（daemon 侧另有 onHostGone 兜底清 agent 树）。
 *
 * 为什么抽出来：Windows 没法跨进程投递 Ctrl-C，内联在命令里就没法测；
 * process.emit('SIGINT') 会同步触发监听，单测只验"旗标立了、run_stop 发了"。
 */
import { EXIT, type ExitCode } from '../protocol.js'

export interface RunSignalGuard {
  /** 当前命中的信号对应的退出码；0 = 没被打断 */
  readonly code: ExitCode | 0
  /** 摘钩子并返回最终 code（run 回执渲染前调用） */
  restore(): ExitCode | 0
}

/** 挂载信号守卫；`runStop` 是"给 daemon 发停止"的那个异步调用。 */
export function installRunSignalGuard(runStop: () => Promise<unknown>): RunSignalGuard {
  let code: ExitCode | 0 = 0
  const on = (c: ExitCode) => () => {
    if (code) { process.exit(c) }          // 第二下：daemon 不应答，不再等
    code = c
    void runStop().catch(() => { /* daemon 已死就让它死，退出码照样 128+signo */ })
  }
  const sigint = on(EXIT.SIGINT)
  const sigterm = on(EXIT.SIGTERM)
  process.on('SIGINT', sigint)
  process.on('SIGTERM', sigterm)
  return {
    get code() { return code },
    restore() {
      process.off('SIGINT', sigint)
      process.off('SIGTERM', sigterm)
      return code
    },
  }
}
