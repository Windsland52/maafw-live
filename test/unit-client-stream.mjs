/**
 * 客户端推送分发：`stream_stopped` 必须收得到、进得了错误环。
 *
 * 为什么用桩 daemon（`test/fixtures/stub-stream-daemon.mjs`）而不是真 daemon：真 daemon 只在
 * **控制器被销毁**时才推这条（要设备），而缺口的本体在客户端这一侧——类型联合没有它、
 * 分发链没有分支，消息被静默丢弃。桩 daemon 从 spawn 起就扮演"推这条的 daemon"，
 * 于是这条回归无设备、无 maa-node 也能跑（客户端是懒启动：第一条 `call` 才 spawn 并发 `init`）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnDaemon } from '../lib/client/daemon.js'

const STUB = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stub-stream-daemon.mjs')

test('stream_stopped：订阅者收得到，且进错误环（不再静默丢弃）', async (t) => {
  const runDir = mkdtempSync(join(tmpdir(), 'maafw-client-stub-'))
  const c = spawnDaemon({ runDir, daemonPath: STUB, timeoutMs: 5000 })
  t.after(() => {
    try { c.close() } catch { /* ignore */ }
    try { rmSync(runDir, { recursive: true, force: true }) } catch { /* 子进程可能还握着句柄 */ }
  })

  /* 先订阅再触发 spawn：通知紧跟在 init 回执之后 */
  const notice = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('5s 内没有收到 stream_stopped')), 5000)
    c.subscribe('stream_stopped', (reason) => { clearTimeout(timer); resolve(reason) })
  })
  await c.call('probe')

  assert.match(String(await notice), /控制器已销毁/, '停流原因要原样带给订阅者')
  assert.ok(
    c.events.errors.some((e) => /帧流已停止/.test(e) && /控制器已销毁/.test(e)),
    '错误环里要留下痕迹，实际：' + JSON.stringify(c.events.errors),
  )
})
