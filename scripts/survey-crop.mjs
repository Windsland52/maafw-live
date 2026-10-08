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
 * **`--truth`（定标闭环的对外可验证那一半）**：positionOk 是自洽指标（模板在同帧上找得到自己），
 * 模板把背景连元素一起裁进去也照样为真。给了人工标注的真值文件后，每个最终框都按 IoU 与真值对账，
 * 报**漏报（recall）与误报（precision）**；判定口径与真值文件格式见 `scripts/survey-truth.mjs`
 * 头部与 `scripts/truth/README.md`（种子集在 `scripts/truth/1999-720p.json`，要长）。
 * 不给 `--cases` 时用真值框按 `--truth-pad` 的档位自动生成输入框（缺省两档：每边 +6px 与长边的 25%），
 * 一档是"按建议余量给框"，另一档是"给得很大"——后者正是历史上 snap 会偏的那种输入。
 *
 * 用法：
 *   node scripts/survey-crop.mjs [--frames-dir <dir>] [--frames 2] [--cols 3] [--rows 2] [--json] [--out <file>]
 *                                [--cases <file>] [--truth <file>] [--truth-pad 6,25%] [--truth-iou 0.5]
 * 前置：npm run build（走 lib/ 与包内 daemon）。耗时：每个 ROI 起若干识别子进程，默认一档约 5-10 分钟，
 * 建议放后台跑。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnDaemon } from '../lib/client/daemon.js'
import { defaultFramesDir, loadManifest } from '../lib/runtime/keyframes.js'
import { parseTruth, matchFrame, aggregate, padspecsToRois, overlaps } from './survey-truth.mjs'

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
/** 人工真值文件（定标闭环）：给了就按 IoU 判命中，报 recall/precision。见 scripts/truth/README.md */
const TRUTH = arg('--truth', null)
/** 真值自动生成输入框时的余量档位：绝对像素或元素长边的百分比，逗号分隔 */
const TRUTH_PAD = arg('--truth-pad', '6,25%')
/** 命中门槛（IoU）。默认 0.5：框贴合才算找到 */
const TRUTH_IOU = Number(arg('--truth-iou', 0.5))
/** snap 测量覆盖（不给就用生产常数 90 / 0.12）：定标靠 A/B，所以旋钮从这里进来 */
const TOL = Number(arg('--tol', 0)) || undefined
const FRAC = Number(arg('--frac', 0)) || undefined

/** 自造的临时目录要回收：mkdtemp 出来的目录不清理，每跑一次脚本就漏一个 */
const tempDirs = []

