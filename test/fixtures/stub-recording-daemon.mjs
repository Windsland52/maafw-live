#!/usr/bin/env node
/**
 * 记录型桩 daemon：把收到的每条请求逐行写进 `MAAFW_STUB_LOG`，再回一个最小形状。
 *
 * 用途：验证"CLI / REPL 到底往线上发了什么"——不碰设备、不需要 maa-node。
 * 与 `stub-daemon.mjs` 的区别：那个只管协议面（init / stream_stopped），这个**记账**。
 *
 * `MAAFW_STUB_REPLIES`（可选）＝ `{"<cmd>": {…}}`：给指定命令**叠一层**自造回执字段，
 * 用来把"daemon 报了什么"当成输入喂给上层的判据（例如 reco 的 meta.w/h 触发 roi 越界）。
 */
import readline from 'node:readline'
import { appendFileSync } from 'node:fs'

const LOG = process.env.MAAFW_STUB_LOG
if (!LOG) { console.error('需要 MAAFW_STUB_LOG'); process.exit(2) }
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')

let EXTRA = {}
try { EXTRA = JSON.parse(process.env.MAAFW_STUB_REPLIES ?? '{}') } catch { EXTRA = {} }

/** 只给调用方真正会读字段的命令一个像样的回执，其余 `{ok:true}` 即可 */
const SHAPES = {
  init: { previewPath: null, daemonId: 'stub-recording', framesDir: '/tmp/stub/frames', kfQuota: 0 },
  connect: {
    ok: true,
    session: { kind: 'adb', target: 'stub-target', cls: null, method: 'adb', resolution: { w: 1280, h: 720 }, warns: [] },
  },
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let m = null
  try { m = JSON.parse(line) } catch { return }
  if (!m || typeof m.cmd !== 'string') return
  appendFileSync(LOG, JSON.stringify(m) + '\n')
  if (m.cmd === 'shutdown') process.exit(0)
  const base = SHAPES[m.cmd] ?? { ok: true }
  const extra = EXTRA[m.cmd]
  send({
    kind: 'reply', id: m.id, ok: true,
    data: extra && typeof extra === 'object' ? { ...base, ...extra } : base,
  })
})
