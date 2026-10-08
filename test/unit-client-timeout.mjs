/**
 * 客户端的超时自愈（`src/client/daemon.ts`）：一次卡死不能拖死整个会话。
 *
 * 契约（文件头的注释就是这么写的）：调用超时即认为 daemon 卡死（maa-node 的 `wait()` 可能同步阻塞
 * worker），**硬杀**子进程，下次调用自动重生。这条链路此前没有任何测试——而它正是"设备卡了"这类
 * 现场唯一能自愈的地方。
 *
 * 怎么测才不依赖时序：用两阶段桩 daemon（`test/fixtures/stub-phased-daemon.mjs`）——先卡死，
 * 由测试**显式放行**（写标记文件）才应答；"硬杀"不靠 sleep 猜，而是轮询 `stats().alive` 直到转 false。
 * 本仓刚在 CI 上被"靠时序的断言"坑过一次，这里刻意不重复。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnDaemon } from '../lib/client/daemon.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const STUB = join(HERE, 'fixtures', 'stub-phased-daemon.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('超时 → 硬杀 daemon → 下次调用自动重生', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-timeout-'))
  const marker = join(dir, 'alive')
  const log = join(dir, 'requests.jsonl')
  const saved = { marker: process.env.MAAFW_STUB_MARKER, log: process.env.MAAFW_STUB_LOG }
  /* 子进程继承 process.env，所以必须在第一次调用（懒启动 spawn）之前设好 */
  process.env.MAAFW_STUB_MARKER = marker
  process.env.MAAFW_STUB_LOG = log
  const c = spawnDaemon({ runDir: join(dir, 'run'), daemonPath: STUB, timeoutMs: 800 })

  t.after(() => {
    try { c.close() } catch { /* ignore */ }
    if (saved.marker === undefined) delete process.env.MAAFW_STUB_MARKER
    else process.env.MAAFW_STUB_MARKER = saved.marker
    if (saved.log === undefined) delete process.env.MAAFW_STUB_LOG
    else process.env.MAAFW_STUB_LOG = saved.log
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  /* 第一阶段：daemon 收得到、但不回应——调用必须按超时失败，而不是永远挂着 */
  await assert.rejects(() => c.call('probe'), /daemon 调用超时/, '卡死的 daemon 要按超时失败')

  /* 硬杀：等子进程真的退出（不靠 sleep 猜时序） */
  const deadline = Date.now() + 5000
  while (c.stats().alive && Date.now() < deadline) await sleep(50)
  assert.equal(c.stats().alive, false, '超时后必须硬杀 daemon')

  /* 第二阶段：放行标记 → 下一次调用自动重生一个会应答的 daemon */
  writeFileSync(marker, '')
  assert.deepEqual(await c.call('probe'), {}, '重生后的 daemon 应正常应答')
  assert.equal(c.stats().restarts, 1, '重生计数应为 1')

  /* 顺带钉住"第一次那条请求真的送达了"——证明是被卡住，而不是写失败 */
  const reqs = existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  assert.ok(reqs.some((r) => r.cmd === 'probe'), '第一次 probe 应已送达卡死的 daemon：' + JSON.stringify(reqs))
})
