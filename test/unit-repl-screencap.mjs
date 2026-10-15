/**
 * repl `screencap` 的参数面（回归）：`--out` 是**旗标**，不是位置参数。
 *
 * 旧行为：`screencap --out a.png` 把 `--out` 当位置参数 → daemon 真的写出一个名为 `--out` 的
 * 文件（落在 cwd），回执 `{"ok":true,"path":"--out"}` —— **ok:true 把错误掩盖了**，而 CLI 的
 * `screencap --out x.png` 一直是对的（同一条链路两套规则）。
 *
 * 测法：记录型桩 daemon 记账 —— 断言"发出去的 out 字段是什么"。不碰设备、不落盘。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'maafw-live.mjs')
const STUB = join(HERE, 'fixtures', 'stub-recording-daemon.mjs')

async function runRepl(commands) {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-repl-cap-'))
  const log = join(dir, 'requests.jsonl')
  const child = spawn(process.execPath, [CLI, 'repl', '--kind', 'adb', '--target', 'stub'], {
    env: { ...process.env, MAA_DAEMON: STUB, MAAFW_STUB_LOG: log },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  let out = ''
  child.stdout.on('data', (d) => { out += String(d) })
  child.stdin.write(commands.join('\n') + '\n')
  child.stdin.end()

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      reject(new Error('15s 内 REPL 没退出（stdout 尾部：' + out.slice(-400) + '）'))
    }, 15000)
    child.on('exit', (c) => { clearTimeout(timer); resolve(c) })
  })

  let requests = []
  try {
    if (existsSync(log)) {
      requests = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    }
  } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  return { out, requests, code }
}

const caps = (requests) => requests.filter((r) => r.cmd === 'screencap')

test('repl screencap：--out 是旗标（旧行为写出名为 --out 的文件）', async () => {
  const { out, requests, code } = await runRepl([
    'screencap --out C:/tmp/a.png',
    'quit',
  ])
  assert.equal(code, 0, out)
  const reqs = caps(requests)
  assert.equal(reqs.length, 1, JSON.stringify(requests))
  assert.equal(reqs[0].out, 'C:/tmp/a.png', 'out 字段必须是目标路径，不是 "--out"：' + JSON.stringify(reqs[0]))
  assert.ok(!JSON.stringify(reqs).includes('"out":"--out"'), '不允许把 --out 当路径名发出去')
})

test('repl screencap：位置参数仍可用；未知选项明确报错且不发请求', async () => {
  const { out, requests, code } = await runRepl([
    'screencap C:/tmp/b.png',
    'screencap --oops',
    'quit',
  ])
  assert.equal(code, 0, out)
  const reqs = caps(requests)
  assert.equal(reqs.length, 1, '--oops 那条该只报用法、不发请求：' + JSON.stringify(requests))
  assert.equal(reqs[0].out, 'C:/tmp/b.png', JSON.stringify(reqs[0]))
  assert.match(out, /screencap 只认 --out/, out)
})

test('repl screencap：多条位置参数明确报错', async () => {
  const { out, requests } = await runRepl(['screencap a.png b.png', 'quit'])
  assert.match(out, /只写一个文件/, out)
  assert.equal(caps(requests).length, 0, JSON.stringify(requests))
})

test('repl screencap：不带参数照旧（daemon 自己挑落点）', async () => {
  const { requests } = await runRepl(['screencap', 'quit'])
  const reqs = caps(requests)
  assert.equal(reqs.length, 1, JSON.stringify(requests))
  assert.equal(reqs[0].out, undefined, '不给落点时不该凭空造一个 out：' + JSON.stringify(reqs[0]))
})
