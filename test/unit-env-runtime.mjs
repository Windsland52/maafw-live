/**
 * `env` 的 maa-node 对账面：报的是**正在运行的那份**，不是 cwd 里躺着的那份。
 *
 * 1. 临时项目里放一份 5.0.0 的假 `@maaxyz/maa-node`：`maa-node` 必须是 CLI 自己解析到的那份，
 *    副本另起一行 `maa-node(cwd)` 并列报出——全局安装时报成 cwd 版本正是这里要防的回归；
 * 2. 项目 pin 只与 self 对账：精确 pin 不等给 warning，范围 pin（`^5.0.0`）不判等、`exact` 为 null，
 *    因为判范围要 semver 解析，判错比不判更坏；package.json 的范围声明也不能顶掉 requirements.txt
 *    的精确 pin——范围回答不了「跑的是不是同一版」这个等式；
 * 3. requirements.txt 里真正的包名是 `MaaFW`（PyPI），版本是 PEP 440 的 `5.15.0b1` 这类预发布：
 *    包名要大小写不敏感、预发布要算精确版本；同 release 线的 qualifier 拼写差异
 *    （`5.15.0b1` 与 `5.15.0-beta.1`）指的是同一份构建，不算不一致。
 *
 * 「CLI 实际加载的版本」现场从仓库根跑一次 env 读出，不硬编码：依赖升级不该让这组用例假红/假绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const CLI = join(REPO, 'bin', 'maafw-live.mjs')

/** 副本的版本：与仓库自身的 maa-node 拉开距离，混了就能看出来报错的是哪份 */
const FAKE_VERSION = '5.0.0'

/** 跑一次一次性 CLI 命令，返回 {code, out, err}。env 会探测 git/adb/python（各 5s），超时给足 */
function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, MAAFW_LIVE_NO_UPDATE_CHECK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      reject(new Error('60s 未退出'))
    }, 60000)
    child.on('exit', (c) => { clearTimeout(timer); resolve({ code: c, out, err }) })
  })
}

/** --json 跑一次并取信封：stdout 不是纯 JSON 本身就是要钉的回归 */
async function envelope(args, cwd) {
  const { code, out, err } = await runCli([...args, '--json'], cwd)
  let env
  try {
    env = JSON.parse(out)
  } catch {
    throw new Error('stdout 不是 JSON 信封：' + out + err)
  }
  return { code, env, out, err }
}

const SELF_VERSION = await (async () => {
  const { env } = await envelope(['env'], REPO)
  const v = env.data?.maaNode?.version
  if (typeof v !== 'string' || !v) {
    throw new Error('仓库根跑 env 没拿到 data.maaNode.version：' + JSON.stringify(env.data))
  }
  return v
})()

/** human 里某个 item 的那一行：items 不在 --json 载荷里，状态只能看渲染结果 */
function itemLine(out, key) {
  return out.split('\n').find((l) => l.includes(key))
}

/** 造一个临时 Maa 项目：interface.json + 假的 @maaxyz/maa-node + 可选的 pin 声明源 */
function makeProject(t, { pin, requirements } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-env-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(
    join(dir, 'interface.json'),
    JSON.stringify({
      interface_version: 2,
      name: 'tmp-project',
      controller: [{ name: 'ADB', type: 'Adb' }],
      resource: [{ name: 'base', path: ['resource/base'] }],
    }, null, 2),
  )
  const pkgDir = join(dir, 'node_modules', '@maaxyz', 'maa-node')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@maaxyz/maa-node', version: FAKE_VERSION, main: 'index.js' }, null, 2),
  )
  writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {}\n')
  if (pin !== undefined) {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'tmp-project', private: true, dependencies: { '@maaxyz/maa-node': pin } }, null, 2),
    )
  }
  if (requirements !== undefined) writeFileSync(join(dir, 'requirements.txt'), requirements)
  return dir
}

test('env：cwd 的副本与 CLI 实际加载的那份并列，（精确 pin 一致）', { timeout: 60000 }, async (t) => {
  const dir = makeProject(t, { pin: SELF_VERSION })
  const { code, env } = await envelope(['env'], dir)
  assert.equal(code, 0, 'env 不因环境残缺而失败：' + JSON.stringify(env.warnings))
  assert.equal(env.data.maaNode.version, SELF_VERSION, 'maa-node 必须是 CLI 自己那份')
  assert.ok(
    !env.data.maaNode.path.includes(basename(dir)),
    'maa-node 的路径不能落在临时目录里：' + env.data.maaNode.path,
  )
  assert.equal(env.data.maaNodeCwd.version, FAKE_VERSION, JSON.stringify(env.data.maaNodeCwd))
  assert.ok(
    env.data.maaNodeCwd.path.includes(basename(dir)),
    '副本路径要在临时目录里：' + env.data.maaNodeCwd.path,
  )
  assert.notEqual(env.data.maaNode.path, env.data.maaNodeCwd.path, '两份必须是不同路径')
  assert.deepEqual(env.data.maaNodePin, {
    source: 'package.json',
    declared: SELF_VERSION,
    exact: SELF_VERSION,
  })
  assert.deepEqual(env.warnings, [], 'pin 一致且无缺项时不该有 warning')
})

