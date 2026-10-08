#!/usr/bin/env node
/**
 * 桩 daemon：只做一件事——像真 daemon 那样推一条 `stream_stopped`。
 *
 * 用途：钉住客户端的推送分发（`src/client/daemon.ts` 的 `wire()`）。真 daemon 只在
 * **控制器被销毁**（`connect` 重建、`disconnect`）时才发这条，那需要设备；而这条消息
 * 曾经是"只发不收"的孤儿——类型联合里没有、分发链里没分支，订阅不到、连日志都不进。
 * 桩 daemon 让这条路径在无设备、无 maa-node 的情况下也能回归。
 *
 * 协议形状与真 daemon 一致：stdin 逐行 JSON 请求，stdout 逐行 JSON 消息；`init` 是客户端
 * spawn 后立刻发的第一条（id = -1，回执按约定被丢弃）；`shutdown` 不回执、直接退出
 * （真 daemon 就是 `process.exit(0)`）。
 */
import readline from 'node:readline'

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  let m = null
  try { m = JSON.parse(line) } catch { return }
  if (!m || typeof m.cmd !== 'string') return
  if (m.cmd === 'shutdown') process.exit(0)
  send({ kind: 'reply', id: m.id, ok: true, data: {} })
  /* 真 daemon 在控制器销毁时就是先回执、再推这条 */
  if (m.cmd === 'init') send({ kind: 'stream_stopped', reason: '控制器已销毁（桩 daemon）' })
})

/* 父进程退出 → stdin EOF → 自己收摊，别留孤儿进程 */
rl.on('close', () => process.exit(0))
