/**
 * 客户端协议面（`src/client/daemon.ts`）：init 握手必须可用，推送消息必须收得到。
 *
 * 两条都在客户端一侧，所以用桩 daemon（`test/fixtures/`）而不是真 daemon：
 *  - init：旧实现用 `id:-1` 把 init 发出去就不管，回执被分发链当"未知 id"丢弃——
 *    宿主拿不到 framesDir / kfQuota，init 失败也无从得知。用桩 daemon 钉住"回执可读"，
 *    再用沉默桩钉住"对方不回时如实回报"，两条都无设备、无 maa-node 也能跑。
 *  - stream_stopped：真 daemon 只在控制器被销毁时推它（要设备），桩 daemon 从 spawn 起就扮这个角色。
 *
 * 客户端是**懒启动**：第一条 `call` / `init` 才 spawn 子进程（并随即发 init）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnDaemon } from '../lib/client/daemon.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const STUB = join(FIXTURES, 'stub-daemon.mjs')
const SILENT = join(FIXTURES, 'stub-silent-daemon.mjs')

/** 起一个用桩 daemon 的客户端，并保证收尾 */
function stubClient(t, daemonPath, timeoutMs = 5000) {
  const runDir = mkdtempSync(join(tmpdir(), 'maafw-client-stub-'))
  const c = spawnDaemon({ runDir, daemonPath, timeoutMs })
  t.after(() => {
    try { c.close() } catch { /* ignore */ }
    try { rmSync(runDir, { recursive: true, force: true }) } catch { /* 子进程可能还握着句柄 */ }
  })
  return c
}

test('init 握手：回执可读（framesDir / daemonId / kfQuota），不再被静默丢弃', async (t) => {
  const c = stubClient(t, STUB)
  const r = await c.init()
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.data.daemonId, 'stub-daemon-0001')
  assert.match(r.data.framesDir, /frames$/)
  assert.equal(r.data.kfQuota, 1073741824)
  assert.equal(c.events.errors.length, 0, '握手成功不该在错误环里留东西')
})

test('init 握手：对方不回 → 如实回报 + 错误环留痕（不抛异常、不假装成功）', async (t) => {
  /* 超时给短一点：这条测的是"无应答"的判定，不是等 30s */
  const c = stubClient(t, SILENT, 300)
  const r = await c.init()
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.match(r.error, /无应答/)
  assert.ok(c.events.errors.some((e) => /^init 失败/.test(e)), '错误环要留痕，实际：' + JSON.stringify(c.events.errors))
})

test('stream_stopped：订阅者收得到，且进错误环（不再静默丢弃）', async (t) => {
  const c = stubClient(t, STUB)

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