test('env：human 输出里 maa-node(cwd) 那行要点名「本 CLI 不加载它」', { timeout: 60000 }, async (t) => {
  const dir = makeProject(t, { pin: SELF_VERSION })
  const { code, out } = await runCli(['env'], dir)
  assert.equal(code, 0, out)
  const line = out.split('\n').find((l) => l.includes('maa-node(cwd)'))
  assert.ok(line, '缺少 maa-node(cwd) 行：' + out)
  assert.match(line, /\[warn\]/, line)
  assert.ok(line.includes(FAKE_VERSION), '副本那行要报副本自己的版本：' + line)
  assert.match(line, /不加载它/, line)
})

test('env：精确 pin 不等 → warning 说清「项目 pin X，CLI 实际加载 Y」', { timeout: 60000 }, async (t) => {
  const dir = makeProject(t, { pin: '9.9.9' })
  const { code, env } = await envelope(['env'], dir)
  assert.equal(code, 0, '版本不一致不是「环境残缺」，不动退出码')
  assert.deepEqual(env.data.maaNodePin, { source: 'package.json', declared: '9.9.9', exact: '9.9.9' })
  const hit = env.warnings.filter((w) => w.includes('maa-node'))
  assert.equal(hit.length, 1, '要有且只有一条 maa-node 版本警告：' + JSON.stringify(env.warnings))
  assert.match(hit[0], /版本不一致/, hit[0])
  assert.ok(hit[0].includes('9.9.9'), '要报出项目 pin：' + hit[0])
  assert.ok(hit[0].includes(SELF_VERSION), '要报出 CLI 实际加载的版本：' + hit[0])
})

test('env：范围 pin → exact 为 null，不产生不一致 warning', { timeout: 60000 }, async (t) => {
  const dir = makeProject(t, { pin: '^5.0.0' })
  const { env } = await envelope(['env'], dir)
  assert.deepEqual(env.data.maaNodePin, { source: 'package.json', declared: '^5.0.0', exact: null })
  assert.equal(
    env.warnings.filter((w) => /版本不一致/.test(w)).length,
    0,
    '范围声明不判等：' + JSON.stringify(env.warnings),
  )
})

test('env：requirements.txt 的 maa 声明也算 pin（范围同样不判等）', { timeout: 60000 }, async (t) => {
  const dir = makeProject(t, {
    /* 伪装成 maa 的邻包不该被当成 pin */
    requirements: '# 运行时绑定\nmaa-evidence-kit==0.1.0\nmaa>=5.14\n',
  })
  const { env } = await envelope(['env'], dir)
  assert.deepEqual(env.data.maaNodePin, { source: 'requirements.txt', declared: 'maa>=5.14', exact: null })
  assert.equal(
    env.warnings.filter((w) => /版本不一致/.test(w)).length,
    0,
    JSON.stringify(env.warnings),
  )
})

test('env：PyPI 包名 MaaFW==5.15.0b1 → 预发布也判精确，与 CLI 不一致要报', { timeout: 60000 }, async (t) => {
  /* 现场形态：CLI 是 5.14.2，项目 pin 的是 5.15.0b1——判成范围就等于对真正要防的不一致视而不见 */
  const PIN = '5.15.0b1'
  const dir = makeProject(t, { requirements: `# Python 绑定\nMaaFW==${PIN}\n` })
  const { env } = await envelope(['env'], dir)
  assert.equal(env.data.maaNodePin.source, 'requirements.txt')
  assert.equal(env.data.maaNodePin.declared, `MaaFW==${PIN}`)
  assert.equal(env.data.maaNodePin.exact, PIN, 'PEP 440 预发布必须判成精确版本')
  if (SELF_VERSION === PIN) {
    t.diagnostic(`现场 self 恰好也是 ${PIN}：本条的不一致断言跳过`)
    return
  }
  assert.equal(env.warnings.length, 1, '恰一条 pin warning：' + JSON.stringify(env.warnings))
  assert.ok(env.warnings[0].includes(PIN), '要报出项目 pin：' + env.warnings[0])
  assert.ok(env.warnings[0].includes(SELF_VERSION), '要报出 CLI 实际加载的版本：' + env.warnings[0])
  const { out } = await runCli(['env'], dir)
  const line = itemLine(out, 'maa-node pin')
  assert.ok(line, '缺少 maa-node pin 行：' + out)
  assert.match(line, /\[warn\]/, line)
})

