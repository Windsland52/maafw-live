/**
 * `roi-compare` 的判据单测（桩 daemon，无设备）：候选集合比较的**两条不变量** + 三态 + 三族夹具。
 *
 * 两条不变量是这轮的灵魂（机械可检查，专门挡"照 sweep 的形状抄"这个病）：
 *  1. **逐例 `results[].param.roi` 两两不同，且与输入候选列表顺序一一对应**（N 例 N 个不同 roi）。
 *     `sweep` 是"同键换值"、候选是"逐例换 roi"——形状像，但不变量不同；分数悄悄错位是
 *     这条判据最贵的失败方式，所以命令层**当场校验**（错位就报"逐例对应关系断了"，不打表）。
 *  2. **顺序稳定**：输入候选列表内部顺序 = 输出 `ranked` 的可追溯顺序（`ranked[i].roi` 能从
 *     输入按 `origin` 还原），不是"看起来像排序过"。
 *
 * 三族夹具（**非均匀格**，别再造理想均匀网格）：
 *  - 真实格：`test/fixtures/roi-compare-real-grid.mjs`（15 个真机 roi + 真实分数）；
 *  - 周期图：pitch=136 的横向条纹（`__test.pngEncodeRGB` 造），并**从像素上**证明它沿 x 周期；
 *  - 越界族：负坐标 / 右下超出 / 全部越界。
 *
 * 造分手段与 roi-check 单测同源：桩 daemon 的 `data.perCase` 按位置给逐例分数（见
 * `test/fixtures/stub-recording-daemon.mjs`），桩会把 `param.roi` 回成该例自己的候选。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { __test } from '../lib/daemon/framed.mjs'
import { REAL_GRID } from './fixtures/roi-compare-real-grid.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'maafw-live.mjs')
const STUB = join(HERE, 'fixtures', 'stub-recording-daemon.mjs')

/** 造一张只作存在性占位的 png（桩 daemon 不读像素） */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64')

/** 跑一次一次性 CLI 命令（桩 daemon），返回 {code, out, err, requests}（requests = 桩记下的逐条请求） */
function runCli(args, { rules, replies } = {}) {
  return new Promise((resolve, reject) => {
    const log = join(tmpdir(), 'maafw-roicmp-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.jsonl')
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        MAA_DAEMON: STUB,
        MAAFW_STUB_LOG: log,
        ...(rules ? { MAAFW_STUB_RULES: JSON.stringify(rules) } : {}),
        ...(replies ? { MAAFW_STUB_REPLIES: JSON.stringify(replies) } : {}),
        MAAFW_LIVE_NO_UPDATE_CHECK: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } reject(new Error('30s 未退出')) }, 30000)
    child.on('exit', (c) => {
      clearTimeout(timer)
      let requests = []
      try {
        requests = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      } catch { /* 没有请求也算一种事实 */ }
      try { rmSync(log, { force: true }) } catch { /* ignore */ }
      resolve({ code: c, out, err, requests })
    })
  })
}

/** 批量回执：`perCase` 按位置给逐例分数，外带图像尺寸 */
const batch = (perCase, w = 1280, h = 720) => ({ meta: { source: 'stub', w, h }, perCase })
const at = (score, hit = false) => ({ score, hit })
const NONE = { score: null, hit: false }
/** 一个 reco_test 规则：命中它就把逐例分数铺开（`when` 为空 = 任何 reco_test 都命中） */
const rule = (perCase, w = 1280, h = 720) => [{ cmd: 'reco_test', when: {}, data: batch(perCase, w, h) }]
const recoReqs = (requests) => requests.filter((r) => r.cmd === 'reco_test')

/** `--json` 的信封（stdout 只有信封） */
const envelope = (out) => JSON.parse(out)

const roisArg = (rois) => rois.map((r) => r.join(',')).join(';')
const gridArgs = (image) => [
  'roi-compare', '--image', image, '--target', 'T.png', '--resource-dir', 'R', '--rois', roisArg(REAL_GRID.rois),
]
const realScores = () => REAL_GRID.scores.map((s, i) => at(s, REAL_GRID.hits[i]))

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-roicmp-img-'))
  const image = join(dir, 'kf22.png')
  writeFileSync(image, PNG_1x1)
  return { dir, image, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** pitch 周期的横向条纹图（亮度只随 y 变化 → 沿 x 平移像素完全相同） */
function periodicImage(dir, pitch = 136, W = 680, H = 400) {
  const rgb = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y++) {
    const phase = (y % pitch) / pitch
    const v = Math.min(255, 40 + Math.round(120 * phase) + Math.round(70 * Math.abs(Math.sin(phase * Math.PI))))
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      rgb[i] = v
      rgb[i + 1] = Math.round(v * 0.85)
      rgb[i + 2] = Math.round(v * 0.6)
    }
  }
  const file = join(dir, 'periodic.png')
  writeFileSync(file, __test.pngEncodeRGB(rgb, W, H))
  return { file, rgb, W, H }
}

