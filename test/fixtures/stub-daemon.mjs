#!/usr/bin/env node
/**
 * 桩 daemon：像真 daemon 那样应答 `init` 并推一条 `stream_stopped`。
 *
 * 用途：钉住客户端的协议面（`src/client/daemon.ts`）——这些缺口都在客户端一侧，
 * 用真 daemon 测要么需要设备（stream_stopped 只在控制器销毁时推），要么把 init 失败
 * 演成真故障；桩 daemon 让两条路径在无设备、无 maa-node 的情况下也能回归。
 *
 * 协议形状与真 daemon 一致：stdin 逐行 JSON 请求，stdout 逐行 JSON 消息；
 * `shutdown` 不回执、直接退出（真 daemon 也是收摊即退）。
 */
import readline from 'node:readline'

/** 真 daemon init 回执的字段集（客户端会把它当握手结果） */
const INIT = {
  previewPath: '/tmp/stub/preview.png',
  daemonId: 'stub-daemon-0001',
  framesDir: '/tmp/stub/frames',
  kfQuota: 1073741824,
}

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  let m = null
  try { m = JSON.parse(line) } catch { return }
  if (!m || typeof m.cmd !== 'string') return
  if (m.cmd === 'shutdown') process.exit(0)
  send({ kind: 'reply', id: m.id, ok: true, data: m.cmd === 'init' ? INIT : {} })
  /* 真 daemon 在控制器被销毁（connect 重建 / disconnect）时就是先回执、再推这条 */
  if (m.cmd === 'init') send({ kind: 'stream_stopped', reason: '控制器已销毁（桩 daemon）' })
})

/* 父进程退出 → stdin EOF → 自己收摊，别留孤儿进程 */
rl.on('close', () => process.exit(0))
