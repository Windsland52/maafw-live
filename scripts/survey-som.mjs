#!/usr/bin/env node
/**
 * SoM 候选测量（离线，不需要设备）：以关键帧库留存帧为数据集，量 annotate 的候选画像。
 *
 * 为什么要有它：roadmap 待办 1 里 SoM 那一半（连通域面积过滤、边缘 z 值、候选上限 30、IoU 合并阈值）
 * 一直没测过——而且 `annotate` 原先只能吃**会话内** L1 环，没有库帧入口，批量取样无从谈起。
 * 现在走 `kfSource`（控制器分辨率、离线）取样，指标固定成四项：
 *   1. 各源候选数、是否**打满上限 30**（打满意味着候选被截断，不是内容决定的）；
 *   2. 候选尺寸分布（面积分位）；
 *   3. **横向分带分布**（上/中/下三段各多少）——暗底 UI 常在下段，用来发现"工具看不见的地方"；
 *   4. **画面覆盖率**（按 8px 格子去重后，候选并集占整帧的比例）。
 *
 * 判据说明：覆盖率低 + 某一带为 0，说明该源对那类内容不敏感（例如 conn 偏亮连通域）；
 * 这不是"工具坏了"，而是要知道什么时候该换源或走点选路径。
 *
 * 用法：
 *   node scripts/survey-som.mjs [--frames-dir <dir>] [--frames 4] [--resource-dir <dir>] [--json] [--out <file>]
 *                               [--limit 200] [--edge-z 0.6] [--edge-min 600] [--iou 0.4]
 *   不给 --resource-dir 就没有 ocr 源（其余源纯 CPU，毫秒级）；给了要用带 OCR 模型的资源目录。
 *   后三个覆盖用于定标 A/B：实测放松 edge 门槛不会让 edge 独立候选变多（大簇被 conn 吸收），
 *   合并 IoU 0.4/0.6/0.8 的候选画像也几乎不变——见 roadmap.local.md 第十三轮。
 * 前置：npm run build。
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
const FRAMES = Number(arg('--frames', 4))
const RESOURCE = arg('--resource-dir', null)
/** 候选上限覆盖：>30 时能看到"被默认上限截掉的部分"（默认不传 = 生产值 30） */
const LIMIT = Number(arg('--limit', 0)) || undefined
/** edge 源阈值与合并 IoU 的测量覆盖（默认 = 生产值 1.2 / 2000 / 0.6） */
const EDGE_Z = Number(arg('--edge-z', 0)) || undefined
const EDGE_MIN = Number(arg('--edge-min', 0)) || undefined
const IOU = Number(arg('--iou', 0)) || undefined
const AS_JSON = process.argv.includes('--json')
const OUT = arg('--out', null)

const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

/** 候选并集覆盖率：按 8px 格子去重（与画面上"被标记的区域"口径一致） */
function coverage(boxes, w, h, block = 8) {
  const gw = Math.ceil(w / block), gh = Math.ceil(h / block)
  const grid = new Uint8Array(gw * gh)
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b[0] / block)), x1 = Math.min(gw - 1, Math.floor((b[0] + b[2] - 1) / block))
    const y0 = Math.max(0, Math.floor(b[1] / block)), y1 = Math.min(gh - 1, Math.floor((b[1] + b[3] - 1) / block))
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y * gw + x] = 1
  }
  let hit = 0
  for (const v of grid) if (v) hit++
  return Math.round((hit / (gw * gh)) * 1000) / 10
}