/** 沿 x 平移 delta 后是否逐点相同（"这张图真的沿 x 周期"的机械判据，不靠眼看） */
function xShiftIdentical(rgb, W, H, delta) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x + delta < W; x++) {
      const a = (y * W + x) * 3
      const b = (y * W + x + delta) * 3
      if (rgb[a] !== rgb[b] || rgb[a + 1] !== rgb[b + 1] || rgb[a + 2] !== rgb[b + 2]) return false
    }
  }
  return true
}

/** 沿 y 平移 delta 后是否逐点相同（用来否证"整张图处处一样"） */
function yShiftIdentical(rgb, W, H, delta) {
  for (let y = 0; y + delta < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = (y * W + x) * 3
      const b = ((y + delta) * W + x) * 3
      if (rgb[a] !== rgb[b] || rgb[a + 1] !== rgb[b + 1] || rgb[a + 2] !== rgb[b + 2]) return false
    }
  }
  return true
}

/** 从**落盘的 PNG** 里取 RGB（周期性的断言要打在文件上，不是打在内存缓冲上） */
function decodeRgb(file) {
  const dec = __test.pngDecode(readFileSync(file))
  if (dec.ch === 3) return { rgb: dec.data, W: dec.w, H: dec.h }
  const rgb = Buffer.alloc(dec.w * dec.h * 3)
  for (let i = 0, o = 0; i < dec.data.length; i += 4, o += 3) {
    rgb[o] = dec.data[i]
    rgb[o + 1] = dec.data[i + 1]
    rgb[o + 2] = dec.data[i + 2]
  }
  return { rgb, W: dec.w, H: dec.h }
}

/* ───────────────────────── 不变量 1 / 2 ───────────────────────── */

test('roi-compare：不变量 1 —— 15 例逐例换 roi，results[].param.roi 两两不同且与输入顺序一一对应', async () => {
  const { image, cleanup } = setup()
  try {
    const { out, requests } = await runCli([...gridArgs(image), '--json'], { rules: rule(realScores()) })
    const req = recoReqs(requests)[0]
    assert.ok(req, '必须只发一次 reco_test（候选折进同一个 cases，不是每候选一次）')
    assert.equal(recoReqs(requests).length, 1)
    assert.deepEqual(req.candidates, REAL_GRID.rois, '请求里的候选必须逐条等于输入（顺序也是契约）')
    assert.equal(req.param.roi, undefined, '基础参数不带 roi：每条候选的 roi 只从候选列表来')

    const env = envelope(out)
    const cases = env.data.cases
    assert.equal(cases.length, 15)
    assert.deepEqual(cases.map((c) => c.caseRoi), REAL_GRID.rois, '逐例回执的 param.roi 必须与输入顺序一一对应')
    assert.equal(new Set(cases.map((c) => c.caseRoi.join(','))).size, 15, 'N 例必须 N 个不同 roi')
    assert.deepEqual(cases.map((c) => c.origin), [...Array(15).keys()], 'origin 必须是输入下标')
    assert.deepEqual(cases.map((c) => c.roi), cases.map((c) => c.caseRoi), '归位用的 roi 与回执 roi 必须相等')
  } finally { cleanup() }
})

test('roi-compare：不变量 2 —— ranked 的 roi 能从输入按 origin 还原（顺序稳定）', async () => {
  const { image, cleanup } = setup()
  try {
    const { out } = await runCli([...gridArgs(image), '--json'], { rules: rule(realScores()) })
    const ranked = envelope(out).data.ranked
    assert.equal(ranked.length, 15)
    assert.deepEqual(ranked.map((r) => r.rank), [...Array(15).keys()].map((i) => i + 1))
    for (const row of ranked) {
      assert.deepEqual(row.roi, REAL_GRID.rois[row.origin], 'ranked[i].roi 必须等于输入里 origin 那条')
    }
    /* 分数降序且稳定（同分按 origin）：这是"排序过"而不是"看起来像排序过" */
    const scores = ranked.map((r) => r.score)
    assert.deepEqual(scores, scores.slice().sort((a, b) => b - a))
  } finally { cleanup() }
})

