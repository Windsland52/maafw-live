/**
 * daemon 生命周期：`shutdown` 的回执要先落地，再退出进程。
 *
 * 为什么不借本仓的 client 测：这是**协议级**契约（任何宿主都可能自己 spawn daemon 说话），
 * 而客户端早就把 shutdown 当"发了就不管"（`close()` 不等应答、超时硬杀兜底）——所以这个缺口
 * 只有用裸协议才看得见。用真 daemon 子进程 + 无设备：shutdown 只停流/断连/收摊，
 * 不碰 maa 绑定（framed.mjs 里是 `loadMaa()` 懒加载），因此不需要真机也不需要原生依赖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DAEMON = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'daemon', 'framed.mjs')

test('shutdown：先回 {ok:true}，再退出进程', async (t) => {
  const child = spawn(process.execPath, [DAEMON, '--child'], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { try { child.kill() } catch { /* ignore */ } })

  const replies = []
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    try { replies.push(JSON.parse(line)) } catch { /* 非 JSON 行是原生日志 */ }
  })
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))

  child.stdin.write(JSON.stringify({ id: 1, cmd: 'shutdown' }) + '\n')
  const code = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('5s 内 daemon 没退出')), 5000)),
  ])

  assert.equal(code, 0, '正常收摊应退 0')
  const rep = replies.find((m) => m.kind === 'reply' && m.id === 1)
  assert.ok(rep, 'shutdown 必须应答——不能"最后一条命令没有回执"：' + JSON.stringify(replies))
  assert.equal(rep.ok, true)
})
