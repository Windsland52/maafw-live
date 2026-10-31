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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recoParam } from '../lib/commands/repl.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'maafw-live.mjs')
const STUB = join(HERE, 'fixtures', 'stub-recording-daemon.mjs')

/** 跑一次 REPL 会话（桩 daemon + 管道 stdin），返回 stdout、退出码与桩收到的请求。 */
async function runRepl(commands, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-repl-reco-'))
  const log = join(dir, 'requests.jsonl')
  const child = spawn(process.execPath, [CLI, 'repl', '--kind', 'adb', '--target', 'stub'], {
    env: { ...process.env, MAA_DAEMON: STUB, MAAFW_STUB_LOG: log, ...env },
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

test('repl reco：--image 与 --seq 透传（旧行为静默丢弃 --image）', async () => {
  const { out, requests, code } = await runRepl([
    'reco TemplateMatch template=a/Leaders.png roi=558,68,140,43 --resource-dir R --image C:/tmp/kf21.png',
    'reco TemplateMatch template=a/Leaders.png roi=0,180,1280,420 --resource-dir R --seq 2',
    'reco TemplateMatch template=a/Leaders.png --resource-dir R --seq abc',
    'quit',
  ])
  assert.equal(code, 0, '会话正常结束：' + out)
  const reqs = recoReqs(requests)
  assert.equal(reqs.length, 2, '--seq abc 该只报用法、不发请求：' + JSON.stringify(reqs))
  assert.equal(reqs[0].image, 'C:/tmp/kf21.png', '--image 必须透传：' + JSON.stringify(reqs[0]))
  assert.equal(reqs[0].seq, undefined, '--image 时不该额外造一个 seq')
  assert.equal(reqs[1].seq, 2, '--seq 必须透传：' + JSON.stringify(reqs[1]))
  assert.equal(reqs[1].image, undefined)
  assert.match(out, /--seq 必须是数字/, out)
})

test('repl reco：缺 --resource-dir 时明确报错、不发请求（旧行为是静默零例数）', async () => {
  const { out, requests, code } = await runRepl([
    'reco TemplateMatch template=a/Leaders.png roi=558,68,140,43',
    'quit',
  ])
  assert.equal(code, 0)
  assert.match(out, /缺资源目录/, '要说清病因，而不是回一个 results: []：' + out)
  assert.equal(recoReqs(requests).length, 0, '拦在前面的校验不该把请求发出去：' + JSON.stringify(requests))
})

test('repl reco：roi 负坐标也算越界（[−50,…] 的右下落在画面里，旧的只比右下会漏判）', async () => {
  const { out, requests, code } = await runRepl(
    ['reco TemplateMatch template=a/Leaders.png roi=-50,200,80,300 --resource-dir R', 'quit'],
    {
      MAAFW_STUB_REPLIES: JSON.stringify({
        reco_test: { meta: { seq: 2, w: 1280, h: 720 }, results: [{ param: {}, ms: 5, ok: false }] },
      }),
    },
  )
  assert.equal(code, 0)
  assert.equal(recoReqs(requests).length, 1, '请求该发出去，越界是拿回执尺寸判的')
  assert.match(out, /roi 越出图像/, out)
  assert.match(out, /左上 -50,200 为负/, out)
  assert.ok(!/"results"/.test(out), '越界时不该把"未命中"当结论打出来：' + out)
})

test('repl reco：roi 越界（ctrl 坐标打在 L1 小图上）明确报错、不静默', async () => {
  /* 桩装作 daemon：回执 meta 是 L1 小图 480x270，roi 却是 ctrl 空间的 558,68,140,43 */
  const { out, requests, code } = await runRepl(
    ['reco TemplateMatch template=a/Leaders.png roi=558,68,140,43 --resource-dir R', 'quit'],
    {
      MAAFW_STUB_REPLIES: JSON.stringify({
        reco_test: { meta: { seq: 2, w: 480, h: 270 }, results: [{ param: {}, ms: 5, ok: false }] },
      }),
    },
  )
  assert.equal(code, 0)
  assert.equal(recoReqs(requests).length, 1, '请求本身该发出去（越界是拿回执判的）')
  assert.match(out, /roi 越出图像/, '要明确指出用错空间：' + out)
  assert.match(out, /480x270/, out)
  assert.ok(!/"results"/.test(out), '越界时不该再把"未命中"的 JSON 当结论打出来：' + out)
})

test('unit: roiOutOfBounds 的边界口径（贴边不算越界，缺尺寸不判）', async () => {
  const { roiOutOfBounds } = await import('../lib/runtime/reco-args.js')
  assert.equal(roiOutOfBounds([0, 0, 1280, 720], 1280, 720), null, '正好铺满不算越界')
  assert.equal(roiOutOfBounds([1000, 600, 280, 120], 1280, 720), null)
  assert.match(String(roiOutOfBounds([558, 68, 140, 43], 480, 270)), /roi 越出图像/)
  assert.match(String(roiOutOfBounds([0, 200, 100, 100], 480, 270)), /超出图像尺寸 480x270/)
  assert.equal(roiOutOfBounds([1, 2, 3], 480, 270), null, '不是 4 元组不由这里判')
  assert.equal(roiOutOfBounds([0, 0, 9999, 9999], undefined, undefined), null, '缺尺寸不判（不猜）')
  assert.equal(roiOutOfBounds(undefined, 480, 270), null)
})

test('unit: roiOutOfBounds 也判左上边界——负坐标是最典型的"空间算错"', async () => {
  const { roiOutOfBounds } = await import('../lib/runtime/reco-args.js')
  /* [-50,200,80,300] 的右下是 30/500（落在画面内），只比右下会漏判 */
  const negX = roiOutOfBounds([-50, 200, 80, 300], 1280, 720)
  assert.match(String(negX), /roi 越出图像/, '负 x 必须拦下：' + String(negX))
  assert.match(String(negX), /左上 -50,200 为负/, String(negX))
  const negY = roiOutOfBounds([940, -30, 160, 300], 1280, 720)
  assert.match(String(negY), /左上 940,-30 为负/, String(negY))
  /* 只负、不越右下 —— 上面的两个用例都是这种；这里再确认"既负又越右下"也如实说 */
  assert.match(String(roiOutOfBounds([-50, 200, 2000, 300], 1280, 720)), /且右 1950 \/ 下 500 超出/)
  assert.equal(roiOutOfBounds([0, 0, 10, 10], 1280, 720), null, '0 不是负')
})

test('repl reco：--from-kf 传的是 kfSource 对象（daemon 收对象，不是 flag 字符串）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-repl-kf-'))
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64')
  const pngFile = join(dir, '0001.png')
  writeFileSync(pngFile, png)
  const id = 'kf:11111111-0000-4000-8000-000000000001:0001'
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    schema: 1, libraryId: '11111111-0000-4000-8000-000000000001', next: 2,
    frames: [{
      id, file: '0001.png', sha256: createHash('sha256').update(png).digest('hex'),
      session: { daemon: 'd', gen: 1, kind: 'adb', target: 'stub' },
      capturedAt: '2026-10-05T10:00:00.000Z', captureSeq: 7, ctrlW: 1, ctrlH: 1,
      smallW: null, smallH: null, scale: null, source: 'explicit', note: null,
    }],
  }))

  try {
    const { out, requests, code } = await runRepl([
      'reco TemplateMatch template=a/Leaders.png --resource-dir R --from-kf ' + id + ' --frames-dir ' + dir,
      'quit',
    ])
    assert.equal(code, 0, '会话正常结束：' + out)
    const reqs = recoReqs(requests)
    assert.equal(reqs.length, 1, '应当只发一条 reco_test：' + JSON.stringify(requests))
    const src = reqs[0].kfSource
    assert.ok(src && typeof src === 'object', '--from-kf 要传对象：' + JSON.stringify(reqs[0]))
    assert.equal(src.id, id)
    assert.equal(src.path.replace(/\\/g, '/'), pngFile.replace(/\\/g, '/'))
    assert.equal(src.ctrlW, 1)
    assert.equal(src.ctrlH, 1)
    assert.equal(reqs[0].image, undefined, 'kfSource 路径不该同时塞 image')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repl reco：--image 静态图 → 离线评估标注行（防旧截图出分冒充实测）', async () => {
  const { out, code } = await runRepl([
    'reco TemplateMatch template=a/Leaders.png --resource-dir R --image C:/tmp/kf21.png',
    'quit',
  ])
  assert.equal(code, 0, '会话正常结束：' + out)
  assert.match(out, /离线评估（静态图 --image）/, '标注行要在结果前给出：' + out)
  assert.match(out, /不构成真机验收证据/, out)
})