test('roi-compare：回执逐例回错 roi → 明确报"逐例对应关系断了"，且不打排序表', async () => {
  const { image, cleanup } = setup()
  try {
    const shifted = {
      meta: { source: 'stub', w: 1280, h: 720 },
      results: REAL_GRID.rois.map((_, i) => ({
        param: { template: 'T.png', roi: REAL_GRID.rois[(i + 1) % REAL_GRID.rois.length] },
        ms: 12, ok: false,
        detail: {
          name: '@reco/node', algorithm: 'TemplateMatch', hit: false, box: [0, 0, 0, 0],
          detail: { all: [{ box: [0, 0, 0, 0], score: 0.5 }], best: null, filtered: [] },
        },
      })),
    }
    const { code, out, err } = await runCli(gridArgs(image), { replies: { reco_test: shifted } })
    assert.equal(code, 3, out + err)
    assert.match(out + err, /逐例对应关系断了/, out + err)
    assert.ok(!/ bestGap = /.test(out), '对应关系断了就不该给出排序结论：' + out)
  } finally { cleanup() }
})

/* ───────────────────────── 夹具 1：真实格 ───────────────────────── */

test('roi-compare：真实 15 格（行距≠列距、列距不均）→ 不误报唯一，AMBIGUOUS + exit 3', async () => {
  const { image, cleanup } = setup()
  try {
    const { code, out } = await runCli([...gridArgs(image), '--json', '--threshold', '0.8'],
      { rules: rule(realScores()) })
    assert.equal(code, 3, out)
    const env = envelope(out)
    assert.equal(env.data.verdict, 'AMBIGUOUS')
    assert.equal(env.data.reason, 'ambiguous')
    assert.equal(env.data.bestGap, REAL_GRID.expected.bestGap)
    assert.deepEqual(env.data.withinGap, REAL_GRID.expected.withinGap)
    assert.equal(env.data.ranked[0].roi.join(','), '462,175,68,44')
    assert.equal(env.data.ranked[1].roi.join(','), '597,175,68,44')
    assert.equal(env.data.ranked[1].score, 0.859515, '夹具分数逐例钉住')
    assert.equal(env.data.ranked[1].inBand, true, 'Δ=0.14 < 0.15：次优在并列带内')
    assert.equal(env.data.imageSize.w, 1280)
  } finally { cleanup() }
})

test('roi-compare：真实格的人读回执 —— 排序表 + 并列带标注 + bestGap 行', async () => {
  const { image, cleanup } = setup()
  try {
    const { out } = await runCli([...gridArgs(image), '--threshold', '0.8'], { rules: rule(realScores()) })
    assert.match(out, /roi-compare（外来目标）：T\.png  on .*kf22\.png\s+图像 1280x720/, out)
    assert.match(out, / rank\s+roi\s+score\s+命中/, out)
    assert.match(out, /1\s+462,175,68,44\s+1\s+✓/, out)
    assert.match(out, /2\s+597,175,68,44\s+0\.86\s+✓\s+← Δ=0\.14 < 0\.15，并列带内/, out)
    assert.match(out, /3\s+732,175,68,44\s+0\.656/, out)
    assert.match(out, /bestGap = 0\.14\s+gap = 0\.15\s+withinGap = \[1,2\]/, out)
    assert.match(out, /结论：AMBIGUOUS —— 无法区分，需人工放大对比/, out)
    assert.ok(!/结论：HIT/.test(out), '非均匀格下不得误报唯一最优：' + out)
  } finally { cleanup() }
})

/* ───────────────────────── 夹具 2：周期图 ───────────────────────── */