async function main() {
  const { manifest, error } = loadManifest(FRAMES_DIR)
  if (error) throw new Error('manifest 不可读：' + error)
  if (!manifest) throw new Error('库内无 manifest：' + FRAMES_DIR)
  const picks = manifest.frames.slice(-FRAMES)

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-som-'))
  const c = spawnDaemon({ runDir })
  const rows = []
  try {
    for (const rec of picks) {
      const abs = path.join(FRAMES_DIR, ...rec.file.split('/'))
      if (!fs.existsSync(abs)) { rows.push({ id: rec.id, error: 'L0 文件丢失' }); continue }
      const r = await c.call('annotate', {
        kfSource: {
          id: rec.id, path: abs, sha256: rec.sha256, ctrlW: rec.ctrlW, ctrlH: rec.ctrlH,
          captureSeq: rec.captureSeq, capturedAt: rec.capturedAt,
        },
        ...(RESOURCE ? { resourceDir: RESOURCE } : {}),
        ...(LIMIT ? { somLimit: LIMIT } : {}),
        ...(EDGE_Z ? { somEdgeZ: EDGE_Z } : {}),
        ...(EDGE_MIN ? { somEdgeMin: EDGE_MIN } : {}),
        ...(IOU ? { somIoU: IOU } : {}),
        out: path.join(runDir, rec.id.slice(-4) + '-som.png'),
      }, 180000)
      if (r.ok === false) { rows.push({ id: rec.id, error: String(r.error) }); continue }
      const cands = r.candidates ?? []
      const boxes = cands.map((x) => x.box)
      const h = rec.ctrlH
      const band = (b) => {
        const cy = b[1] + b[3] / 2
        return cy < h / 3 ? 'top' : (cy < (2 * h) / 3 ? 'mid' : 'bottom')
      }
      const bands = { top: 0, mid: 0, bottom: 0 }
      for (const b of boxes) bands[band(b)]++
      /* edge 源单独看：它长期只出个位数候选，阈值放松后补上的区域落在哪一段才是关键 */
      const edgeBands = { top: 0, mid: 0, bottom: 0 }
      for (const c of cands) if (c.source === 'edge') edgeBands[band(c.box)]++
      /* 被默认上限 30 截掉的那部分长什么样：源构成 + 面积中位。放开上限时才算。 */
      const beyond = cands.slice(30)
      const countBy = (list) => list.reduce((a, x) => (a[x.source] = (a[x.source] ?? 0) + 1, a), {})
      rows.push({
        id: rec.id.slice(-4), note: rec.note,
        count: cands.length,
        limit: r.limit ?? 30,
        mergedTotal: r.mergedTotal ?? cands.length,
        truncated: (r.mergedTotal ?? cands.length) > cands.length,
        capHit: cands.length >= (r.limit ?? 30),
        sources: r.sources,
        unavailable: r.sourcesUnavailable ?? null,
        areas: boxes.map((b) => b[2] * b[3]),
        bands,
        edgeBands,
        coveragePct: coverage(boxes, rec.ctrlW, rec.ctrlH),
        texts: cands.filter((c) => c.text).length,
        ...(beyond.length
          ? {
              beyondCount: beyond.length,
              beyondSources: countBy(beyond),
              beyondAreaMedian: median(beyond.map((b) => b.box[2] * b.box[3])),
              beyondBands: beyond.reduce((a, b) => (a[band(b.box)] = (a[band(b.box)] ?? 0) + 1, a), {}),
            }
          : {}),
      })
    }
  } finally {
    try { c.close() } catch { /* ignore */ }
    fs.rmSync(runDir, { recursive: true, force: true })
  }

  const ok = rows.filter((r) => !r.error)
  const allAreas = ok.flatMap((r) => r.areas)
  const summary = {
    frames: ok.length,
    failed: rows.length - ok.length,
    limit: LIMIT ?? 30,
    capHitFrames: ok.filter((r) => r.capHit).length,
    truncatedFrames: ok.filter((r) => r.truncated).length,
    /** 截断前（去重后）的真实候选规模——上限是绑定约束时，这个数才是画面里"有多少区域" */
    merged: {
      min: ok.length ? Math.min(...ok.map((r) => r.mergedTotal)) : null,
      median: median(ok.map((r) => r.mergedTotal)),
      max: ok.length ? Math.max(...ok.map((r) => r.mergedTotal)) : null,
      total: ok.reduce((a, r) => a + r.mergedTotal, 0),
      keptTotal: ok.reduce((a, r) => a + r.count, 0),
    },
    counts: { min: ok.length ? Math.min(...ok.map((r) => r.count)) : null, median: median(ok.map((r) => r.count)) },
    area: { min: allAreas.length ? Math.min(...allAreas) : null, median: median(allAreas), max: allAreas.length ? Math.max(...allAreas) : null },
    bands: {
      top: ok.reduce((a, r) => a + r.bands.top, 0),
      mid: ok.reduce((a, r) => a + r.bands.mid, 0),
      bottom: ok.reduce((a, r) => a + r.bands.bottom, 0),
    },
    coveragePctMedian: median(ok.map((r) => r.coveragePct)),
    ocrCandidates: ok.reduce((a, r) => a + (r.sources?.ocr ?? 0), 0),
    edgeCandidates: ok.reduce((a, r) => a + (r.sources?.edge ?? 0), 0),
    edgeBands: {
      top: ok.reduce((a, r) => a + (r.edgeBands?.top ?? 0), 0),
      mid: ok.reduce((a, r) => a + (r.edgeBands?.mid ?? 0), 0),
      bottom: ok.reduce((a, r) => a + (r.edgeBands?.bottom ?? 0), 0),
    },
  }
  const result = { framesDir: FRAMES_DIR, resourceDir: RESOURCE, tune: { limit: LIMIT ?? 30, edgeZ: EDGE_Z ?? 1.2, edgeMin: EDGE_MIN ?? 2000, iou: IOU ?? 0.6 }, rows, summary }
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n')
  if (AS_JSON) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else {
    console.log('\n帧     保留/合并  打满  ocr/conn/edge/diff     上/中/下        覆盖率  面积中位')
    for (const r of rows) {
      if (r.error) { console.log(`${r.id}  FAILED: ${r.error}`); continue }
      console.log(
        `${r.id}  ${String(r.count).padStart(4)}/${String(r.mergedTotal).padEnd(4)}  ${r.capHit ? ' 是 ' : '    '}  ` +
        `${String(r.sources?.ocr ?? 0).padStart(3)}/${String(r.sources?.conn ?? 0).padStart(4)}/` +
        `${String(r.sources?.edge ?? 0).padStart(4)}/${String(r.sources?.diff ?? 0).padStart(4)}   ` +
        `${String(r.bands.top).padStart(3)}/${String(r.bands.mid).padStart(3)}/${String(r.bands.bottom).padStart(3)}   ` +
        `${String(r.coveragePct).padStart(6)}%  ${median(r.areas)}`,
      )
      if (r.beyondCount) {
        console.log('       被默认上限 30 截掉：' + r.beyondCount + ' 个  源构成 ' + JSON.stringify(r.beyondSources) +
          '  面积中位 ' + r.beyondAreaMedian + '  分带 ' + JSON.stringify(r.beyondBands))
      }
    }
    console.log('\n汇总：' + JSON.stringify(summary, null, 2))
    console.log('\n注：保留/合并 = 进候选表的数量 / 去重后的真实总数（打满时两者不等，差额就是被上限截掉的）；')
    console.log('    某一段为 0 或覆盖率很低，说明该源对那类内容不敏感——换源或走点选路径，不是调参能救的。')
  }
  return rows.filter((r) => r.error).length
}

await main().then((failed) => { process.exit(failed ? 1 : 0) }).catch((e) => {
  console.error('survey 失败：' + (e && e.message || e))
  process.exit(1)
})
