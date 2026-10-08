/**
 * REPL 的输入参数校验（回归）：CLI 侧（`input.ts`）每条都有 `Number.isFinite`，REPL 曾经一条都没有——
 * 空参 `click` 会走 `Number(undefined)` = NaN → JSON 里变 null → daemon `Number(null)` = 0，
 * 也就是"什么都没写"等于"点左上角"，而 REPL 复用同一个设备会话，那一下是真机上的真实输入。
 *
 * 怎么测才不碰设备：用**记录型桩 daemon**（`MAA_DAEMON` 指过去）接住 REPL，把请求记账到文件，
 * 然后断言"该发的一条不少、不该发的一条没有"。管道喂 stdin 驱动会话，与手工验证用的是同一条配方。
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

/** 跑一次 REPL 会话（桩 daemon + 管道 stdin），返回 stdout、退出码与桩收到的请求 */
async function runRepl(commands) {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-repl-'))
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

  /* 桩是逐条 append 的，用 try 包住：读不到就当作空（断言会给出可读的失败） */
  let requests = []
  try {
    if (existsSync(log)) {
      requests = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    }
  } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  return { out, requests, code }
}

test('REPL 输入校验：空参/非数字只报用法且零请求，合法参数照发', async () => {
  const { out, requests, code } = await runRepl([
    'click',            // 空参：旧行为会发 {kind:'click',x:null,y:null} → 真机点 (0,0)
    'click abc 100',    // 非数字
    'click 620 520',    // 合法：必须照发
    'scroll 0 -120',    // 合法：必须照发
    'quit',
  ])

  assert.equal(code, 0, '会话正常结束：' + out)
  assert.match(out, /用法：click <x> <y>/, '空参要打印用法：' + out)

  const inputs = requests.filter((r) => r.cmd === 'input')
  const clicks = inputs.filter((r) => r.kind === 'click')
  assert.equal(clicks.length, 1, '只有那条合法 click 该被发出，实际：' + JSON.stringify(inputs))
  assert.deepEqual([clicks[0].x, clicks[0].y], [620, 520])
  assert.ok(!inputs.some((r) => r.x === null || r.y === null || r.dx === null || r.dy === null),
    '不允许把 null（NaN 在 JSON 里的样子）坐标发给设备：' + JSON.stringify(inputs))

  const scrolls = inputs.filter((r) => r.kind === 'scroll')
  assert.equal(scrolls.length, 1, '合法 scroll 必须照发：' + JSON.stringify(inputs))
  assert.deepEqual([scrolls[0].dx, scrolls[0].dy], [0, -120])
})

test('REPL 输入校验：keys 全非法时不发请求；非法 --duration 也不发', async () => {
  const { out, requests } = await runRepl([
    'keys',                       // 空参：至少一个正整数键码
    'keys xyz',                   // 非数字
    'press 100 200 --duration abc', // 位置对、旗标非法
    'swipe 1 2',                  // 参数不够
    'quit',
  ])
  assert.match(out, /用法：keys/, out)
  assert.match(out, /用法：press/, out)
  assert.match(out, /用法：swipe/, out)
  assert.equal(requests.filter((r) => r.cmd === 'input').length, 0,
    '这四条都该只报用法、零请求：' + JSON.stringify(requests.filter((r) => r.cmd === 'input')))
})