test('repl reco：--seq 会话缓冲帧 → 不打离线标注（它来自本会话帧流）', async () => {
  const { out, requests } = await runRepl([
    'reco TemplateMatch template=a/Leaders.png --resource-dir R --seq 2',
    'quit',
  ])
  assert.equal(recoReqs(requests).length, 1, '--seq 该真发出去（不是被拦掉才没有标注）：' + JSON.stringify(requests))
  assert.doesNotMatch(out, /离线评估/, '会话缓冲帧不算离线证据：' + out)
})

test('repl reco：--node-file 发 node 对象（JSONC 读入），不再带 type 路径的 param', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-repl-node-'))
  const file = join(dir, 'node.json')
  writeFileSync(file, '// 注释\n{\n  "recognition": "DirectHit",\n}\n')
  try {
    const { out, requests, code } = await runRepl([
      'reco --resource-dir R --node-file ' + file,
      'quit',
    ])
    assert.equal(code, 0, '会话正常结束：' + out)
    const reqs = recoReqs(requests)
    assert.equal(reqs.length, 1, '应当只发一条 reco_test：' + JSON.stringify(requests))
    assert.deepEqual(reqs[0].node, { recognition: 'DirectHit' }, '--node-file 要发对象：' + JSON.stringify(reqs[0]))
    assert.equal(reqs[0].param, undefined, '节点来源不该再带 type 路径的参数')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repl reco：--node-name 发原名（资源合并后按名跑）', async () => {
  const { out, requests, code } = await runRepl([
    'reco --resource-dir R --node-name ProbeNode',
    'quit',
  ])
  assert.equal(code, 0, '会话正常结束：' + out)
  const reqs = recoReqs(requests)
  assert.equal(reqs.length, 1, '应当只发一条 reco_test：' + JSON.stringify(requests))
  assert.equal(reqs[0].nodeName, 'ProbeNode')
  assert.equal(reqs[0].param, undefined)
  assert.match(out, /layer=resource/, '要标明只到资源合并结果：' + out)
})