test('env：requirements.txt 写 maafw==<现场 self 版本> → 一致，不产生 pin warning', { timeout: 60000 }, async (t) => {
  /* 小写 maafw 与 MaaFW 是同一个包：包名匹配必须大小写不敏感 */
  const dir = makeProject(t, { requirements: `maafw==${SELF_VERSION}\n` })
  const { env } = await envelope(['env'], dir)
  assert.deepEqual(env.data.maaNodePin, {
    source: 'requirements.txt',
    declared: `maafw==${SELF_VERSION}`,
    exact: SELF_VERSION,
  })
  assert.equal(
    env.warnings.filter((w) => w.includes('maa-node')).length,
    0,
    JSON.stringify(env.warnings),
  )
  const { out } = await runCli(['env'], dir)
  const line = itemLine(out, 'maa-node pin')
  assert.ok(line, '缺少 maa-node pin 行：' + out)
  assert.match(line, /\[\s*ok\s*\]/, line)
})

test('env：PEP 440 的 5.15.0rc1 也判精确（不是范围声明）', { timeout: 60000 }, async (t) => {
  const PIN = '5.15.0rc1'
  const dir = makeProject(t, { requirements: `MaaFW==${PIN}\n` })
  const { env } = await envelope(['env'], dir)
  assert.equal(env.data.maaNodePin.exact, PIN, 'rc 后缀不能被当成范围声明')
  if (SELF_VERSION === PIN) {
    t.diagnostic(`现场 self 恰好也是 ${PIN}：不一致断言跳过`)
    return
  }
  assert.equal(
    env.warnings.filter((w) => w.includes('maa-node')).length,
    1,
    JSON.stringify(env.warnings),
  )
})

test('env：同 release 线、qualifier 拼写不同 → ok，不算不一致', { timeout: 60000 }, async (t) => {
  const m = /^(\d+\.\d+\.\d+)(.*)$/.exec(SELF_VERSION)
  assert.ok(m, 'self 版本不是 x.y.z 形态：' + SELF_VERSION)
  /* 造一个「同 release 线、qualifier 一定不同」的 pin：self 无后缀就加 b1，有后缀就剥掉 */
  const PIN = m[2] ? m[1] : `${m[1]}b1`
  const dir = makeProject(t, { requirements: `MaaFW==${PIN}\n` })
  const { env } = await envelope(['env'], dir)
  assert.equal(env.data.maaNodePin.exact, PIN)
  assert.deepEqual(env.warnings, [], '同 release 线的拼写差异不是不一致：' + JSON.stringify(env.warnings))
  const { out } = await runCli(['env'], dir)
  const line = itemLine(out, 'maa-node pin')
  assert.ok(line, '缺少 maa-node pin 行：' + out)
  assert.match(line, /\[\s*ok\s*\]/, line)
  assert.ok(line.includes(PIN) && line.includes(SELF_VERSION), '两个完整版本都要写进 detail：' + line)
})

test('env：package.json 只有范围时，requirements.txt 的精确 pin 不能被顶掉', { timeout: 60000 }, async (t) => {
  const PIN = '5.15.0b1'
  const dir = makeProject(t, { pin: '^5.14.2', requirements: `MaaFW==${PIN}\n` })
  const { env } = await envelope(['env'], dir)
  assert.equal(env.data.maaNodePin.source, 'requirements.txt', JSON.stringify(env.data.maaNodePin))
  assert.equal(env.data.maaNodePin.exact, PIN, '范围声明回答不了等式，精确声明优先')
  const selfRelease = /^(\d+\.\d+\.\d+)/.exec(SELF_VERSION)?.[1]
  if (selfRelease === '5.15.0') {
    t.diagnostic(`现场 self ${SELF_VERSION} 也落在 5.15.0 线：按 release 判等，跳过不一致断言`)
    return
  }
  assert.equal(env.warnings.length, 1, '有且仅有一条 pin warning：' + JSON.stringify(env.warnings))
  assert.ok(env.warnings[0].includes(PIN), '要报出精确 pin：' + env.warnings[0])
  assert.ok(env.warnings[0].includes(SELF_VERSION), '要报出 CLI 实际加载的版本：' + env.warnings[0])
})

test('env：package.json 写 npm 预发布拼写 5.14.2-beta.1 → 同 release 线，ok 且无 warning', { timeout: 60000 }, async (t) => {
  const m = /^(\d+\.\d+\.\d+)(.*)$/.exec(SELF_VERSION)
  assert.ok(m, 'self 版本不是 x.y.z 形态：' + SELF_VERSION)
  const PIN = `${m[1]}-beta.1`
  const dir = makeProject(t, { pin: PIN })
  const { env } = await envelope(['env'], dir)
  assert.deepEqual(env.data.maaNodePin, { source: 'package.json', declared: PIN, exact: PIN })
  assert.deepEqual(env.warnings, [], '同 release 线不产生 warning：' + JSON.stringify(env.warnings))
  const { out } = await runCli(['env'], dir)
  const line = itemLine(out, 'maa-node pin')
  assert.ok(line, '缺少 maa-node pin 行：' + out)
  assert.match(line, /\[\s*ok\s*\]/, line)
  assert.ok(line.includes(PIN), 'detail 要写出声明的完整版本：' + line)
  if (PIN !== SELF_VERSION) assert.ok(line.includes(SELF_VERSION), 'detail 要写出实际版本：' + line)
})