test('roi-compare：周期图（pitch=136 横向条纹）→ AMBIGUOUS 必触发 + exit 3', async () => {
  const { dir, cleanup } = setup()
  try {
    const { file } = periodicImage(dir, 136)
    /* 先证明"这张图真的沿 x 周期"（否则"分不出来"只是桩编的分数）：
     * 横向条纹沿 x 处处相同 → 任何 x 平移都像素相同；沿 y 平移 68（非周期）必须不同。 */
    const { rgb, W, H } = decodeRgb(file)
    assert.equal(xShiftIdentical(rgb, W, H, 8), true, '横向条纹沿 x 处处相同：x 平移 8 像素必须逐点相同')
    assert.equal(xShiftIdentical(rgb, W, H, 136), true)
    assert.equal(yShiftIdentical(rgb, W, H, 68), false, '沿 y 平移 68 ≠ 周期 → 必须不同（否证"整张图一模一样"）')

    const candidates = [[270, 40, 68, 44], [270 + 136, 40, 68, 44], [270 - 136, 40, 68, 44]]
    const { code, out } = await runCli([
      'roi-compare', '--image', file, '--target', 'paw.png', '--resource-dir', 'R',
      '--rois', roisArg(candidates), '--threshold', '0.8', '--json',
    ], { rules: rule([at(1.0, true), at(1.0, true), at(1.0, true)], W, H) })
    assert.equal(code, 3, out)
    const env = envelope(out)
    assert.equal(env.data.verdict, 'AMBIGUOUS')
    assert.deepEqual(env.data.withinGap, [1, 2, 3], '像素完全相同的三个位置必须全在并列带里')
    assert.equal(env.data.bestGap, 0)
  } finally { cleanup() }
})

/* ───────────────────────── 三态 ───────────────────────── */

test('roi-compare：唯一最优且过门槛 → HIT + exit 0；bestGap 无上限地照给（不截断）', async () => {
  const { image, cleanup } = setup()
  try {
    const rois = [[0, 0, 50, 50], [200, 0, 50, 50], [400, 0, 50, 50]]
    const { code, out } = await runCli([
      'roi-compare', '--image', image, '--target', 'T.png', '--resource-dir', 'R',
      '--rois', roisArg(rois), '--threshold', '0.8', '--json',
    ], { rules: rule([at(0.9, true), at(0.3), at(0.2)]) })
    assert.equal(code, 0, out)
    const env = envelope(out)
    assert.equal(env.data.verdict, 'HIT')
    assert.equal(env.data.exit, 0)
    assert.equal(env.data.bestGap, 0.6, 'bestGap 无上限：0.6 ≥ gap 也要如实报出来')
    assert.deepEqual(env.data.withinGap, [1])
  } finally { cleanup() }
})

test('roi-compare：最优未过 --threshold → MISS + exit 3（不是调低阈值的理由）', async () => {
  const { image, cleanup } = setup()
  try {
    const rois = [[0, 0, 50, 50], [200, 0, 50, 50]]
    const { code, out } = await runCli([
      'roi-compare', '--image', image, '--target', 'T.png', '--resource-dir', 'R',
      '--rois', roisArg(rois), '--threshold', '0.8',
    ], { rules: rule([at(0.61), at(0.2)]) })
    assert.equal(code, 3, out)
    assert.match(out, /结论：MISS —— 最优 0,0,50,50 得分 0\.61 < 门槛 0\.8/, out)
    assert.match(out, /识别未命中不是调低阈值的理由/, out)
    assert.ok(!/结论：HIT/.test(out), out)
  } finally { cleanup() }
})

test('roi-compare：有候选无法评估 → 无证据的不进 ranked（没有分数就没有名次），退出码 3 承担 caveat', async () => {
  const { image, cleanup } = setup()
  try {
    const rois = [[0, 0, 50, 50], [200, 0, 50, 50], [400, 0, 50, 50]]
    const { code, out } = await runCli([
      'roi-compare', '--image', image, '--target', 'T.png', '--resource-dir', 'R',
      '--rois', roisArg(rois), '--threshold', '0.8', '--json',
    ], { rules: rule([at(0.95, true), NONE, at(0.2)]) })
    /* 判据先"把没有证据的候选剔除，再谈歧义"（文档定的优先序）：剩下的 0.95 vs 0.2 是唯一最优。
     * 但"还有候选没被评估过"不能就这么被结论盖掉——退出码 3 + 回执里点名。 */
    assert.equal(code, 3, out)
    const env = envelope(out)
    assert.equal(env.data.verdict, 'HIT')
    assert.equal(env.data.reason, 'unique')
    assert.equal(env.data.exit, 3, '唯一最优但仍有候选无法评估 → 退出码不是 0')
    assert.deepEqual(env.data.candidates.missing, [[200, 0, 50, 50]])
    assert.deepEqual(env.data.ranked.map((r) => r.roi), [[0, 0, 50, 50], [400, 0, 50, 50]],
      'ranked 里不许有无得分的行——没有分数就没有名次')
    assert.ok(!env.data.ranked.some((r) => r.score === null), 'null 不能被当成 0 分混进排名')
    /* 它仍在**逐例回执**里（输入顺序、完整记录），只是不参与"谁更优" */
    assert.deepEqual(env.data.cases.map((c) => c.score), [0.95, null, 0.2])
    assert.equal(env.data.cases[1].roi.join(','), '200,0,50,50')
  } finally { cleanup() }
})