test('repl reco：节点来源互斥、且与 k=v 参数互斥（不静默忽略）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-repl-node-'))
  const file = join(dir, 'node.json')
  writeFileSync(file, '{"recognition":"DirectHit"}')
  try {
    const { out, requests, code } = await runRepl([
      'reco --resource-dir R --node-file ' + file + ' --node-name ProbeNode',
      'reco --resource-dir R --node-file ' + file + ' template=a.png',
      'quit',
    ])
    assert.equal(code, 0, '会话正常结束：' + out)
    assert.match(out, /--node-file 与 --node-name 互斥/, out)
    assert.match(out, /只作用于 <type> 路径/, out)
    assert.equal(recoReqs(requests).length, 0, '参数层就该拦掉：' + JSON.stringify(requests))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repl reco：--node-name 撞上 Custom 节点 → 明说不桥接，不当 miss', async () => {
  const { out, code } = await runRepl(
    ['reco --resource-dir R --node-name CustomNode', 'quit'],
    { MAAFW_STUB_REPLIES: JSON.stringify({ reco_test: { ok: false, code: 'CUSTOM_NODE', error: '节点 CustomNode 的识别是 Custom' } }) },
  )
  assert.equal(code, 0, '会话正常结束：' + out)
  assert.match(out, /custom\/agent 识别要桥接/, out)
})

test('repl reco：未命中原因是本地派生的（daemon 只回原始 detail，不产 missReason）', async () => {
  const { out, code } = await runRepl(
    ['reco OCR --resource-dir R', 'quit'],
    {
      MAAFW_STUB_REPLIES: JSON.stringify({
        reco_test: {
          type: 'OCR', meta: { seq: 2, w: 480, h: 270 },
          results: [{ param: {}, ms: 9, ok: false, detail: { hit: false, detail: { all: [], filtered: [] } } }],
        },
      }),
    },
  )
  assert.equal(code, 0, out)
  /* R 不存在 → 链上没有 OCR 模型：空结果要先指向模型，不是"roi 里没有字" */
  assert.match(out, /未命中原因：OCR 模型不在资源链里/, 'REPL 也要给原因，不能只回 JSON 让人自己翻 all/filtered：' + out)
  assert.match(out, /候选 all=0 filtered=0/, out)
})

test('repl reco：链上有 OCR 模型时，空结果才说"roi 内无文字"', async () => {
  const res = mkdtempSync(join(tmpdir(), 'maafw-repl-ocr-'))
  mkdirSync(join(res, 'model', 'ocr'), { recursive: true })
  for (const f of ['det.onnx', 'rec.onnx', 'keys.txt']) writeFileSync(join(res, 'model', 'ocr', f), '')
  try {
    const { out, code } = await runRepl(
      ['reco OCR --resource-dir ' + res, 'quit'],
      {
        MAAFW_STUB_REPLIES: JSON.stringify({
          reco_test: {
            type: 'OCR', meta: { seq: 2, w: 480, h: 270 },
            results: [{ param: {}, ms: 9, ok: false, detail: { hit: false, detail: { all: [], filtered: [] } } }],
          },
        }),
      },
    )
    assert.equal(code, 0, out)
    assert.match(out, /未命中原因：roi 内无文字/, out)
  } finally {
    rmSync(res, { recursive: true, force: true })
  }
})

