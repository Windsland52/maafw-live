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
const STUB_ALIVE = join(HERE, 'fixtures', 'stub-alive-daemon.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('超时 → ping 探活失败 → 硬杀 daemon → 下次调用自动重生', async (t) => {
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

  /* 第二阶段：放行标记 → 下一次调用自动重生一个会应答的 daemon。
   * 单次预算放宽到 8s：spawnDaemon 的缺省 800ms 是为"卡死"那段定的，
   * CI 上 spawn+init+首条请求可能叠超时；这里测的是"重生后能应答"，不是"800ms 内能答"。 */
  writeFileSync(marker, '')
  assert.deepEqual(await c.call('probe', {}, 8000), {}, '重生后的 daemon 应正常应答')
  assert.equal(c.stats().restarts, 1, '重生计数应为 1')

  /* 顺带钉住"第一次那条请求真的送达了"——证明是被卡住，而不是写失败 */
  const reqs = existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  assert.ok(reqs.some((r) => r.cmd === 'probe'), '第一次 probe 应已送达卡死的 daemon：' + JSON.stringify(reqs))
  /* 顺带钉住新契约：ping 探活是客户端发的，桩 daemon 在第一阶段应收到过它 */
  assert.ok(reqs.some((r) => r.cmd === 'ping'), '超时应先发 ping 探活再决定生死：' + JSON.stringify(reqs))
})

test('超时但 daemon 还能应答 → 只失败该次调用，不杀进程', async (t) => {
  /* 设计审查 P0-1 的核心修复：REPL / 命名会话里超时杀 daemon 会把设备连接、事件环、
   * L0 热缓存一起带走。现在的顺序是 超时 → ping 探活 → 能应答就只让这条调用失败。
   * 桩 daemon 用慢应答而不是不答：cmd 'slow' 延迟 2s 回，超时的 800ms 里 ping 已经能答上。 */
  const dir = mkdtempSync(join(tmpdir(), 'maafw-timeout-alive-'))
  const log = join(dir, 'requests.jsonl')
  const saved = process.env.MAAFW_STUB_LOG
  process.env.MAAFW_STUB_LOG = log
  const c = spawnDaemon({ runDir: join(dir, 'run'), daemonPath: STUB_ALIVE, timeoutMs: 800 })
  t.after(() => {
    try { c.close() } catch { /* ignore */ }
    if (saved === undefined) delete process.env.MAAFW_STUB_LOG
    else process.env.MAAFW_STUB_LOG = saved
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  await assert.rejects(() => c.call('slow'), /daemon 调用超时.*进程保留/, '活着但超时应报"进程保留"')
  assert.equal(c.stats().alive, true, 'daemon 能应答就不许杀')
  /* 会话还活着：后续调用正常应答 */
  assert.deepEqual(await c.call('probe'), {}, '探活放过后续调用应正常应答')
  assert.equal(c.stats().restarts, 0, '没有重启')
})