test('roi-compare：有候选无法评估时，人读回执必须点名并说清"剔除 ≠ 0 分"', async () => {
  const { image, cleanup } = setup()
  try {
    const rois = [[0, 0, 50, 50], [200, 0, 50, 50], [400, 0, 50, 50]]
    const { code, out } = await runCli([
      'roi-compare', '--image', image, '--target', 'T.png', '--resource-dir', 'R',
      '--rois', roisArg(rois), '--threshold', '0.8',
    ], { rules: rule([at(0.95, true), NONE, at(0.2)]) })
    assert.equal(code, 3, out)
    assert.match(out, /结论：HIT/, out)
    assert.match(out, /注：另有 1 个候选无得分（200,0,50,50）/, out)
    assert.match(out, /已从比较里剔除（无证据 ≠ 0 分，也不当垫底）/, out)
    assert.match(out, /本结论只对可评估的 2 个成立/, out)
    assert.match(out, /退出码按"有候选无法评估"给 3/, out)
    assert.ok(!/3\s+200,0,50,50/.test(out), '无得分的候选不该出现在排序表里（表只排名有分的）：' + out)
    assert.ok(!/AMBIGUOUS/.test(out), '缺证据 ≠ 分不出来：' + out)
  } finally { cleanup() }
})

test('roi-compare：候选全部无得分 → MISS（不是 AMBIGUOUS）+ exit 3，且没有排序表', async () => {
  const { image, cleanup } = setup()
  try {
    const rois = [[0, 0, 50, 50], [200, 0, 50, 50]]
    const { code, out } = await runCli([
      'roi-compare', '--image', image, '--target', 'T.png', '--resource-dir', 'R',
      '--rois', roisArg(rois),
    ], { rules: rule([NONE, NONE]) })
    assert.equal(code, 3, out)
    assert.match(out, /（没有候选拿到分数：无排序表可打）/, out)
    assert.match(out, /不是"分不出来"/, out)
  } finally { cleanup() }
})

test('roi-compare：全部无得分时 ranked 是空的（没有分数就没有名次）', async () => {
  const { image, cleanup } = setup()
  try {
    const rois = [[0, 0, 50, 50], [200, 0, 50, 50]]
    const { out } = await runCli([
      'roi-compare', '--image', image, '--target', 'T.png', '--resource-dir', 'R',
      '--rois', roisArg(rois), '--json',
    ], { rules: rule([NONE, NONE]) })
    const env = envelope(out)
    assert.equal(env.data.reason, 'no-evidence')
    assert.deepEqual(env.data.ranked, [])
    assert.equal(env.data.candidates.evaluated, 0)
    assert.equal(env.data.cases.length, 2, '逐例回执仍在（完整记录）')
  } finally { cleanup() }
})

test('roi-compare：真实格"分得出来"的那一半 —— 同一组 15 格、另一份模板 → HIT + exit 0', async () => {
  const { image, cleanup } = setup()
  try {
    /* 夹具里那份 decisive 模板（从 867,175,68,44 裁）的真实分数：bestGap 0.367 ≥ 0.15。
     * "分不出来"（上面那条）与"分得出来"（这条）用的是**同一批真机 data**，区别只在模板。 */
    const cases = REAL_GRID.decisive.scores.map((s, i) => at(s, REAL_GRID.decisive.hits[i]))
    const { code, out } = await runCli([...gridArgs(image), '--json', '--threshold', '0.8', '--name', 'TemplateMatch'],
      { rules: rule(cases) })
    assert.equal(code, 0, out)
    const env = envelope(out)
    assert.equal(env.data.verdict, REAL_GRID.decisive.expected.verdict)
    assert.equal(env.data.reason, 'unique')
    assert.equal(env.data.exit, 0)
    assert.equal(env.data.bestGap, REAL_GRID.decisive.expected.bestGap)
    assert.deepEqual(env.data.withinGap, REAL_GRID.decisive.expected.withinGap)
    assert.equal(env.data.ranked[0].roi.join(','), REAL_GRID.decisive.cell.join(','), '自己那一格唯一最优')
    assert.equal(env.data.ranked[1].score, 0.633333, '次优逐例钉住')
    assert.equal(env.data.candidates.missing.length, 0)
  } finally { cleanup() }
})