test('repl reco：--param-file 发文件里的参数（管道驱动 REPL 也能绕开 ^ 被 shell 吃掉）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-repl-param-'))
  const file = join(dir, 'param.json')
  writeFileSync(file, '// 注释\n{"expected": "^解锁"}\n')
  try {
    const { out, requests, code } = await runRepl([
      'reco OCR --resource-dir R --param-file ' + file,
      'quit',
    ])
    assert.equal(code, 0, '会话正常结束：' + out)
    const reqs = recoReqs(requests)
    assert.equal(reqs.length, 1, '应当只发一条 reco_test：' + JSON.stringify(requests))
    assert.deepEqual(reqs[0].param, { expected: '^解锁' }, '参数要原样到达：' + JSON.stringify(reqs[0]))
    assert.equal(reqs[0].type, 'OCR')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repl reco：--param-file 与 k=v 参数互斥', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-repl-param-'))
  const file = join(dir, 'param.json')
  writeFileSync(file, '{"expected":"x"}')
  try {
    const { out, requests, code } = await runRepl([
      'reco OCR expected=y --resource-dir R --param-file ' + file,
      'quit',
    ])
    assert.equal(code, 0, out)
    assert.match(out, /k=v 参数与 --param-file 互斥/, out)
    assert.equal(recoReqs(requests).length, 0, '参数层就该拦掉：' + JSON.stringify(requests))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repl reco：--node-file - / --param-file - 直接拒绝（REPL 的 stdin 是命令流）', async () => {
  const { out, requests, code } = await runRepl([
    'reco --resource-dir R --node-file -',
    'reco OCR --resource-dir R --param-file -',
    'quit',
  ])
  assert.equal(code, 0, out)
  assert.match(out, /不接受 -/, '要说清为什么：stdin 是命令流：' + out)
  assert.equal(out.match(/不接受 -/g)?.length, 2, out)
  assert.equal(recoReqs(requests).length, 0, '不该拿会话输入当节点/参数文件：' + JSON.stringify(requests))
})

test('repl reco：节点名拼错给近邻建议', async () => {
  const { out, code } = await runRepl(
    ['reco --resource-dir R --node-name ProbeNod', 'quit'],
    {
      MAAFW_STUB_REPLIES: JSON.stringify({
        reco_test: { ok: false, code: 'NODE_MISSING', error: '资源里没有名为 ProbeNod 的节点', candidates: ['ProbeNode'] },
      }),
    },
  )
  assert.equal(code, 0, out)
  assert.match(out, /最接近的节点名：ProbeNode/, out)
})

test('repl reco：类型是位置参数——选项/ k=v 打头时回缺省类型，不能被当成类型', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-repl-type-'))
  const file = join(dir, 'param.json')
  writeFileSync(file, '{"expected":"解锁"}')
  try {
    /* 帮助里写的 `reco --param-file p.json` 就是这样打头的：旧代码把 tokens[1] 当类型，
     * type 会变成字符串 "--param-file"（子进程拿到一个不存在的识别类型）。 */
    const { out, requests, code } = await runRepl([
      'reco --resource-dir R --param-file ' + file,
      'reco --resource-dir R --node-name ProbeNode',
      'quit',
    ])
    assert.equal(code, 0, '会话正常结束：' + out)
    const reqs = recoReqs(requests)
    assert.equal(reqs.length, 2, '两条命令都该发出去：' + JSON.stringify(requests))
    assert.equal(reqs[0].type, 'TemplateMatch', '选项打头时类型要回缺省值：' + JSON.stringify(reqs[0]))
    assert.deepEqual(reqs[0].param, { expected: '解锁' })
    assert.equal(reqs[1].type, 'TemplateMatch', '--node-name 打头同理：' + JSON.stringify(reqs[1]))
    assert.equal(reqs[1].nodeName, 'ProbeNode')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repl reco：调用报错单独一行，不混进"未命中原因"', async () => {
  const { out, code } = await runRepl(
    ['reco OCR --resource-dir R', 'quit'],
    {
      MAAFW_STUB_REPLIES: JSON.stringify({
        reco_test: {
          type: 'OCR', meta: { seq: 2, w: 480, h: 270 },
          results: [{ param: {}, ms: 257, ok: false, error: 'No graph was found in the protobuf.', detail: null }],
        },
      }),
    },
  )
  assert.equal(code, 0, out)
  assert.match(out, /识别调用报错 1 例（\[报错\]，不是未命中）/, out)
  assert.doesNotMatch(out, /未命中原因：识别调用报错/, '别把它说成未命中：' + out)
})
