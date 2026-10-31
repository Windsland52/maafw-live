/**
 * REPL `run` 的项目模式：必须与一次性 CLI 走同一条装配链。
 *
 * 回归的是 P0 行为分叉：REPL 曾经只吃 `--override`，`connect project` 之后同项目同入口
 * 跑 `run`，interface 的 global/resource/controller/task option 与 preset/default_case
 * 全部不生效，而且没有任何提示。这里用桩 daemon 记账，断言线上收到的 override 是
 * 四级链 + preset + 用户覆盖的结果，不是裸 `--override`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'maafw-live.mjs')
const STUB = join(HERE, 'fixtures', 'stub-recording-daemon.mjs')

function writeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-repl-run-'))
  writeFileSync(join(dir, 'interface.json'), JSON.stringify({
    interface_version: 2,
    name: 'repl-run',
    controller: [{ name: 'C1', type: 'Adb', option: ['ctlOpt'] }],
    resource: [{ name: 'R1', path: ['res'], option: ['resOpt'] }],
    task: [{ name: '启动', entry: 'StartUp', option: ['taskOpt'] }],
    option: {
      gOpt: { type: 'select', cases: [{ name: 'on', pipeline_override: { Node: { g: 1 } } }], default_case: 'on' },
      resOpt: { type: 'select', cases: [{ name: 'on', pipeline_override: { Node: { res: 2 } } }], default_case: 'on' },
      ctlOpt: { type: 'select', cases: [{ name: 'on', pipeline_override: { Node: { ctl: 3 } } }], default_case: 'on' },
      taskOpt: {
        type: 'select',
        cases: [
          { name: 'a', pipeline_override: { Node: { task: 'a' } } },
          { name: 'b', pipeline_override: { Node: { task: 'b' } } },
        ],
        default_case: 'a',
      },
    },
    global_option: ['gOpt'],
    preset: [{ name: 'P1', task: [{ name: '启动', option: { taskOpt: 'b' } }] }],
    agent: [{ child_exec: 'python', child_args: ['agent/main.py'] }],
  }, null, 2))
  return dir
}

test('repl run --project：线上覆盖链与 CLI run --project 同源', async (t) => {
  const dir = writeProject()
  const tmp = mkdtempSync(join(tmpdir(), 'maafw-repl-run-io-'))
  const log = join(tmp, 'requests.jsonl')
  const runs = join(tmp, 'runs')
  const child = spawn(process.execPath, [CLI, 'repl', '--project', dir], {
    env: {
      ...process.env,
      MAA_DAEMON: STUB,
      MAAFW_STUB_LOG: log,
      MAAFW_LIVE_RUNS_DIR: runs,
      MAAFW_STUB_REPLIES: JSON.stringify({
        device_list: [{ kind: 'adb', id: 'stub-addr', name: 'Stub' }],
        connect: { ok: true, session: { kind: 'adb', target: 'stub-addr', method: 'adb', resolution: { w: 1280, h: 720 }, warns: [] } },
        run: { record: { ok: true, entry: 'StartUp', status: 3000, nodes: [], startSeq: 1, endSeq: 2, framesCaptured: 2, timeoutMs: 1000, durationMs: 10 } },
      }),
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  t.after(() => {
    try { child.kill() } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  let out = ''
  child.stdout.on('data', (d) => { out += String(d) })
  child.stdin.write('run 启动 --preset P1 --override \'{"Node":{"user":9}}\' --timeout 1000\nquit\n')
  child.stdin.end()
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      reject(new Error('15s 内 REPL 没退出（stdout 尾部：' + out.slice(-500) + '）'))
    }, 15000)
    child.on('exit', () => { clearTimeout(timer); resolve() })
  })

  const requests = existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  const runReq = requests.find((r) => r.cmd === 'run')
  assert.ok(runReq, '必须真的发出 run 请求：' + JSON.stringify(requests.map((r) => r.cmd)))
  assert.equal(runReq.entry, 'StartUp', 'task 名要解析成 pipeline 入口')
  assert.deepEqual(runReq.resourceDirs, [join(dir, 'res')], '项目模式要发整链资源')
  assert.deepEqual(runReq.override, { Node: { g: 1, res: 2, ctl: 3, task: 'b', user: 9 } },
    '四级链 + preset + 用户 --override；只发裸 --override 就是旧分叉：' + JSON.stringify(runReq.override))
  assert.equal(runReq.timeoutMs, 1000, '--timeout 要原样送达：' + JSON.stringify(runReq))
  assert.deepEqual(runReq.agents, [{ exec: 'python', args: ['agent/main.py'] }], 'PI agent 声明要桥接到 daemon')
  assert.equal(resolve(runReq.agentCwd), resolve(dir), 'agentCwd 指向 interface.json 所在目录')
  assert.match(out, /override: taskOpt=b（task\.option，via preset）/, '人读回执要报出生效的 option：' + out)
  assert.match(out, /已提交 StartUp（任务 启动）/, '提交行保留 task 名与入口名：' + out)
})

test('cli run --project：同一份装配链（REPL 对齐的参照系）', async (t) => {
  const dir = writeProject()
  const tmp = mkdtempSync(join(tmpdir(), 'maafw-cli-run-io-'))
  const log = join(tmp, 'requests.jsonl')
  const child = spawn(process.execPath, [
    CLI, 'run', '--entry', '启动', '--project', dir, '--preset', 'P1',
    '--override', '{"Node":{"user":9}}', '--timeout', '1000',
  ], {
    env: {
      ...process.env,
      MAA_DAEMON: STUB,
      MAAFW_STUB_LOG: log,
      MAAFW_LIVE_RUNS_DIR: join(tmp, 'runs'),
      MAAFW_STUB_REPLIES: JSON.stringify({
        device_list: [{ kind: 'adb', id: 'stub-addr', name: 'Stub' }],
        connect: { ok: true, session: { kind: 'adb', target: 'stub-addr', method: 'adb', resolution: { w: 1280, h: 720 }, warns: [] } },
        run: { record: { ok: true, entry: 'StartUp', status: 3000, nodes: [], startSeq: 1, endSeq: 2, framesCaptured: 2, timeoutMs: 1000, durationMs: 10 } },
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => {
    try { child.kill() } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  let out = ''
  child.stdout.on('data', (d) => { out += String(d) })
  child.stderr.on('data', (d) => { out += String(d) })
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      reject(new Error('15s 内 CLI 没退出（输出尾部：' + out.slice(-500) + '）'))
    }, 15000)
    child.on('exit', (c) => { clearTimeout(timer); resolve(c) })
  })
  assert.equal(code, 0, '任务成功时 CLI 应退 0：' + out)

  const requests = existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  const runReq = requests.find((r) => r.cmd === 'run')
  assert.ok(runReq, 'CLI 也必须发出 run 请求：' + JSON.stringify(requests.map((r) => r.cmd)))
  assert.deepEqual(runReq.override, { Node: { g: 1, res: 2, ctl: 3, task: 'b', user: 9 } })
  assert.equal(runReq.timeoutMs, 1000, '--timeout 要原样送达：' + JSON.stringify(runReq))
  assert.deepEqual(runReq.agents, [{ exec: 'python', args: ['agent/main.py'] }])
  assert.equal(resolve(runReq.agentCwd), resolve(dir))
  assert.match(out, /override: taskOpt=b（task\.option，via preset）/, 'CLI 人读回执同样列出生效项：' + out)
})

test('repl run --resource-dir：只换资源，仍解析 interface 任务名', async (t) => {
  const dir = writeProject()
  const tmp = mkdtempSync(join(tmpdir(), 'maafw-repl-run-dir-'))
  const log = join(tmp, 'requests.jsonl')
  const runs = join(tmp, 'runs')
  const overlay = join(dir, 'overlay')
  const child = spawn(process.execPath, [CLI, 'repl', '--project', dir], {
    env: {
      ...process.env,
      MAA_DAEMON: STUB,
      MAAFW_STUB_LOG: log,
      MAAFW_LIVE_RUNS_DIR: runs,
      MAAFW_STUB_REPLIES: JSON.stringify({
        device_list: [{ kind: 'adb', id: 'stub-addr', name: 'Stub' }],
        connect: { ok: true, session: { kind: 'adb', target: 'stub-addr', method: 'adb', resolution: { w: 1280, h: 720 }, warns: [] } },
        run: { record: { ok: true, entry: 'StartUp', status: 3000, nodes: [], startSeq: 1, endSeq: 2, framesCaptured: 2, timeoutMs: 1000, durationMs: 10 } },
      }),
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  t.after(() => {
    try { child.kill() } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  let out = ''
  child.stdout.on('data', (d) => { out += String(d) })
  /* 单引号包路径：临时目录可能带空格；tokenizer 在引号里只把 \\ 与引号当转义。 */
  const cmdPath = overlay.replace(/\\/g, '/')
  child.stdin.write('run 启动 --preset P1 --resource-dir \'' + cmdPath + '\' --override \'{"Node":{"user":9}}\' --timeout 1000\nquit\n')
  child.stdin.end()
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      reject(new Error('15s 内 REPL 没退出（stdout 尾部：' + out.slice(-500) + '）'))
    }, 15000)
    child.on('exit', () => { clearTimeout(timer); resolvePromise() })
  })

  const requests = existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  const runReq = requests.find((r) => r.cmd === 'run')
  assert.ok(runReq, '必须真的发出 run 请求：' + JSON.stringify(requests.map((r) => r.cmd)))
  assert.equal(runReq.entry, 'StartUp', '显式 --resource-dir 不能把中文 task 名短路掉：' + JSON.stringify(runReq))
  assert.equal(resolve(String(runReq.resourceDir)), resolve(overlay), '显式资源目录要原样送达')
  assert.equal(runReq.resourceDirs, undefined, '显式资源是单包模式，不是项目整链')
  assert.deepEqual(runReq.override, { Node: { user: 9 } }, 'bundle 模式不叠 interface 四级链')
  assert.equal(runReq.agents, undefined, 'bundle 模式不桥接 agent')
  assert.equal(runReq.timeoutMs, 1000)
  assert.match(out, /--resource-dir 是 bundle 模式，不叠 interface 四级 override——--preset P1 不生效/,
    'preset 在 bundle 模式不生效，必须打一行警告：' + out)
  assert.match(out, /已提交 StartUp（任务 启动）/, '提交行仍是入口名 + 任务名：' + out)
})

