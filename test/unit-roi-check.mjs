/**
 * `roi-check` 的三态判据（桩 daemon，无设备）：HIT / MISS / AMBIGUOUS，以及退出码语义。
 *
 * 这是 G17 第一层的灵魂：**允许说「分不出来」**。两套候选（本位置 vs 偏移半周期）分差
 * < 0.15 时必须 AMBIGUOUS + 退出 3 —— 本案例 8 个几何脚本全部收敛到错误相位、没有一个
 * 承认过不确定，这才是最贵的返工来源。
 *
 * 造分手段：桩 daemon 按请求内容分支回执。本命令的候选现在走**批量通道**
 * （`reco_test` 的 `candidates`，一次子进程跑完本位置 + 两个对照位置），所以桩的规则键
 * 从 `param.roi.0` 换成 `candidates`，逐例分数用 `data.perCase` 按位置给
 * （桩会把 `param.roi` 回成该例自己的候选）。**回执断言一字未改**——改的只是"分数从哪条路进去"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'maafw-live.mjs')
const STUB = join(HERE, 'fixtures', 'stub-recording-daemon.mjs')

/** 造一张只作存在性占位的 png（桩 daemon 不读像素） */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64')

/** 跑一次一次性 CLI 命令（桩 daemon + 内容分支回执），返回 {code, out, err} */
function runCli(args, rules) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        MAA_DAEMON: STUB,
        MAAFW_STUB_LOG: join(tmpdir(), 'maafw-roicheck-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.jsonl'),
        ...(rules ? { MAAFW_STUB_RULES: JSON.stringify(rules) } : {}),
        MAAFW_LIVE_NO_UPDATE_CHECK: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } reject(new Error('30s 未退出')) }, 30000)
    child.on('exit', (c) => { clearTimeout(timer); resolve({ code: c, out, err }) })
  })
}

/** 批量回执：`perCase` 按位置给逐例分数（省略的例按"无得分"），外带图像尺寸。 */
const batch = (perCase, imgW = 1280, imgH = 720) => ({
  meta: { source: 'stub', w: imgW, h: imgH },
  perCase,
})

/** 某一条候选：`score` 是实测置信度（null = 没有证据，不是 0 分），`hit` = 是否过识别门槛 */
const at = (score, hit = false) => ({ score, hit })
/** 没有证据的一例 */
const NONE = { score: null, hit: false }

const ROI = [558, 68, 140, 43]
const PITCH = 136
/* `--pitch 136` 发出去的三条候选，按顺序是：本位置 558 / 左 490（=558−68）/ 右 626（=558+68）。 */

