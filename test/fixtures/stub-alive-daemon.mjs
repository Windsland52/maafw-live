#!/usr/bin/env node
/**
 * "活着但慢"的桩 daemon：ping / probe 立刻应答，`cmd:'slow'` 延迟 2s 才回。
 * 用来钉 P0-1 的新契约——调用超时但 daemon 可应答时，只失败该次调用，
 * 进程与会话都保住（ping 探活在 800ms 超时窗内已经证明它活着）。
 */
import readline from 'node:readline'
import { appendFileSync } from 'node:fs'

const LOG = process.env.MAAFW_STUB_LOG
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let m = null
  try { m = JSON.parse(line) } catch { return }
  if (!m || typeof m.cmd !== 'string') return
  if (LOG) { try { appendFileSync(LOG, JSON.stringify(m) + '\n') } catch { /* ignore */ } }
  if (m.cmd === 'shutdown') process.exit(0)
  if (m.cmd === 'slow') { setTimeout(() => send({ kind: 'reply', id: m.id, ok: true, data: {} }), 2000); return }
  send({ kind: 'reply', id: m.id, ok: true, data: {} })
})
