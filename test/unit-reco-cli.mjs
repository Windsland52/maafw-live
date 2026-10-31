/**
 * 一次性 CLI `reco` 的判据面（桩 daemon，无设备）：
 *
 * 1. **roi 越界**要被拦成明确错误（FINDINGS=3），而不是把"未命中"当结论；
 * 2. 无置信度的回执里，提示语要把 **roi 空间**列为首要疑因（旧文案只说"模板/资源没读到"，
 *    实测因此去查了资源目录、浪费一轮 —— G16 的 B 组）；
 * 3. 节点来源（`--node` / `--node-file` / `--node-name`）的参数面与互斥、miss 原因的派生、
 *    `--image` 走离线（不连设备）、整条资源链（含 attach）进回执。
 *
 * 用 `MAAFW_STUB_REPLIES` 给桩 daemon 指定 reco_test 的回执，把"daemon 会报什么"变成可造输入；
 * 用桩 daemon 的请求日志把"CLI 到底发了什么"钉住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'maafw-live.mjs')
const STUB = join(HERE, 'fixtures', 'stub-recording-daemon.mjs')

/** 跑一次一次性 CLI 命令（桩 daemon），返回 {code, out, err, requests}（requests = 桩收到的请求） */
function runCli(args, replies, stdin) {
  const log = join(tmpdir(), 'maafw-stub-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.jsonl')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        MAA_DAEMON: STUB,
        MAAFW_STUB_LOG: log,
        ...(replies ? { MAAFW_STUB_REPLIES: JSON.stringify(replies) } : {}),
        MAAFW_LIVE_NO_UPDATE_CHECK: '1',
      },
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    if (stdin !== undefined) {
      child.stdin.write(stdin)
      child.stdin.end()
    }
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } reject(new Error('30s 未退出')) }, 30000)
    child.on('exit', (c) => {
      clearTimeout(timer)
      let requests = []
      try {
        if (existsSync(log)) {
          requests = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        }
      } catch { /* ignore */ }
      try { rmSync(log, { force: true }) } catch { /* ignore */ }
      resolve({ code: c, out, err, requests })
    })
  })
}

const recoReqs = (requests) => requests.filter((r) => r.cmd === 'reco_test')

const IMAGE = join(HERE, 'fixtures', 'README.md')   // 只作存在性占位：桩 daemon 不读它