/** 本命令的候选现在是「本位置 + 左 + 右」一次性发出去（顺序即契约），`when` 用第一个候选定位场景。 */
const scenario = (baseX, cases, imgW = 1280, imgH = 720) => [{
  cmd: 'reco_test', when: { 'candidates.0.0': baseX }, data: batch(cases, imgW, imgH),
}]

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-roicheck-img-'))
  const image = join(dir, 'kf21.png')
  writeFileSync(image, PNG_1x1)
  return { image, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const baseArgs = (image) => [
  'roi-check', '--image', image, '--roi', ROI.join(','), '--target', 'P40/Leaders.png',
  '--resource-dir', 'R', '--pitch', String(PITCH), '--threshold', '0.8',
]

test('roi-check：本位置明显更优 → HIT 且退出 0，两侧分数都给', async () => {
  const { image, cleanup } = setup()
  try {
    const { code, out } = await runCli(baseArgs(image), scenario(ROI[0], [at(1.0, true), at(0.42), at(0.50)]))
    assert.equal(code, 0, out)
    assert.match(out, /本位置\s+score=1\s+\[命中\]/, out)
    assert.match(out, /对照位置 score=0\.5\s+\[未中\]/, out)
    assert.match(out, /结论：HIT/, out)
    assert.ok(!/AMBIGUOUS/.test(out), out)
  } finally { cleanup() }
})

test('roi-check：对照位置更优（旧 roi 偏了半周期）→ MISS 且退出 3', async () => {
  const { image, cleanup } = setup()
  try {
    const { code, out } = await runCli(baseArgs(image), scenario(ROI[0], [at(0.35), at(0.13), at(0.98, true)]))
    assert.equal(code, 3, out)
    assert.match(out, /结论：MISS/, out)
    assert.match(out, /对照位置更优/, out)
  } finally { cleanup() }
})

test('roi-check：两侧分差 < 0.15 → AMBIGUOUS（说「分不出来」）且退出 3', async () => {
  const { image, cleanup } = setup()
  try {
    const { code, out } = await runCli(baseArgs(image), scenario(ROI[0], [at(0.62), at(0.55), at(0.60)]))
    assert.equal(code, 3, out)
    assert.match(out, /AMBIGUOUS：无法区分，需人工放大对比/, out)
    assert.match(out, /差值（本位置 − 对照）= 0\.02/, out)
  } finally { cleanup() }
})

test('roi-check：命中但低于 --threshold → MISS（分数不够不算命中）', async () => {
  const { image, cleanup } = setup()
  try {
    const { code, out } = await runCli(baseArgs(image), scenario(ROI[0], [at(0.51, true), at(0.20), at(0.22)]))
    assert.equal(code, 3, out)
    assert.match(out, /结论：MISS/, out)
    assert.match(out, /本位置得分 0\.51 < 门槛 0\.8/, out)
  } finally { cleanup() }
})

test('roi-check：缺 --pitch 只报单边分，并明说「未做对照」（不推测周期）', async () => {
  const { image, cleanup } = setup()
  try {
    const args = ['roi-check', '--image', image, '--roi', ROI.join(','), '--target', 'T.png', '--resource-dir', 'R']
    const { code, out } = await runCli(args, scenario(ROI[0], [at(1.0, true)]))
    assert.equal(code, 0, '给了分数但没门槛：按有无得分判 HIT。' + out)
    assert.match(out, /对照位置：未做（未给 --pitch）/, out)
    assert.match(out, /未做验真/, out)
  } finally { cleanup() }
})

test('roi-check：roi 越出图像尺寸 → FINDINGS(3) 且明确说用错空间', async () => {
  const { image, cleanup } = setup()
  try {
    const { code, err } = await runCli(
      ['roi-check', '--image', image, '--roi', '558,68,140,43', '--target', 'T.png', '--resource-dir', 'R'],
      scenario(ROI[0], [at(1.0, true)], 480, 270),
    )
    assert.equal(code, 3, err)
    assert.match(err, /roi 越出图像/, err)
    assert.match(err, /480x270/, err)
  } finally { cleanup() }
})

test('roi-check：两侧都无得分 → MISS（不是 AMBIGUOUS——"没证据"不等于"分不出来"）', async () => {
  const { image, cleanup } = setup()
  try {
    const { code, out } = await runCli(baseArgs(image), scenario(ROI[0], [NONE, NONE, NONE]))
    assert.equal(code, 3, out)
    assert.match(out, /结论：MISS/, out)
    assert.match(out, /本位置与对照位置都没有得分/, out)
    assert.match(out, /不是"分不出来"/, out)
    assert.ok(!/AMBIGUOUS/.test(out), 'AMBIGUOUS 是"该人工放大对比"的信号，不能被"什么都没匹配上"占用：' + out)
    assert.match(out, /差值：不适用/, out)
    /* 这一族**做过了对照**，所以不能说"别当成歧义去人工对比"——那句话只在真没做对照时才成立 */
    assert.ok(!/别当成歧义去人工对比/.test(out), '对照做过了却说"别当成歧义"，自相矛盾：' + out)
  } finally { cleanup() }
})

test('roi-check：本位置低分 + 对照无分 → MISS，且文案不得说"本位置没有得分"', async () => {
  const { image, cleanup } = setup()
  try {
    const { code, out } = await runCli(baseArgs(image), scenario(ROI[0], [at(0.10), NONE, NONE]))
    assert.equal(code, 3, out)
    assert.match(out, /结论：MISS/, out)
    assert.match(out, /本位置有分（score=0\.1/, out)
    assert.match(out, /缺的是对照证据，不是本位置没分/, out)
    assert.ok(!/本位置没有得分/.test(out), '文案自相矛盾（实测过：同屏 score=1 [命中] + "本位置没有得分"）：' + out)
    assert.ok(!/AMBIGUOUS/.test(out), out)
  } finally { cleanup() }
})

test('roi-check：本位置高分 + 对照无分 → 如实说"缺的是对照证据"，也不甩锅模板同源性', async () => {
  const { image, cleanup } = setup()
  try {
    const { code, out } = await runCli(baseArgs(image), scenario(ROI[0], [at(1.0, true), NONE, NONE]))
    assert.equal(code, 3, out)
    assert.ok(!/本位置没有得分/.test(out), '评审实测的那条自相矛盾文案：' + out)
    assert.match(out, /本位置有分（score=1 命中）/, out)
    assert.match(out, /对照 roi 是否越界/, out)
    assert.ok(!/模板与图像是否同源/.test(out), '这一族的真因是对照位置出界，不是模板同源性（G16 同类误导）：' + out)
  } finally { cleanup() }
})

test('roi-check：±pitch/2 的对照位置越出图像 → 跳过对照并明说原因（不拿"出界"当判据）', async () => {
  const { image, cleanup } = setup()
  try {
    /* roi x=1130、pitch=4000 → 候选 -870 与 3130，两个都出界 → 不做对照（评审用 --pitch 4000 命中的正是这条） */
    const { code, out } = await runCli(
      ['roi-check', '--image', image, '--roi', '1130,300,100,50', '--target', 'T.png',
        '--resource-dir', 'R', '--pitch', '4000', '--threshold', '0.8'],
      scenario(1130, [at(0.95, true)]),
    )
    assert.equal(code, 0, out)
    assert.match(out, /对照位置：未做（±pitch\/2 的对照位置越出图像/, out)
    assert.match(out, /未做验真/, out)
    assert.match(out, /结论：HIT/, out)
  } finally { cleanup() }
})

test('roi-check：单侧出界时用界内候选，并如实报出被跳过的那个（左右对称，不静默丢负候选）', async () => {
  const { image, cleanup } = setup()
  try {
    /* roi x=20、pitch=300 → 候选 -130（左上为负，出界）与 170（界内）→ 只测 170，并报出 -130。
     * 旧代码 `.filter(r[0] >= 0)` 把 -130 悄悄丢掉，回执里只字不提（左右不对称）。 */
    const { code, out } = await runCli(
      ['roi-check', '--image', image, '--roi', '20,300,100,50', '--target', 'T.png',
        '--resource-dir', 'R', '--pitch', '300', '--threshold', '0.8'],
      scenario(20, [at(0.95, true), NONE, at(0.30)]),
    )
    assert.equal(code, 0, out)
    assert.match(out, /1 个越出图像，已跳过（-130,300,100,50）/, out)
    assert.match(out, /对照位置 score=0\.3/, out)
    assert.match(out, /结论：HIT/, out)
  } finally { cleanup() }
})

test('roi-check：基础 roi 为负 → 明确报「用错空间」（旧判据只比右下会放行）', async () => {
  const { image, cleanup } = setup()
  try {
    const { code, err } = await runCli(
      ['roi-check', '--image', image, '--roi=-50,200,80,300', '--target', 'T.png', '--resource-dir', 'R'],
      scenario(-50, [at(0)]),
    )
    assert.equal(code, 3, err)
    assert.match(err, /roi 越出图像/, err)
    assert.match(err, /左上 -50,200 为负/, err)
  } finally { cleanup() }
})

test('roi-check：只有对照有分 → MISS（本位置无证据，谈不上"分不出来"）', async () => {
  const { image, cleanup } = setup()
  try {
    const { code, out } = await runCli(baseArgs(image), scenario(ROI[0], [NONE, at(0.91, true), NONE]))
    assert.equal(code, 3, out)
    assert.match(out, /结论：MISS/, out)
    assert.match(out, /而对照位置有（0\.91）/, out)
    assert.ok(!/AMBIGUOUS/.test(out), out)
  } finally { cleanup() }
})

test('roi-check：真歧义仍要报 AMBIGUOUS（修法不得把这条路堵掉）', async () => {
  const { image, cleanup } = setup()
  try {
    const { code, out } = await runCli(baseArgs(image), scenario(ROI[0], [at(0.90, true), at(0.30), at(0.88, true)]))
    assert.equal(code, 3, out)
    assert.match(out, /AMBIGUOUS：无法区分，需人工放大对比/, out)
    assert.match(out, /两侧分差 0\.02/, out)
  } finally { cleanup() }
})

test('roi-check：本位置无分且未做对照 → 结论按"有无得分"判 MISS，并显式标注未做验真', async () => {
  const { image, cleanup } = setup()
  try {
    const { code, out } = await runCli(
      ['roi-check', '--image', image, '--roi', ROI.join(','), '--target', 'T.png', '--resource-dir', 'R'],
      scenario(ROI[0], [NONE]),
    )
    assert.equal(code, 3, out)
    assert.match(out, /结论：MISS/, out)
    assert.match(out, /对照位置：未做（未给 --pitch）/, out)
    assert.match(out, /未做验真/, out)
    assert.match(out, /只按有无得分判，未做门槛断言/, out)
  } finally { cleanup() }
})

test('roi-check：--name 只认 TemplateMatch（别的类型会把 --target 静默吞掉）→ USAGE(2)', async () => {
  const { image, cleanup } = setup()
  try {
    for (const name of ['OCR', 'ColorMatch', 'TemplateMatchx']) {
      const { code, err } = await runCli([...baseArgs(image), '--name', name], [])
      assert.equal(code, 2, name + ' → ' + err)
      assert.match(err, /--name 只接受 TemplateMatch/, err)
    }
    /* 显式给 TemplateMatch 不该被拦（缺省也是它） */
    const ok = await runCli([...baseArgs(image), '--name', 'TemplateMatch'],
      scenario(ROI[0], [at(1.0, true), at(0.42), at(0.50)]))
    assert.equal(ok.code, 0, ok.out + ok.err)
    assert.match(ok.out, /结论：HIT/, ok.out)
  } finally { cleanup() }
})

test('roi-check：参数错（缺 target / 缺 resource-dir / 缺 roi）→ USAGE(2) 且零请求', async () => {
  const { image, cleanup } = setup()
  try {
    for (const args of [
      ['roi-check', '--image', image, '--roi', ROI.join(','), '--resource-dir', 'R'],
      ['roi-check', '--image', image, '--target', 'T.png', '--roi', ROI.join(',')],
      ['roi-check', '--image', image, '--target', 'T.png', '--resource-dir', 'R'],
      ['roi-check', '--image', image, '--target', 'T.png', '--resource-dir', 'R', '--roi', '1,2,3'],
      ['roi-check', '--image', image, '--target', 'T.png', '--resource-dir', 'R', '--roi', ROI.join(','), '--pitch', '0'],
    ]) {
      const { code, err } = await runCli(args, [])
      assert.equal(code, 2, JSON.stringify(args) + ' → ' + err)
    }
  } finally { cleanup() }
})

test('roi-check：image 不存在 → USAGE(2)', async () => {
  const { cleanup } = setup()
  try {
    const { code, err } = await runCli(
      ['roi-check', '--image', join(tmpdir(), 'nope-' + Date.now() + '.png'), '--roi', ROI.join(','),
        '--target', 'T.png', '--resource-dir', 'R'],
      [],
    )
    assert.equal(code, 2, err)
    assert.match(err, /图像不存在/, err)
  } finally { cleanup() }
})
