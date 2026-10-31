/**
 * connect 失败：必须回 `ok:false`，且不把半残控制器留在会话里。
 *
 * 为什么只能走真 daemon：5.14.2 的 `Job.wait()` 在 `post_connection` 失败时**照常 resolve**
 * （status=4000、不抛异常），所以"失败却回 ok:true"的缺口只有裸协议能看见。这里用一个
 * 必然选不出截图方法的 win32 组合（screencap=64，未知位）逼连接失败；没有 win32 窗口
 * （无桌面 CI / 非 Windows）时跳过。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DAEMON = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'daemon', 'framed.mjs')

function protocol(child) {
  const pending = new Map()
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    let m = null
    try { m = JSON.parse(line) } catch { return } // 非 JSON 行是 maa 原生日志
    if (!m || m.kind !== 'reply') return
    const done = pending.get(m.id)
    if (done) { pending.delete(m.id); done(m) }
  })
  let next = 0
  return (cmd, args = {}) => {
    const id = ++next
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('daemon 5s 内没有应答：' + cmd))
      }, 5000)
      pending.set(id, (m) => { clearTimeout(timer); resolve(m) })
      child.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n')
    })
  }
}

test('connect 失败：回 ok:false，且不留下可用会话', async (t) => {
  if (process.platform !== 'win32') { t.skip('只有 win32 控制器能在无设备环境枚举窗口'); return }

  const child = spawn(process.execPath, [DAEMON, '--child'], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { try { child.kill() } catch { /* ignore */ } })
  const call = protocol(child)

  const devicesReply = await call('device_list', { kind: 'win32' })
  const devices = Array.isArray(devicesReply.data) ? devicesReply.data : []
  if (!devices.length) { t.skip('当前桌面没有可枚举的 win32 窗口'); return }

  /* screencap=64 是 Win32 截图方法位图里未定义的位：能构造控制器，但选不出方法 → 连接失败。 */
  const rep = await call('connect', {
    kind: 'win32',
    target: String(devices[0].id),
    screencap: '64',
  })
  assert.equal(rep.ok, true, '协议层应答成功，业务失败在 data.ok：' + JSON.stringify(rep))
  assert.ok(rep.data && rep.data.ok === false, '连接失败不能回 ok:true：' + JSON.stringify(rep.data))
  assert.match(String(rep.data.error), /post_connection status=4000/)

  const status = await call('stream_status')
  assert.equal(status.data.session, null, '连接失败后不能留下已连接的会话状态')

  await call('shutdown')
})