/** 临时项目：interface.json 的 resource.path[] 即整条链（+ 控制器的 attach 段） */
function makeProject({ paths = ['resource/base'], attach = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-reco-project-'))
  for (const p of paths) mkdirSync(join(dir, p), { recursive: true })
  for (const p of attach) mkdirSync(join(dir, p), { recursive: true })
  writeFileSync(join(dir, 'interface.json'), JSON.stringify({
    interface_version: 2,
    name: 'stub',
    controller: [{ name: 'win', type: 'Win32', win32: { class_regex: 'x', window_regex: 'y' }, attach_resource_path: attach }],
    resource: [{ name: 'demo', path: paths }],
    task: [],
  }))
  return dir
}

/** 临时文件：内容原样写入，返回路径 */
function tmpFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-reco-file-'))
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

test('CLI reco：roi 越出图像尺寸 → FINDINGS(3) 且明确说"用错空间"', async () => {
  const { code, err } = await runCli(
    ['reco', '--type', 'TemplateMatch', '--resource-dir', HERE, '--image', IMAGE,
      '--param', '{"template":"x.png","roi":[558,68,140,43]}'],
    { reco_test: { meta: { source: IMAGE, w: 480, h: 270 }, results: [{ param: { roi: [558, 68, 140, 43] }, ms: 9, ok: false }] } },
  )
  assert.equal(code, 3, 'FINDINGS：跑成了但发现问题。stdout/stderr：' + err)
  assert.match(err, /roi 越出图像/, err)
  assert.match(err, /480x270/, err)
})

test('CLI reco：roi 负坐标 → FINDINGS(3)（右下落在画面里，旧判据漏判）', async () => {
  const { code, err } = await runCli(
    ['reco', '--type', 'TemplateMatch', '--resource-dir', HERE, '--image', IMAGE,
      '--param', '{"template":"x.png","roi":[-50,200,80,300]}'],
    { reco_test: { meta: { source: IMAGE, w: 1280, h: 720 }, results: [{ param: { roi: [-50, 200, 80, 300] }, ms: 9, ok: false }] } },
  )
  assert.equal(code, 3, 'FINDINGS。stderr：' + err)
  assert.match(err, /roi 越出图像/, err)
  assert.match(err, /左上 -50,200 为负/, err)
})

test('CLI reco：roi 在界内 → 不拦，照常给结果与阈值建议', async () => {
  const { code, out } = await runCli(
    ['reco', '--type', 'TemplateMatch', '--resource-dir', HERE, '--image', IMAGE,
      '--param', '{"template":"x.png","roi":[0,0,100,50]}'],
    {
      reco_test: {
        meta: { source: IMAGE, w: 480, h: 270 },
        results: [{
          param: { roi: [0, 0, 100, 50] }, ms: 9, ok: true,
          detail: { detail: { all: [{ box: [1, 2, 3, 4], score: 0.97 }], best: { box: [1, 2, 3, 4], score: 0.97 } } },
        }],
      },
    },
  )
  assert.equal(code, 0, out)
  assert.match(out, /\[命中\]/, out)
  assert.match(out, /threshold 起点建议 0\.87/, out)
})

test('CLI reco：零置信度回执 → 提示语把 roi 空间列为首要疑因', async () => {
  const { code, out } = await runCli(
    ['reco', '--type', 'TemplateMatch', '--resource-dir', HERE, '--image', IMAGE,
      '--param', '{"template":"x.png","roi":[0,0,100,50]}'],
    { reco_test: { meta: { source: IMAGE, w: 480, h: 270 }, results: [{ param: { roi: [0, 0, 100, 50] }, ms: 230, ok: false }] } },
  )
  /* 未命中按文档契约给 FINDINGS(3)（README 码表与 protocol.ts 的 FINDINGS 注释都写着
   * "reco 未命中 → 3"）；本用例同时钉提示语。 */
  assert.equal(code, 3, out)
  assert.match(out, /识别未返回任何置信度/, out)
  assert.ok(out.includes('roi 是否越出所用图的尺寸'), '首要疑因要是 roi 空间：' + out)
  /* 提示段内部次序：roi 空间要先于"模板读不到"。逐例原因行也会出现"模板/资源"字样，
   * 所以只比提示段（从"识别未返回任何置信度（"那一段开始）。 */
  const advice = out.slice(out.indexOf('\n  识别未返回任何置信度（'))
  assert.ok(advice.indexOf('roi 是否越出') < advice.indexOf('模板/资源'), 'roi 要先于"模板读不到"出现：' + out)
})

test('CLI reco：--image 静态图 → 显式「离线评估」标注（防旧截图出分冒充实测）', async () => {
  const { code, out } = await runCli(
    ['reco', '--type', 'TemplateMatch', '--resource-dir', HERE, '--image', IMAGE,
      '--param', '{"template":"x.png","roi":[0,0,100,50]}'],
    { reco_test: { meta: { source: IMAGE, w: 480, h: 270 }, results: [{ param: { roi: [0, 0, 100, 50] }, ms: 9, ok: true }] } },
  )
  assert.equal(code, 0, out)
  assert.match(out, /离线评估（静态图 --image）/, '要标明离线来源：' + out)
  assert.match(out, /不构成真机验收证据/, '要写明不算验收证据：' + out)
  assert.match(out, /record\.ok/, '要指明验收判据是任务级 record.ok：' + out)
})

/* ───────────── 节点来源：--node / --node-file / --node-name ───────────── */

test('CLI reco：--node-file 按 JSONC 读（注释 + 尾随逗号），节点原样发出去', async () => {
  const file = tmpFile('node.json', '// pipeline 常带注释，JSON.parse 会误伤\n{\n  "recognition": "DirectHit",\n}\n')
  const { code, requests, err } = await runCli(
    ['reco', '--node-file', file, '--resource-dir', HERE, '--image', IMAGE],
    { reco_test: { meta: { source: IMAGE, w: 8, h: 8 }, results: [{ param: { recognition: 'DirectHit' }, ms: 5, ok: true }] } },
  )
  assert.equal(code, 0, err)
  const reqs = recoReqs(requests)
  assert.equal(reqs.length, 1, JSON.stringify(requests))
  assert.deepEqual(reqs[0].node, { recognition: 'DirectHit' }, '节点要原样透传：' + JSON.stringify(reqs[0]))
  assert.equal(reqs[0].paramSource, undefined, '节点来源不该再带 type 路径的参数')
})

test('CLI reco：--param-file 支持 stdin（`-`）——`^` 这类会被 cmd.exe 吃掉的字符原样到达', async () => {
  /* 桩回执给"命中"，让这条用例只钉参数运输（未命中的退出码另有用例） */
  const { code, requests, err } = await runCli(
    ['reco', '--type', 'OCR', '--resource-dir', HERE, '--image', IMAGE, '--param-file', '-'],
    { reco_test: { type: 'OCR', meta: { source: IMAGE, w: 8, h: 8 }, results: [{ param: {}, ms: 5, ok: true }] } },
    '{"expected": "^解锁"}',
  )
  assert.equal(code, 0, err)
  assert.deepEqual(recoReqs(requests)[0].param, { expected: '^解锁' },
    '参数必须原样到达（这就是文件通道存在的理由）：' + JSON.stringify(recoReqs(requests)[0]))
})

test('CLI reco：--node-file 指向节点表 → 用法错误(2) 且提示改用 --node-name', async () => {
  const file = tmpFile('pipeline.json', JSON.stringify({ A: { recognition: 'DirectHit' }, B: { recognition: 'DirectHit' } }))
  const { code, err, requests } = await runCli(['reco', '--node-file', file, '--resource-dir', HERE, '--image', IMAGE])
  assert.equal(code, 2, err)
  assert.match(err, /节点表/)
  assert.match(err, /--node-name/)
  assert.equal(recoReqs(requests).length, 0, '参数层就该拦掉，不该发请求')
})

test('CLI reco：节点来源互斥 / --param 与 --param-file 互斥 / 参数只作用于 --type 路径', async () => {
  const node = '{"recognition":"DirectHit"}'
  const file = tmpFile('node.json', node)
  const base = ['reco', '--resource-dir', HERE, '--image', IMAGE]
  let r = await runCli([...base, '--node', node, '--node-file', file])
  assert.equal(r.code, 2, r.err)
  assert.match(r.err, /节点来源互斥/)
  r = await runCli([...base, '--node', node, '--node-name', 'X'])
  assert.equal(r.code, 2, r.err)
  assert.match(r.err, /节点来源互斥/)
  r = await runCli([...base, '--param', '{}', '--param-file', file])
  assert.equal(r.code, 2, r.err)
  assert.match(r.err, /互斥/)
  r = await runCli([...base, '--node', node, '--param', '{"roi":[0,0,1,1]}'])
  assert.equal(r.code, 2, r.err)
  assert.match(r.err, /只作用于 --type 路径/)
  r = await runCli([...base, '--node-file', file, '--sweep', '{"min":0.5,"max":0.9}'])
  assert.equal(r.code, 2, r.err)
  assert.match(r.err, /只作用于 --type 路径/)
})

const hitReply = (w = 8, h = 8) => ({
  reco_test: {
    meta: { source: IMAGE, w, h },
    results: [{ param: { roi: [0, 0, 8, 8] }, ms: 5, ok: true, detail: { hit: true, detail: { all: [{ score: 0.9 }], best: { score: 0.9 } } } }],
  },
})

test('CLI reco：--image 走离线路径——给了静态图就不连设备（旧行为 --project --image 会 ensureSession）', async () => {
  const project = makeProject()
  try {
    const { code, requests, err } = await runCli(
      ['reco', '--project', project, '--type', 'TemplateMatch', '--image', IMAGE, '--param', '{"template":"x.png","roi":[0,0,8,8]}'],
      hitReply(),
    )
    assert.equal(code, 0, err)
    assert.equal(requests.filter((r) => r.cmd === 'connect').length, 0,
      '静态图不需要设备会话：' + JSON.stringify(requests.map((r) => r.cmd)))
    assert.equal(recoReqs(requests).length, 1)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('CLI reco：--node-name 发整条资源链（resource.path[] + attach 段），回执标 resource/layer/nodeDump', async () => {
  const project = makeProject({ paths: ['resource/base', 'resource/global_jp'], attach: ['resource/tw'] })
  try {
    const { code, out, err, requests } = await runCli(
      ['reco', '--project', project, '--node-name', 'ProbeNode', '--image', IMAGE, '--json'],
      {
        reco_test: {
          type: 'DirectHit', meta: { source: IMAGE, w: 8, h: 8 },
          results: [{ param: { nodeName: 'ProbeNode' }, ms: 5, ok: true }],
          nodeDump: { recognition: { type: 'DirectHit' }, action: { type: 'DoNothing' } },
        },
      },
    )
    assert.equal(code, 0, err)
    const req = recoReqs(requests)[0]
    assert.equal(req.nodeName, 'ProbeNode')
    assert.deepEqual(
      (req.resourceDirs ?? []).map((p) => basename(p)),
      ['base', 'global_jp', 'tw'],
      '整条链（含 attach 段）都要发出去：' + JSON.stringify(req.resourceDirs),
    )
    const env = JSON.parse(out)
    assert.equal(env.data.layer, 'resource', '要标明这是资源合并结果，不是 run 的四级覆盖：' + out)
    assert.equal(env.data.resource.name, 'demo')
    assert.deepEqual(env.data.resource.labels, ['base', 'global_jp', 'tw'])
    assert.equal(env.data.paramSource, 'node-name')
    assert.equal(env.data.nodeDump.recognition.type, 'DirectHit')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('CLI reco：--node-name 撞上 Custom 节点 → FINDINGS(3) 且说清"不桥接"，不能像 miss', async () => {
  const project = makeProject()
  try {
    const { code, err } = await runCli(
      ['reco', '--project', project, '--node-name', 'CustomNode', '--image', IMAGE],
      { reco_test: { ok: false, code: 'CUSTOM_NODE', error: '节点 CustomNode 的识别是 Custom：reco_test 不桥接 custom/agent 识别' } },
    )
    assert.equal(code, 3, err)
    assert.match(err, /不桥接/)
    assert.match(err, /RECO_CUSTOM_NODE/)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

/* ───────────────────── miss 原因与计数（按算法分口径） ───────────────────── */

const ocrReply = (all, ok = false) => ({
  reco_test: {
    type: 'OCR', meta: { source: IMAGE, w: 480, h: 270 },
    results: [{ param: { expected: 'x' }, ms: 9, ok, detail: { hit: ok, detail: { all, filtered: [] } } }],
  },
})

/** 资源目录带一套假的 OCR 模型三件套（判据只查存在性，不解析 onnx 内容） */
function makeOcrResource() {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-reco-ocr-'))
  mkdirSync(join(dir, 'model', 'ocr'), { recursive: true })
  for (const f of ['det.onnx', 'rec.onnx', 'keys.txt']) writeFileSync(join(dir, 'model', 'ocr', f), '')
  return dir
}

test('CLI reco：OCR 未命中——all 为空是"roi 内无文字"，all 非空是"expected 无匹配"', async () => {
  const res = makeOcrResource()
  try {
    let r = await runCli(
      ['reco', '--type', 'OCR', '--resource-dir', res, '--image', IMAGE, '--param', '{"expected":"x"}', '--json'],
      ocrReply([]),
    )
    assert.equal(r.code, 3, '未命中 → FINDINGS(3)：' + r.out)
    let env = JSON.parse(r.out)
    assert.equal(env.data.missReason, 'roi 内无文字', r.out)
    assert.equal(env.data.rawCount, 0)
    assert.equal(env.data.filteredCount, 0)

    r = await runCli(
      ['reco', '--type', 'OCR', '--resource-dir', res, '--image', IMAGE, '--param', '{"expected":"x"}', '--json'],
      ocrReply([{ text: '甲' }, { text: '乙' }]),
    )
    env = JSON.parse(r.out)
    assert.equal(env.data.missReason, 'expected 无匹配', r.out)
    assert.equal(env.data.rawCount, 2)
    assert.equal(env.data.results[0].rawCount, 2, '逐例也要带计数：' + r.out)
    assert.equal(env.data.results[0].filteredCount, 0)
  } finally {
    rmSync(res, { recursive: true, force: true })
  }
})

test('CLI reco：OCR 空结果且链上没有模型 → 原因指向模型，不是"roi 内无文字"', async () => {
  /* 实测同形：不带 model/ 的资源目录跑 OCR，框架不报错、只回 all:[]、hit:false、约 200ms。
   * 判成"roi 里没有字"就会让人去改 roi，而真正缺的是 model/ocr 的三件套。 */
  const { code, out } = await runCli(
    ['reco', '--type', 'OCR', '--resource-dir', HERE, '--image', IMAGE, '--param', '{"expected":"x"}', '--json'],
    ocrReply([]),
  )
  assert.equal(code, 3, out)
  const env = JSON.parse(out)
  assert.match(String(env.data.missReason), /OCR 模型不在资源链里/, out)
  assert.equal(env.data.rawCount, 0)
})

test('CLI reco：OCR 命中时不再被标成"无置信度"（旧判据在命中时也为真）', async () => {
  const { code, out } = await runCli(
    ['reco', '--type', 'OCR', '--resource-dir', HERE, '--image', IMAGE, '--param', '{"expected":"解锁"}', '--json'],
    ocrReply([{ text: '解锁' }], true),
  )
  assert.equal(code, 0, out)
  const env = JSON.parse(out)
  assert.equal(env.data.noConfidence, undefined, 'OCR 命中不该有 noConfidence：' + out)
  assert.equal(env.data.missReason, undefined)
  assert.equal(env.data.rawCount, 1)
})

test('CLI reco：模板匹配未命中且无分数 → noConfidence + 原因指向"读不到"，不是画面不匹配', async () => {
  const { code, out } = await runCli(
    ['reco', '--type', 'TemplateMatch', '--resource-dir', HERE, '--image', IMAGE, '--param', '{"template":"x.png"}', '--json'],
    {
      reco_test: {
        type: 'TemplateMatch', meta: { source: IMAGE, w: 480, h: 270 },
        results: [{ param: {}, ms: 230, ok: false, detail: { hit: false, detail: { all: [], filtered: [] } } }],
      },
    },
  )
  assert.equal(code, 3, out)
  const env = JSON.parse(out)
  assert.equal(env.data.noConfidence, true)
  assert.match(String(env.data.missReason), /未返回任何置信度/)
})

test('CLI reco：模板匹配有分数但不够 → 原因按"低分不匹配 / 低于阈值"分支，不用 expected 口径', async () => {
  const reply = (score) => ({
    reco_test: {
      type: 'TemplateMatch', meta: { source: IMAGE, w: 480, h: 270 },
      results: [{ param: {}, ms: 20, ok: false, detail: { hit: false, detail: { all: [{ score }], best: null } } }],
    },
  })
  const low = await runCli(['reco', '--type', 'TemplateMatch', '--resource-dir', HERE, '--image', IMAGE, '--param', '{"template":"x.png"}', '--json'], reply(0.1234))
  const lowEnv = JSON.parse(low.out)
  assert.equal(low.code, 3, '有分但不够也是未命中 → FINDINGS(3)')
  assert.match(String(lowEnv.data.missReason), /模板与画面不匹配（最高置信度 0\.123）/, low.out)

  const high = await runCli(['reco', '--type', 'TemplateMatch', '--resource-dir', HERE, '--image', IMAGE, '--param', '{"template":"x.png"}', '--json'], reply(0.83))
  const highEnv = JSON.parse(high.out)
  assert.equal(high.code, 3, '未命中 → FINDINGS(3)：' + high.out)
  assert.match(String(highEnv.data.missReason), /低于阈值（最高置信度 0\.83）/, high.out)
  assert.equal(highEnv.data.noConfidence, undefined, '有分数就不是"无置信度"：' + high.out)
})

test('CLI reco：逐例行把 miss 原因写在结果后面（人能一眼读到）', async () => {
  const res = makeOcrResource()
  try {
    const { code, out } = await runCli(
      ['reco', '--type', 'OCR', '--resource-dir', res, '--image', IMAGE, '--param', '{"expected":"x"}'],
      ocrReply([]),
    )
    assert.equal(code, 3, out)
    assert.match(out, /\[未中\].*← roi 内无文字/, out)
  } finally {
    rmSync(res, { recursive: true, force: true })
  }
})

test('CLI reco：--node-file - 从 stdin 读节点（argv 会被 shell 改写，stdin 也是一条通道）', async () => {
  const { code, requests, err } = await runCli(
    ['reco', '--node-file', '-', '--resource-dir', HERE, '--image', IMAGE],
    { reco_test: { meta: { source: IMAGE, w: 8, h: 8 }, results: [{ param: { recognition: 'DirectHit' }, ms: 5, ok: true }] } },
    '{"recognition": "DirectHit"}',
  )
  assert.equal(code, 0, err)
  assert.deepEqual(recoReqs(requests)[0].node, { recognition: 'DirectHit' },
    'stdin 内容要原样变成节点：' + JSON.stringify(recoReqs(requests)[0]))
})

test('CLI reco：--node-name 找不到节点时给资源里最接近的名字（否则只能对着资源目录逐个比对）', async () => {
  const project = makeProject()
  try {
    const { code, err } = await runCli(
      ['reco', '--project', project, '--node-name', 'ProbeNod', '--image', IMAGE],
      { reco_test: { ok: false, code: 'NODE_MISSING', error: '资源里没有名为 ProbeNod 的节点', candidates: ['ProbeNode', 'ProbeNode2'] } },
    )
    assert.equal(code, 3, err)
    assert.match(err, /RECO_NODE_MISSING/)
    assert.match(err, /最接近的节点名：ProbeNode \/ ProbeNode2/, err)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('CLI reco：--node-name 找不到且没有近邻时，hint 指回资源链而不是编一个名字', async () => {
  const project = makeProject()
  try {
    const { code, err } = await runCli(
      ['reco', '--project', project, '--node-name', 'Zzzzz', '--image', IMAGE],
      { reco_test: { ok: false, code: 'NODE_MISSING', error: '资源里没有名为 Zzzzz 的节点' } },
    )
    assert.equal(code, 3, err)
    assert.match(err, /确认资源名与链/, err)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('CLI reco：--help 的用法是真正的多行（字面 \\n 会把它压成一行），且保留 --from-kf 入口', async () => {
  const { code, out } = await runCli(['help', 'reco'])
  assert.equal(code, 0, out)
  const usageLines = out.split('\n').filter((l) => l.includes('maafw-live reco'))
  assert.ok(usageLines.length >= 4, '每条形要各占一行（否则说明串里是字面的 \\n）：' + JSON.stringify(usageLines))
  assert.match(out, /--from-kf <kf:/, '库内留存帧这条入口不能从 usage 里消失：' + out)
  assert.match(out, /--node-name <节点名>/, out)
})

test('CLI reco：识别子进程抛异常（detail 为 null）→ 标 [报错] + failed，不冒充未命中', async () => {
  /* 实测签名：OCR 模型文件损坏时子进程捕获到 "No graph was found in the protobuf."，
   * 回执 detail=null、ok:false、无 error 码——只写原因还不够，逐例行也不能打 [未中]。 */
  const replies = {
    reco_test: {
      type: 'OCR', meta: { source: IMAGE, w: 480, h: 270 },
      results: [{ param: { expected: 'x' }, ms: 257, ok: false, error: 'No graph was found in the protobuf.', detail: null }],
    },
  }
  const { code, out } = await runCli(
    ['reco', '--type', 'OCR', '--resource-dir', HERE, '--image', IMAGE, '--param', '{"expected":"x"}'],
    replies,
  )
  assert.equal(code, 3, '调用报错也是 FINDINGS(3)：' + out)
  assert.match(out, /识别调用报错：No graph was found in the protobuf\./, out)
  assert.match(out, /\[报错\]/, '逐例行要标 [报错]，不能打 [未中]：' + out)
  assert.doesNotMatch(out, /\[未中\]/, out)
  assert.match(out, /识别调用报错 1 例（上面标 \[报错\]）/, out)

  const jsonRun = await runCli(
    ['reco', '--type', 'OCR', '--resource-dir', HERE, '--image', IMAGE, '--param', '{"expected":"x"}', '--json'],
    replies,
  )
  const env = JSON.parse(jsonRun.out)
  assert.equal(env.data.results[0].failed, true, '机器侧要能区分"没跑成"与"未命中"：' + jsonRun.out)
  assert.match(String(env.data.missReason), /识别调用报错/)
})

test('CLI reco：--node-file 是缺 recognition 的单节点 → 报缺字段，不误报成节点表', async () => {
  const file = tmpFile('action-only.json', '{"action": {"type": "Click"}}')
  const { code, err } = await runCli(['reco', '--node-file', file, '--resource-dir', HERE, '--image', IMAGE])
  assert.equal(code, 2, err)
  assert.match(err, /缺少 recognition/, err)
  assert.doesNotMatch(err, /节点表/, '单节点缺字段不等于"文件里是节点表"：' + err)
})

test('CLI reco：多例（--sweep）任一例未命中 → FINDINGS(3)，全中才是 0', async () => {
  /* 阈值扫描几乎必然有未中例：若按"最后一例/多数例"判，sweep 的退出码会随机漂。口径是"任一例未中"。 */
  const replies = {
    reco_test: {
      type: 'TemplateMatch', meta: { source: IMAGE, w: 480, h: 270 },
      results: [
        { param: { threshold: 0.7 }, ms: 9, ok: true, detail: { hit: true, detail: { all: [{ score: 0.9 }] } } },
        { param: { threshold: 0.9 }, ms: 9, ok: false, detail: { hit: false, detail: { all: [{ score: 0.82 }] } } },
      ],
    },
  }
  const mixed = await runCli(
    ['reco', '--type', 'TemplateMatch', '--resource-dir', HERE, '--image', IMAGE,
      '--sweep', '{"min":0.7,"max":0.9,"step":0.2}', '--json'],
    replies,
  )
  assert.equal(mixed.code, 3, '9 中 1 不中 → 3：' + mixed.out)

  const allHit = await runCli(
    ['reco', '--type', 'TemplateMatch', '--resource-dir', HERE, '--image', IMAGE,
      '--sweep', '{"min":0.7,"max":0.9,"step":0.2}', '--json'],
    {
      reco_test: {
        type: 'TemplateMatch', meta: { source: IMAGE, w: 480, h: 270 },
        results: [
          { param: { threshold: 0.7 }, ms: 9, ok: true, detail: { hit: true, detail: { all: [{ score: 0.9 }] } } },
          { param: { threshold: 0.9 }, ms: 9, ok: true, detail: { hit: true, detail: { all: [{ score: 0.9 }] } } },
        ],
      },
    },
  )
  assert.equal(allHit.code, 0, '全中 → 0：' + allHit.out)
})