test('roi-compare：--gap 可调（0.2 内算并列；同一组分数在缺省 0.15 下是 HIT）', async () => {
  const { image, cleanup } = setup()
  try {
    const rois = [[0, 0, 50, 50], [200, 0, 50, 50]]
    const loose = await runCli([
      'roi-compare', '--image', image, '--target', 'T.png', '--resource-dir', 'R',
      '--rois', roisArg(rois), '--gap', '0.2', '--json',
    ], { rules: rule([at(0.90, true), at(0.72)]) })
    assert.equal(loose.code, 3, loose.out)
    assert.equal(envelope(loose.out).data.verdict, 'AMBIGUOUS', 'Δ=0.18 < gap 0.2 → 并列')
    const strict = await runCli([
      'roi-compare', '--image', image, '--target', 'T.png', '--resource-dir', 'R',
      '--rois', roisArg(rois), '--json',
    ], { rules: rule([at(0.90, true), at(0.72)]) })
    assert.equal(strict.code, 0, strict.out)
    assert.equal(envelope(strict.out).data.verdict, 'HIT', 'Δ=0.18 ≥ 缺省 gap 0.15 → 唯一最优')
  } finally { cleanup() }
})

/* ───────────────────────── 夹具 3：越界族 ───────────────────────── */

test('roi-compare：候选左上负坐标 → 跳过并报出是谁（其余照常排序）', async () => {
  const { image, cleanup } = setup()
  try {
    /* 以 `-` 开头的值要用 `--rois=…`（否则 parseArgs 判它像选项名，报 ambiguous）。
     * 负坐标是最典型的"空间算错"：只比右下是看不出来的（[-50,200,80,300] 的右下落在画面里）。 */
    const args = [
      'roi-compare', '--image', image, '--target', 'T.png', '--resource-dir', 'R',
      '--rois=-50,200,80,300;10,10,50,50',
    ]
    const human = await runCli(args, { rules: rule([at(0.9, true), at(0.1)]) })
    assert.equal(human.code, 0, human.out + human.err)
    assert.match(human.out, /候选越界：跳过 1 个（-50,200,80,300）/, human.out)
    assert.match(human.out, /参数用错空间/, human.out)

    const machine = await runCli([...args, '--json'], { rules: rule([at(0.9, true), at(0.1)]) })
    const skipped = envelope(machine.out).data.candidates.skipped
    assert.deepEqual(skipped.map((s) => s.roi), [[-50, 200, 80, 300]])
    assert.match(skipped[0].reason, /左上 -50,200 为负/, skipped[0].reason)
    assert.deepEqual(envelope(machine.out).data.ranked.map((r) => r.roi), [[10, 10, 50, 50]])
  } finally { cleanup() }
})

test('roi-compare：单条右下越界 → 跳过并在回执列出是谁，其余照常排序', async () => {
  const { image, cleanup } = setup()
  try {
    const { code, out } = await runCli([
      'roi-compare', '--image', image, '--target', 'T.png', '--resource-dir', 'R',
      '--rois', '0,0,50,50;200,0,50,50;1250,700,68,44', '--json',
    ], { rules: rule([at(0.9, true), at(0.2), NONE]) })
    assert.equal(code, 0, out)
    const env = envelope(out)
    assert.equal(env.data.candidates.sent, 3, '三条都发出去了')
    assert.equal(env.data.ranked.length, 2, '越界那条不参与排序')
    assert.deepEqual(env.data.candidates.skipped.map((s) => s.roi.join(',')), ['1250,700,68,44'])
    assert.match(env.data.candidates.skipped[0].reason, /roi 越出图像/)
    assert.equal(env.data.ranked[0].roi.join(','), '0,0,50,50')
  } finally { cleanup() }
})

test('roi-compare：候选全部越界 → FINDINGS(3)，并沿用"参数用错空间"文案', async () => {
  const { image, cleanup } = setup()
  try {
    const { code, out, err } = await runCli([
      'roi-compare', '--image', image, '--target', 'T.png', '--resource-dir', 'R',
      '--rois=1250,700,68,44;-50,200,80,300',
    ], { rules: rule([NONE, NONE]) })
    assert.equal(code, 3, out + err)
    assert.match(out, /候选全部越界（2 个）：1250,700,68,44 \/ -50,200,80,300/, out)
    assert.match(err, /roi 越出图像/, err)
    assert.match(err, /1280x720/, err)
    assert.match(err, /参数用错空间/, err)
  } finally { cleanup() }
})

