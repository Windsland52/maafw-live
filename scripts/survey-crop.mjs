#!/usr/bin/env node
/**
 * 裁剪参数测量（离线，不需要设备）：拿关键帧库里的留存帧当数据集，用网格 ROI 量 snap 与自匹配的行为。
 *
 * 为什么要有这台仪器：`crop` 的 snap 阈值（TOL / FRAC）与候选池上限都是**经验常数**，只验过"能跑"，
 * 没按误报/漏报率调过。调参需要数据，而数据要可复跑——本脚本把"哪些区域会被 snap 收紧、收到多紧、
 * 自匹配是否还找得到自己、代价多大"变成一张表，攒够场景再定标（roadmap 待办 1）。
 *
 * 判据口径（与 crop 一致）：positionOk 优先于 score；snap 把框收到原来的 35% 以下记为**塌陷**。
 * 注意塌陷**不等于失败**——首批 A/B 数据里塌陷例的位置全部正确（候选池靠"收紧候选"赢的），
 * 所以别把塌陷率当优化目标；要看的是位置正确率与最终框（见 roadmap.local.md 第八轮）。
 *
 * 用法：
 *   node scripts/survey-crop.mjs [--frames-dir <dir>] [--frames 2] [--cols 3] [--rows 2] [--json] [--out <file>]
 * 前置：npm run build（走 lib/ 与包内 daemon）。耗时：每个 ROI 起若干识别子进程，默认一档约 5-10 分钟，
 * 建议放后台跑。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnDaemon } from '../lib/client/daemon.js'
import { defaultFramesDir, loadManifest } from '../lib/runtime/keyframes.js'

const arg = (name, def) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def
}
const FRAMES_DIR = arg('--frames-dir', defaultFramesDir())
const FRAMES = Number(arg('--frames', 2))
const COLS = Number(arg('--cols', 3))
const ROWS = Number(arg('--rows', 2))
const AS_JSON = process.argv.includes('--json')
const OUT = arg('--out', null)
/** 用例文件：给了就按它跑（真实 UI 目标 + 余量档），不给才用网格 ROI。
 * 形如 [{ "id": "0004", "label": "图鉴图标-紧", "roi": [60,467,69,62], "why": "..." }]，id 是库内序号后四位。 */
const CASES = arg('--cases', null)
/** snap 测量覆盖（不给就用生产常数 90 / 0.12）：定标靠 A/B，所以旋钮从这里进来 */
const TOL = Number(arg('--tol', 0)) || undefined
const FRAC = Number(arg('--frac', 0)) || undefined

/** 自匹配要加载资源；没给就现造一个最小资源（pipeline 里一个不需要模型与图片的节点），保持脚本可移植 */
function ensureResource(explicit) {
  if (explicit) return explicit
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-survey-res-'))
  fs.mkdirSync(path.join(dir, 'pipeline'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pipeline', 'dummy.json'), JSON.stringify({
    Dummy: { recognition: 'ColorMatch', lower: [0, 0, 0], upper: [255, 255, 255], action: 'DoNothing' },
  }))
  return dir
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0)
const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 1000) / 1000
}

/** 网格 ROI：把整帧切成 cols×rows 的格子，每格取中间 75%（留出 snap 的收紧余地） */
function gridRois(w, h, cols, rows) {
  const out = []
  const cw = Math.floor(w / cols)
  const ch = Math.floor(h / rows)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const bw = Math.round(cw * 0.75)
      const bh = Math.round(ch * 0.75)
      out.push({
        label: 'r' + r + 'c' + c,
        roi: [c * cw + Math.round((cw - bw) / 2), r * ch + Math.round((ch - bh) / 2), bw, bh],
      })
    }
  }
  return out
}

