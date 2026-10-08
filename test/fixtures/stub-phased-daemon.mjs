#!/usr/bin/env node
/**
 * 两阶段桩 daemon：`MAAFW_STUB_MARKER` 指向的文件**不存在**时一律不回应（模拟卡死的 daemon），
 * 文件出现后正常应答。用来钉客户端的两条自愈行为：
 *  - 调用超时 → 硬杀 daemon（一次卡死不该拖死整个会话）；
 *  - 下一次调用自动重生（新子进程看到标记文件，于是能应答）。
 * 收到的请求记到 `MAAFW_STUB_LOG`，好在断言里区分"被卡住"与"根本没送到"。
 */
import readline from 'node:readline'
import { appendFileSync, existsSync } from 'node:fs'

const MARKER = process.env.MAAFW_STUB_MARKER
const LOG = process.env.MAAFW_STUB_LOG
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let m = null
  try { m = JSON.parse(line) } catch { return }
  if (!m || typeof m.cmd !== 'string') return
  if (LOG) { try { appendFileSync(LOG, JSON.stringify(m) + '\n') } catch { /* ignore */ } }
  if (m.cmd === 'shutdown') process.exit(0)
  /* 第一阶段：收得到、但不答（真 daemon 卡在 maa-node 的同步 wait() 里就是这样） */
  if (!MARKER || !existsSync(MARKER)) return
  send({ kind: 'reply', id: m.id, ok: true, data: {} })
})