/* ───────────────────── 候选来源：--offsets / --scan ───────────────────── */

test('roi-compare：--offsets 允许 x/y 分量与非均匀列表（基准 --roi）', async () => {
  const { image, cleanup } = setup()
  try {
    const { out, requests } = await runCli([
      'roi-compare', '--image', image, '--target', 'T.png', '--resource-dir', 'R',
      '--roi', '462,175,68,44', '--offsets', '0,0;135,0;140,0;0,111', '--json',
    ], { rules: rule([at(0.9, true), at(0.3), at(0.25), at(0.2)]) })
    assert.deepEqual(recoReqs(requests)[0].candidates, [
      [462, 175, 68, 44], [597, 175, 68, 44], [602, 175, 68, 44], [462, 286, 68, 44],
    ])
    const env = envelope(out)
    assert.equal(env.data.source, 'offsets')
    assert.deepEqual(env.data.base, [462, 175, 68, 44])
    assert.deepEqual(env.data.cases.map((c) => c.caseRoi[0]), [462, 597, 602, 462])
  } finally { cleanup() }
})

test('roi-compare：--offsets 缺 --roi 时用第一个候选当基准（第一段写成 x,y,w,h）', async () => {
  const { image, cleanup } = setup()
  try {
    const { out, requests } = await runCli([
      'roi-compare', '--image', image, '--target', 'T.png', '--resource-dir', 'R',
      '--offsets', '462,175,68,44;135,0', '--json',
    ], { rules: rule([at(0.9, true), at(0.3)]) })
    assert.deepEqual(recoReqs(requests)[0].candidates, [[462, 175, 68, 44], [597, 175, 68, 44]])
    assert.deepEqual(envelope(out).data.base, [462, 175, 68, 44])
  } finally { cleanup() }
})

test('roi-compare：--scan 是发现模式 —— 结论只说"发现/未发现唯一最优"，不判"位置错了"', async () => {
  const { image, cleanup } = setup()
  try {
    const cases = Array.from({ length: 41 }, (_, i) => (i === 20 ? at(0.93, true) : at(0.2)))
    const { code, out, requests } = await runCli([
      'roi-compare', '--image', image, '--target', 'T.png', '--resource-dir', 'R',
      '--roi', '462,175,68,44', '--scan', 'dx=-160..160/8,dy=0', '--json',
    ], { rules: rule(cases) })
    const sent = recoReqs(requests)[0].candidates
    assert.equal(sent.length, 41)
    assert.deepEqual(sent[0], [302, 175, 68, 44])
    assert.deepEqual(sent[40], [622, 175, 68, 44])
    assert.equal(code, 0, out)
    const env = envelope(out)
    assert.deepEqual(env.data.scan.dx, { from: -160, to: 160, step: 8 })
    assert.deepEqual(env.data.scan.dy, { from: 0, to: 0, step: 1 })
    assert.equal(env.data.scan.step, 8)
    assert.equal(env.data.scan.count, 41)
    assert.ok(env.data.elapsedMs >= 0)
  } finally { cleanup() }
})

test('roi-compare：--scan 的人读回执写明耗时与"不构成位置判据"', async () => {
  const { image, cleanup } = setup()
  try {
    const cases = Array.from({ length: 41 }, (_, i) => (i === 0 ? at(0.4) : at(0.2)))
    const { out } = await runCli([
      'roi-compare', '--image', image, '--target', 'T.png', '--resource-dir', 'R',
      '--roi', '462,175,68,44', '--scan', 'dx=-160..160/8,dy=0',
    ], { rules: rule(cases) })
    assert.match(out, /发现模式（--scan）：dx=-160\.\.160\/8 × dy=0 → 41 个候选；耗时 \d+\.\ds/, out)
    assert.match(out, /不是秒回/, out)
    assert.match(out, /结论：\*\*发现唯一最优\*\*/, out)
    assert.match(out, /不构成"位置对了"的判据/, out)
  } finally { cleanup() }
})

