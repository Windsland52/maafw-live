/**
 * repl `reco` 的参数面（回归）：k=v 的**列表参数**必须落成数组，且 --image / --seq 要真发出去。
 *
 * 为什么这条最贵：`Number("558,68,140,43")` = NaN → 整串当字符串发给 daemon → MaaFW 只认
 * `is_array()`，字符串被当**节点名**解析 → 回执 `ok:false`、无置信度，**看起来像"模板没读到"**。
 * 本文件里 frame/crop/color/wait/annotate/swipe 早就按逗号拆；`reco` 是唯一遗漏。
 *
 * 两段各测一层：
 * 1. `recoParam` 纯函数——直接断言类型，不碰设备；
 * 2. 记录型桩 daemon + 管道 stdin——断言"线上真正发出去的 payload"（集成面，含 `--image`）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recoParam } from '../lib/commands/repl.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'maafw-live.mjs')
const STUB = join(HERE, 'fixtures', 'stub-recording-daemon.mjs')

/** 跑一次 REPL 会话（桩 daemon + 管道 stdin），返回 stdout、退出码与桩收到的请求。 */
async function runRepl(commands) {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-repl-reco-'))
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

const recoReqs = (requests) => requests.filter((r) => r.cmd === 'reco_test')

test('recoParam：roi 的单值逗号写法落成数组（这是 G16 的 1a）', () => {
  const p = recoParam(['reco', 'TemplateMatch', 'template=a/b.png', 'roi=558,68,140,43'])
  assert.deepEqual(p.roi, [558, 68, 140, 43], 'roi 必须是数组：' + JSON.stringify(p))
  assert.equal(p.template, 'a/b.png')
})

test('recoParam：roi 的 [...] 括号写法等价', () => {
  assert.deepEqual(recoParam(['reco', 'TemplateMatch', 'roi=[558,68,140,43]']).roi, [558, 68, 140, 43])
  assert.deepEqual(recoParam(['reco', 'TemplateMatch', 'roi=[ 558,68 ,140,43 ]']).roi, [558, 68, 140, 43])
})

test('recoParam：expected 保持原样（字符串与数组都命中，不按逗号拆文本）', () => {
  assert.equal(recoParam(['reco', 'OCR', 'expected=选择领队']).expected, '选择领队')
  assert.equal(recoParam(['reco', 'OCR', 'expected=选,择']).expected, '选,择',
    'OCR 的逗号可能是文本本身；要数组请走 --param \'{"expected":[...]}\'')
})

test('recoParam：数字转 number、其余保持字符串（既有惯例不变）', () => {
  const p = recoParam(['reco', 'TemplateMatch', 'threshold=0.8', 'template=a.png', 'method=5'])
  assert.equal(p.threshold, 0.8)
  assert.equal(p.method, 5)
  assert.equal(p.template, 'a.png')
})

test('recoParam：列表里混进非数字 → 退回原字符串，不静默改成 NaN', () => {
  const p = recoParam(['reco', 'TemplateMatch', 'roi=558,abc,140,43'])
  assert.equal(p.roi, '558,abc,140,43')
  assert.ok(!Array.isArray(p.roi), '宁可不拆，也不发 [558,NaN,140,43]')
  assert.equal(recoParam(['reco', 'TemplateMatch', 'roi=1,,2']).roi, '1,,2')
})

test('recoParam：非列表参数不擅自升级成数组', () => {
  /* roi_offset 在 pipeline 里可以是标量；全局"看着像数字就拆"会误伤 */
  const p = recoParam(['reco', 'TemplateMatch', 'roi_offset=1,2,3,4', 'order_by=Score'])
  assert.equal(p.roi_offset, '1,2,3,4')
  assert.equal(p.order_by, 'Score')
})

test('repl reco：roi 数组真发到线上（集成面，桩 daemon 记账）', async () => {
  const { out, requests, code } = await runRepl([
    'reco TemplateMatch template=a/Leaders.png roi=558,68,140,43 --resource-dir R',
    'quit',
  ])
  assert.equal(code, 0, '会话正常结束：' + out)
  const reqs = recoReqs(requests)
  assert.equal(reqs.length, 1, '应当只发一条 reco_test：' + JSON.stringify(requests))
  assert.deepEqual(reqs[0].param.roi, [558, 68, 140, 43],
    'roi 必须是数组，否则 MaaFW 当节点名解析 → ok:false：' + JSON.stringify(reqs[0]))
  assert.equal(reqs[0].resourceDir, 'R')
  assert.equal(reqs[0].type, 'TemplateMatch')
})