async function main() {
  const { manifest, error } = loadManifest(FRAMES_DIR)
  if (error) throw new Error('manifest 不可读：' + error)
  if (!manifest) throw new Error('库内无 manifest：' + FRAMES_DIR)
  const picks = manifest.frames.slice(-FRAMES)
  if (!picks.length) throw new Error('库内没有可测帧')

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-survey-'))
  const outDir = path.join(runDir, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const resource = ensureResource(arg('--resource-dir', null))
  const c = spawnDaemon({ runDir })
  const cases = []
  try {
    /* 用例来源两条：--cases 给的真实 UI 目标（含同一元素的不同余量档），或网格 ROI */
    const byId = new Map(picks.map((r) => [r.id.slice(-4), r]))
    const plan = CASES
      ? JSON.parse(fs.readFileSync(CASES, 'utf8')).map((x) => {
          const rec = byId.get(String(x.id))
          if (!rec) throw new Error('用例引用了本次未选中的帧：' + x.id + '（用 --frames 调大取样范围）')
          return { rec, label: String(x.label ?? x.id), roi: x.roi.map(Number), why: x.why ?? null }
        })
      : picks.flatMap((rec) => gridRois(rec.ctrlW, rec.ctrlH, COLS, ROWS).map((g) => ({ rec, label: g.label, roi: g.roi, why: null })))
    for (const { rec, label, roi, why } of plan) {
      const abs = path.join(FRAMES_DIR, ...rec.file.split('/'))
      if (!fs.existsSync(abs)) { cases.push({ id: rec.id.slice(-4), label, error: 'L0 文件丢失' }); continue }
      const kfSource = {
        id: rec.id, path: abs, sha256: rec.sha256, ctrlW: rec.ctrlW, ctrlH: rec.ctrlH,
        captureSeq: rec.captureSeq, capturedAt: rec.capturedAt,
      }
      const t0 = Date.now()
      const r = await c.call('tpl_crop', {
        kfSource, roi, resourceDir: resource, prov: false,
        ...(TOL ? { snapTol: TOL } : {}), ...(FRAC ? { snapFrac: FRAC } : {}),
        out: path.join(outDir, rec.id.slice(-4) + '-' + label + '.png'),
      }, 300000)
      const ms = Date.now() - t0
      const looseArea = roi[2] * roi[3]
      const box = Array.isArray(r.box) ? r.box : null
      const boxArea = box ? box[2] * box[3] : 0
      /* 「snap 起作用」= 最终框不是原宽松框。snap 成功但候选池又退回原框，等于没起作用—— */
      /* 只看 snapped 布尔值会把这两种情况混在一起。 */
      const usedLoose = !!box && box.every((v, i) => v === roi[i])
      cases.push({
        id: rec.id.slice(-4), note: rec.note, label, roi, why,
        ok: r.ok !== false,
        error: r.ok === false ? String(r.error) : undefined,
        snapped: r.snapped === true,
        snapUseful: r.snapped === true && !usedLoose,
        box, boxArea,
        ratio: looseArea ? Math.round((boxArea / looseArea) * 1000) / 1000 : null,
        collapsed: r.snapped === true && looseArea > 0 && boxArea / looseArea < 0.35,
        score: typeof r.score === 'number' ? r.score : null,
        positionOk: r.positionOk === true,
        tries: r.tries ?? null,
        ms,
      })
      process.stdout.write('.')
    }
  } finally {
    try { c.close() } catch { /* ignore */ }
    fs.rmSync(runDir, { recursive: true, force: true })
  }

  const ok = cases.filter((x) => x.ok)
  const snapped = ok.filter((x) => x.snapped)
  const collapsed = ok.filter((x) => x.collapsed)
  const posOk = ok.filter((x) => x.positionOk)
  const degenerate = ok.filter((x) => !x.positionOk)
  const summary = {
    cases: cases.length,
    failed: cases.length - ok.length,
    snapRate: pct(snapped.length, ok.length),
    /** snap 真的改变了最终框的比例 —— 只报 snapRate 会把"收了又退回原框"算成成功 */
    snapUsefulRate: pct(ok.filter((x) => x.snapUseful).length, ok.length),
    collapseRate: pct(collapsed.length, ok.length),
    positionOkRate: pct(posOk.length, ok.length),
    score: { min: ok.length ? Math.min(...ok.map((x) => x.score ?? 0)) : null, median: median(ok.map((x) => x.score ?? 0)) },
    tries: { median: median(ok.map((x) => x.tries)), max: ok.length ? Math.max(...ok.map((x) => x.tries)) : null },
    ms: { median: median(ok.map((x) => x.ms)), max: ok.length ? Math.max(...ok.map((x) => x.ms)) : null },
    byFrame: {},
  }
  for (const x of ok) {
    const g = (summary.byFrame[x.id + ' ' + (x.note ?? '')] ??= { n: 0, snapped: 0, collapsed: 0, positionOk: 0 })
    g.n++
    if (x.snapped) g.snapped++
    if (x.collapsed) g.collapsed++
    if (x.positionOk) g.positionOk++
  }

  const result = {
    framesDir: FRAMES_DIR,
    grid: { cols: COLS, rows: ROWS },
    snap: { tol: TOL ?? 90, frac: FRAC ?? 0.12 },
    cases, summary,
  }
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n')
  if (AS_JSON) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else {
    console.log('\n\n序号  区域  宽松框              → 收紧框             塌陷  位置  得分   评估  耗时')
    for (const x of cases) {
      if (!x.ok) { console.log(`${x.id}  ${x.label}  FAILED: ${x.error}`); continue }
      console.log(
        `${x.id}  ${x.label.padEnd(4)}  ${JSON.stringify(x.roi).padEnd(20)}→ ${JSON.stringify(x.box).padEnd(20)}` +
        `${x.collapsed ? ' 是  ' : '    '}${x.positionOk ? ' 对 ' : ' 错 '} ${String(x.score).padEnd(6)}` +
        `${String(x.tries).padStart(3)}  ${String(x.ms).padStart(6)}ms`,
      )
    }
    console.log('\n汇总：' + JSON.stringify(summary, null, 2))
    if (degenerate.length) {
      console.log('\n自匹配找不到自己的区域（低纹理/不独特，模板不可用）：')
      for (const x of degenerate) console.log('  ' + x.id + ' ' + x.label + ' ' + JSON.stringify(x.roi) + ' 得分 ' + x.score)
    }
    console.log('\n注：塌陷 = snap 把框收到原面积的 35% 以下；它是症状不是失败（首批数据里塌陷例位置全部正确）。')
    console.log('    定标要看位置正确率与最终框，并按场景分组攒够样本再决定动不动 TOL/FRAC。')
  }
  return cases.length - ok.length
}

await main().then((failed) => { process.exit(failed ? 1 : 0) }).catch((e) => {
  console.error('survey 失败：' + (e && e.message || e))
  process.exit(1)
})