test('roi-compare：--scan 打在周期图上 → 未发现唯一最优（周期结构下不唯一）+ exit 3', async () => {
  const { dir, cleanup } = setup()
  try {
    const { file, W, H } = periodicImage(dir, 136)
    const cases = Array.from({ length: 41 }, () => at(1.0, true))
    const { code, out } = await runCli([
      'roi-compare', '--image', file, '--target', 'paw.png', '--resource-dir', 'R',
      '--roi', '270,40,68,44', '--scan', 'dx=-160..160/8,dy=0',
    ], { rules: rule(cases, W, H) })
    assert.equal(code, 3, out)
    assert.match(out, /结论：AMBIGUOUS —— 无法区分，需人工放大对比/, out)
    assert.match(out, /周期结构下不唯一正是这个信号/, out)
    assert.match(out, /这是发现模式的输出，不是"位置错了"的判据/, out)
  } finally { cleanup() }
})

/* ───────────────────────── 参数错 ───────────────────────── */

test('roi-compare：参数错 → USAGE(2) 且零识别请求', async () => {
  const { image, cleanup } = setup()
  try {
    const bad = [
      ['--image', image, '--target', 'T.png', '--resource-dir', 'R'],                                   // 缺候选来源
      ['--image', image, '--target', 'T.png', '--resource-dir', 'R', '--rois', '1,2,3,4', '--offsets', '0,0'], // 两个来源
      ['--image', image, '--target', 'T.png', '--resource-dir', 'R', '--rois', '1,2,3'],               // 段不是 4 个数
      ['--image', image, '--target', 'T.png', '--resource-dir', 'R', '--rois', ''],                    // 空
      ['--image', image, '--target', 'T.png', '--resource-dir', 'R', '--scan', 'dx=-160..160'],        // 范围缺步长
      ['--image', image, '--target', 'T.png', '--resource-dir', 'R', '--scan', 'dz=0'],                // 不认识的轴
      ['--image', image, '--target', 'T.png', '--resource-dir', 'R', '--scan', 'dx=0'],                // 缺 --roi
      ['--image', image, '--target', 'T.png', '--resource-dir', 'R', '--offsets', '0,0'],              // 缺 --roi 且第一段只有 2 个数
      ['--image', image, '--target', 'T.png', '--resource-dir', 'R', '--roi', '0,0,10,10', '--offsets', '0,0;1,2,3,4'], // 绝对 roi + 基准
      ['--image', image, '--target', 'T.png', '--resource-dir', 'R', '--rois', '0,0,10,10', '--threshold', '1.5'],
      ['--image', image, '--target', 'T.png', '--resource-dir', 'R', '--rois', '0,0,10,10', '--gap', '2'],
      /* --name 只认 TemplateMatch：别的类型不读 template，放行它就是让 --target 被静默吞掉 */
      ['--image', image, '--target', 'T.png', '--resource-dir', 'R', '--rois', '0,0,10,10', '--name', 'OCR'],
      ['--image', image, '--target', 'T.png', '--resource-dir', 'R', '--rois', '0,0,10,10', '--name', 'ColorMatch'],
      ['--image', image, '--target', 'T.png', '--resource-dir', 'R', '--rois', '0,0,10,10', '--name', 'TemplateMatch_'],
      ['--image', image, '--rois', '0,0,10,10', '--resource-dir', 'R'],                                // 缺 target
      ['--image', image, '--target', 'T.png', '--rois', '0,0,10,10'],                                  // 缺 resource-dir
    ]
    for (const args of bad) {
      const { code, err, requests } = await runCli(['roi-compare', ...args], { rules: rule([at(1.0)]) })
      assert.equal(code, 2, JSON.stringify(args) + ' → ' + err)
      assert.equal(recoReqs(requests).length, 0, '参数错不该发识别请求：' + JSON.stringify(args))
    }
  } finally { cleanup() }
})

test('roi-compare：--image 不存在 / kf: 前缀 → USAGE(2)', async () => {
  const { cleanup } = setup()
  try {
    const gone = await runCli([
      'roi-compare', '--image', join(tmpdir(), 'nope-' + Date.now() + '.png'), '--target', 'T.png',
      '--resource-dir', 'R', '--rois', '0,0,10,10',
    ], {})
    assert.equal(gone.code, 2, gone.err)
    assert.match(gone.err, /图像不存在/, gone.err)
    const kf = await runCli([
      'roi-compare', '--image', 'kf:abc:0001', '--target', 'T.png', '--resource-dir', 'R', '--rois', '0,0,10,10',
    ], {})
    assert.equal(kf.code, 2, kf.err)
    assert.match(kf.err, /reco --from-kf/, kf.err)
  } finally { cleanup() }
})