/** 自匹配要加载资源；没给就现造一个最小资源（pipeline 里一个不需要模型与图片的节点），保持脚本可移植 */
function ensureResource(explicit) {
  if (explicit) return explicit
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-survey-res-'))
  tempDirs.push(dir)
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
  /** 真值：在校验通过后填充。声明在 try 之外——汇总阶段（跨帧对账）要用，而 finally 只负责收尾 */
  let truth = null
  /** 真值按帧分组：判定只在同帧内做——跨帧比框没有意义（元素位置随页面走） */
  const truthByFrame = new Map()
  try {
    /* 用例来源三条：--cases 给的真实 UI 目标（含同一元素的不同余量档）、真值框自动外扩，或网格 ROI */
    const byId = new Map(picks.map((r) => [r.id.slice(-4), r]))
    if (TRUTH) {
      const parsed = parseTruth(JSON.parse(fs.readFileSync(TRUTH, 'utf8')), Object.fromEntries(byId))
      if (parsed.errors.length) throw new Error('真值文件不可用（' + TRUTH + '）：\n  - ' + parsed.errors.join('\n  - '))
      if (!parsed.entries.length) throw new Error('真值文件里没有条目（' + TRUTH + '）：空集打不出 recall/precision，只会得到一串 null')
      truth = parsed.entries
      const unselected = truth.filter((t) => !byId.has(t.id))
      if (unselected.length) throw new Error('真值引用了本次未选中的帧：' + unselected.map((t) => t.id).join(', ') + '（用 --frames 调大取样范围）')
    }
    for (const t of truth ?? []) {
      if (!truthByFrame.has(t.id)) truthByFrame.set(t.id, [])
      truthByFrame.get(t.id).push(t)
    }
    const plan = CASES
      ? JSON.parse(fs.readFileSync(CASES, 'utf8')).map((x) => {
          const rec = byId.get(String(x.id))
          if (!rec) throw new Error('用例引用了本次未选中的帧：' + x.id + '（用 --frames 调大取样范围）')
          return { rec, label: String(x.label ?? x.id), roi: x.roi.map(Number), why: x.why ?? null }
        })
      : truth
        ? (() => {
            /* 真值外扩的档位含绝对像素，跨分辨率混跑会得到两种含义的 "+6px"，先拒掉 */
            const dims = new Set([...truthByFrame.keys()].map((id) => byId.get(id).ctrlW + 'x' + byId.get(id).ctrlH))
            if (dims.size > 1) throw new Error('真值跨了不同分辨率的帧（' + [...dims].join(' / ') + '）：余量档按像素算，请分次跑')
            const size = { w: byId.get(truth[0].id).ctrlW, h: byId.get(truth[0].id).ctrlH }
            return padspecsToRois(truth, String(TRUTH_PAD).split(',').map((s) => s.trim()).filter(Boolean), size)
              .map(({ entry, label, roi }) => ({ rec: byId.get(entry.id), label, roi, why: entry.why }))
          })()
        : picks.flatMap((rec) => gridRois(rec.ctrlW, rec.ctrlH, COLS, ROWS).map((g) => ({ rec, label: g.label, roi: g.roi, why: null })))
    /* 哪些真值真的被"问到"了：看有没有哪个用例的输入框与它相交。没被问到的真值不进 recall 分母——
     * `--cases` 只跑一半元素、或网格恰好漏掉某个元素时，"没问"不是"没找到"，算成漏报就是把仪器的缺口
     * 记到工具头上。精度侧它照常参与（框压在它上面仍然算找对了地方）。 */
    const roisByFrame = new Map()
    for (const { rec, roi } of plan) {
      const id = rec.id.slice(-4)
      if (!roisByFrame.has(id)) roisByFrame.set(id, [])
      roisByFrame.get(id).push(roi)
    }
    for (const [id, list] of truthByFrame) {
      const rois = roisByFrame.get(id) ?? []
      for (const t of list) t.asked = rois.some((r) => overlaps(r, t.box))
    }
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
      /* 真值判定：本帧有标注才判（无标注的帧记 unscored，不冒充误报）。一个用例出一个最终框， */
      /* 所以逐用例先算出它自己那一行的结论，跨用例的 precision/recall 由 aggregate 汇总。 */
      const truths = truthByFrame.get(rec.id.slice(-4)) ?? null
      const judged = box && truths ? matchFrame([{ label, box }], truths, TRUTH_IOU).finals[0] : null
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
        ...(judged
          ? {
              truth: {
                matched: judged.matched, overlapped: judged.overlapped, bestIou: judged.bestIou,
                truthLabel: judged.truth, truthId: judged.truthId, areaRatio: judged.areaRatio,
              },
            }
          : {}),
      })
      process.stdout.write('.')
    }
  } finally {
    try { c.close() } catch { /* ignore */ }
    /* 回收所有临时目录（runDir + 自造的资源目录）；清理失败不该盖掉测量结果
     * （Windows 上 close 的 kill 有 1.5s 延迟，紧接着 rmSync 偶发 EPERM） */
    for (const dir of [runDir, ...tempDirs]) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
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

  /* 真值汇总：按帧分层喂给 aggregate（无标注帧的最终框只计入 unscored，不进 precision 分母） */
  const truthFrames = truth
    ? [...truthByFrame.keys()].map((id) => ({
        id,
        match: matchFrame(ok.filter((x) => x.id === id && x.box).map((x) => ({ label: x.label, box: x.box })), truthByFrame.get(id), TRUTH_IOU),
      }))
    : null
  const truthSummary = truthFrames ? aggregate(truthFrames, TRUTH_IOU) : null

  const result = {
    framesDir: FRAMES_DIR,
    grid: { cols: COLS, rows: ROWS },
    snap: { tol: TOL ?? 90, frac: FRAC ?? 0.12 },
    cases, summary,
    ...(truthSummary ? { truth: { file: TRUTH, pads: String(TRUTH_PAD), summary: truthSummary, byFrame: truthFrames } } : {}),
  }
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n')
  if (AS_JSON) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else {
    console.log('\n\n序号  区域  宽松框              → 收紧框             塌陷  位置  得分   评估  耗时' + (truthSummary ? '  真值' : ''))
    for (const x of cases) {
      if (!x.ok) { console.log(`${x.id}  ${x.label}  FAILED: ${x.error}`); continue }
      const hit = x.truth ? (x.truth.matched ? ' 命中' : (x.truth.overlapped ? ' 松 ' : ' 误报')) : ''
      console.log(
        `${x.id}  ${x.label.padEnd(4)}  ${JSON.stringify(x.roi).padEnd(20)}→ ${JSON.stringify(x.box).padEnd(20)}` +
        `${x.collapsed ? ' 是  ' : '    '}${x.positionOk ? ' 对 ' : ' 错 '} ${String(x.score).padEnd(6)}` +
        `${String(x.tries).padStart(3)}  ${String(x.ms).padStart(6)}ms${hit}`,
      )
    }
    console.log('\n汇总：' + JSON.stringify(summary, null, 2))
    if (degenerate.length) {
      console.log('\n自匹配找不到自己的区域（低纹理/不独特，模板不可用）：')
      for (const x of degenerate) console.log('  ' + x.id + ' ' + x.label + ' ' + JSON.stringify(x.roi) + ' 得分 ' + x.score)
    }
    console.log('\n注：塌陷 = snap 把框收到原面积的 35% 以下；它是症状不是失败（首批数据里塌陷例位置全部正确）。')
    console.log('    定标要看位置正确率与最终框，并按场景分组攒够样本再决定动不动 TOL/FRAC。')
    if (truthSummary) {
      const t = truthSummary
      console.log('\n真值对账（' + TRUTH + '，命中门槛 IoU>=' + t.iouThr + '）：')
      console.log(`  漏报 recall     ${t.recall}%   （${t.truthsAsked - t.missed.length}/${t.truthsAsked} 个真值被某个最终框覆盖；连沾边都没有的 ${t.missedLoose.length} 个 → 宽松口径 ${t.recallLoose}%）`)
      console.log(`  误报 precision  ${t.precision}%   （${t.scoredFinals - t.falsePositivesLoose.length}/${t.scoredFinals} 个最终框沾到了真值；严口径 ${t.precisionStrict}%，差额 ${t.looseHits.length} 个是"压住了但框不贴合"）`)
      console.log(`  命中框贴合度    面积比中位 ${t.areaRatio.median}（最大 ${t.areaRatio.max}）——>1 就是把背景裁进来了`)
      if (t.missed.length) {
        console.log('  漏报明细（严口径）：')
        for (const m of t.missed) console.log(`    ${m.frame} ${m.label} 真值 ${JSON.stringify(m.box)} 最佳 IoU ${m.bestIou}`)
      }
      if (t.falsePositivesLoose.length) {
        console.log('  完全落空的最终框（两个口径都算误报）：')
        for (const m of t.falsePositivesLoose) console.log(`    ${m.frame} ${m.label} 框 ${JSON.stringify(m.box)}`)
      }
      if (t.looseHits.length) {
        console.log('  压住了但框不贴合（严口径记误报、松口径记命中——差额全在这）：')
        for (const m of t.looseHits) console.log(`    ${m.frame} ${m.label} 框 ${JSON.stringify(m.box)} 最佳 IoU ${m.bestIou}`)
      }
      if (t.uncovered.length) {
        console.log(`  另有 ${t.uncovered.length} 个真值没有任何用例输入问到，未计入 recall（"没问"不是"没找到"）：`)
        for (const m of t.uncovered) console.log(`    ${m.frame} ${m.label} 真值 ${JSON.stringify(m.box)}`)
      }
      if (t.unscoredFinals) console.log(`  另有 ${t.unscoredFinals} 个最终框落在没有标注的帧上，未参与判定（没标注 ≠ 那里没有元素）`)
      console.log('  口径与加标注流程见 scripts/truth/README.md；"位置正确率"是本表上方的自洽指标，两者不要互相替代。')
    }
  }
  return cases.length - ok.length
}

/* 用 exitCode 而不是 process.exit：stdout 走管道时是异步写，exit 会把还没落地的汇总行截掉 */
/* （实测：报错前只冲出 6 个进度点，另外 6 个连同末尾输出一起没了）。daemon 已 shutdown，事件循环自然排空。 */
await main().then((failed) => { process.exitCode = failed ? 1 : 0 }).catch((e) => {
  console.error('survey 失败：' + (e && e.message || e))
  process.exitCode = 1
})
