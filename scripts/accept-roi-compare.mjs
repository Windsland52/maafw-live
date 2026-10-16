#!/usr/bin/env node
/**
 * roi-compare 验收（**离线**，不需要设备）：**真实识别链路**（MaaFW TemplateMatch）+ 合成画面。
 *
 * 为什么要一份真识别的验收：单测全是桩 daemon（`data.perCase` 造分数），钉得住判据与不变量，
 * 但**钉不住 candidates 这条通道本身**——"父进程把 N 条候选折进同一个 cases、子进程逐例换 roi
 * 回来"只有真跑一次识别才算验过。这里用合成画面把这一步跑通，且完全离线、零外部依赖。
 *
 * 画面几何用**真实棋盘的 15 格坐标**（非均匀：行距 111/120、列距 135→146 逐行不同，
 * 见 test/fixtures/roi-compare-real-grid.mjs）——不再造理想均匀网格。
 *
 * 用法：node scripts/accept-roi-compare.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { __test } from '../lib/daemon/framed.mjs'
import { cropPng } from '../lib/image.js'
import { REAL_GRID } from '../test/fixtures/roi-compare-real-grid.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { pngEncodeRGB } = __test

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name) } else { fail++; console.log('  FAIL ' + name + (detail ? '  — ' + detail : '')) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roi-compare-accept-'))
const RES = path.join(dir, 'res')
fs.mkdirSync(path.join(RES, 'image'), { recursive: true })

/* ── 合成画面 ────────────────────────────────────────────────────────────── */

const W = 1280
const H = 720

/** 一帧 RGB 画布 + 画一个爪印状图案（格心 + 每格抖动，于是格与格"像但不等同"） */
function paintBoard() {
  const rgb = Buffer.alloc(W * H * 3, 0)
  for (let i = 0; i < W * H; i++) { rgb[i * 3] = 40; rgb[i * 3 + 1] = 44; rgb[i * 3 + 2] = 58 }
  const blob = (cx, cy, r, v) => {
    for (let y = Math.max(0, cy - r); y < Math.min(H, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x < Math.min(W, cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue
        const i = (y * W + x) * 3
        rgb[i] = v; rgb[i + 1] = Math.round(v * 0.9); rgb[i + 2] = Math.round(v * 0.7)
      }
    }
  }
  REAL_GRID.rois.forEach((roi, k) => {
    const cx = roi[0] + 34 + (k % 3), cy = roi[1] + 22 + (k % 4)
    blob(cx, cy, 13, 210)                       // 掌
    blob(cx - 11, cy - 12, 5, 230)              // 四趾
    blob(cx - 3, cy - 16, 5, 230)
    blob(cx + 5, cy - 16, 5, 230)
    blob(cx + 12, cy - 12, 5, 230)
  })
  return pngEncodeRGB(rgb, W, H)
}

/** pitch 周期的横向条纹：亮度只随 y 变 → 沿 x 平移像素完全相同 */
function paintStripes(pitch) {
  const w = 680
  const h = 400
  const rgb = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    const phase = (y % pitch) / pitch
    const v = Math.min(255, 40 + Math.round(120 * phase) + Math.round(70 * Math.abs(Math.sin(phase * Math.PI))))
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      rgb[i] = v; rgb[i + 1] = Math.round(v * 0.85); rgb[i + 2] = Math.round(v * 0.6)
    }
  }
  return pngEncodeRGB(rgb, w, h)
}

const BOARD = path.join(dir, 'board.png')
const STRIPES = path.join(dir, 'stripes136.png')
fs.writeFileSync(BOARD, paintBoard())
fs.writeFileSync(STRIPES, paintStripes(136))
/* 模板从画面里**裁**（走 lib/image.js 的同一条无依赖解码路径），不做第二份实现 */
fs.writeFileSync(path.join(RES, 'image', 'cell_0.png'), await cropPng(fs.readFileSync(BOARD), REAL_GRID.rois[0]))
fs.writeFileSync(path.join(RES, 'image', 'stripe.png'), await cropPng(fs.readFileSync(STRIPES), [270, 40, 68, 44]))

/* ── 跑 CLI ──────────────────────────────────────────────────────────────── */

/** 一次性 CLI（退出码 3 = FINDINGS，不是调用失败）：返回 {code, env?, out, err} */
function run(args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'maafw-live.mjs'), ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error) throw r.error
  let env = null
  try { env = JSON.parse(r.stdout) } catch { /* 非 --json 时没有信封 */ }
  return { code: r.status, env, out: r.stdout, err: r.stderr }
}
const compare = (extra) => run(['roi-compare', '--image', BOARD, '--target', 'cell_0.png',
  '--resource-dir', RES, '--rois', REAL_GRID.rois.map((r) => r.join(',')).join(';'), ...extra])

/* ── ① 真实识别 + 真实非均匀 15 格：candidates 通道 + 逐例对应 ────────────── */

console.log('① --rois 真实 15 格（合成画面，真实 TemplateMatch）')
const rois = compare(['--threshold', '0.8', '--json'])
check('命令跑成（退出码 0 或 3）', rois.code === 0 || rois.code === 3, 'code=' + rois.code + ' ' + rois.err)
const d1 = rois.env?.data
check('15 条候选全部发出且全部可评估', d1?.candidates.sent === 15 && d1?.candidates.evaluated === 15,
  JSON.stringify(d1?.candidates))
check('逐例回执 param.roi 与输入顺序一一对应且两两不同（不变量 1）',
  JSON.stringify(d1?.cases.map((c) => c.caseRoi)) === JSON.stringify(REAL_GRID.rois)
  && new Set(d1?.cases.map((c) => c.caseRoi.join(','))).size === 15)
check('ranked 的 roi 能从输入按 origin 还原（不变量 2）',
  (d1?.ranked ?? []).every((x) => JSON.stringify(x.roi) === JSON.stringify(REAL_GRID.rois[x.origin])))
check('自匹配那一格排第一（真识别给得出 1.0）',
  d1?.ranked[0].roi.join(',') === REAL_GRID.rois[0].join(',') && d1.ranked[0].score === 1,
  JSON.stringify(d1?.ranked?.[0]))
check('bestGap 是第 1/2 名的真实分差（无上限照给）',
  d1?.bestGap !== null && d1.bestGap >= 0 && d1.bestGap <= 1, 'bestGap=' + d1?.bestGap)
check('imageSize 来自 daemon 回执的 w/h', d1?.imageSize?.w === W && d1?.imageSize?.h === H)

/* ── ② 真周期图：AMBIGUOUS 必触发 ─────────────────────────────────────────── */

console.log('② --scan 打在 pitch=136 的真周期图上（像素沿 x 完全周期）')
const scan = run(['roi-compare', '--image', STRIPES, '--target', 'stripe.png', '--resource-dir', RES,
  '--roi', '270,40,68,44', '--scan', 'dx=-160..160/8,dy=0', '--json'])
const d2 = scan.env?.data
check('41 个候选（(160+160)/8+1）', d2?.candidates.sent === 41, JSON.stringify(d2?.scan))
check('扫描几何如实回执', d2?.scan?.dx?.from === -160 && d2.scan.dx.step === 8 && d2.scan.step === 8
  && d2.scan.count === 41, JSON.stringify(d2?.scan))
check('AMBIGUOUS + 退出码 3', d2?.verdict === 'AMBIGUOUS' && scan.code === 3,
  d2?.verdict + ' code=' + scan.code)
check('bestGap = 0、并列带覆盖全部 41 个', d2?.bestGap === 0 && d2.withinGap.length === 41,
  'bestGap=' + d2?.bestGap + ' withinGap=' + d2?.withinGap?.length)
const scanHuman = run(['roi-compare', '--image', STRIPES, '--target', 'stripe.png', '--resource-dir', RES,
  '--roi', '270,40,68,44', '--scan', 'dx=-160..160/8,dy=0']).out
check('发现模式如实说"周期结构下不唯一"，并明说不是"位置错了"的判据',
  /结论：AMBIGUOUS/.test(scanHuman) && /周期结构下不唯一/.test(scanHuman)
  && /不是"位置错了"的判据/.test(scanHuman),
  scanHuman.split('\n').filter((l) => l.includes('结论：')).join(''))

/* ── ③ 越界族：跳过并报出 / 全部越界 → FINDINGS ──────────────────────────── */

console.log('③ 越界族（负坐标 / 右下超出 / 全部越界）')
const partial = run(['roi-compare', '--image', BOARD, '--target', 'cell_0.png', '--resource-dir', RES,
  '--rois=0,0,20,20;1250,700,68,44;-50,200,80,300', '--json'])
check('界内候选照常排序，越界的两条都报出来',
  (partial.env?.data?.ranked.length ?? 0) === 1
  && partial.env?.data?.candidates.skipped.length === 2, JSON.stringify(partial.env?.data?.candidates))
check('负坐标的文案点名左上为负',
  /左上 -50,200 为负/.test(JSON.stringify(partial.env?.data?.candidates.skipped)))
const allOob = run(['roi-compare', '--image', BOARD, '--target', 'cell_0.png', '--resource-dir', RES,
  '--rois=1250,700,68,44;-50,200,80,300'])
check('全部越界 → FINDINGS(3) + "参数用错空间"文案',
  allOob.code === 3 && /roi 越出图像/.test(allOob.err) && /参数用错空间/.test(allOob.err),
  'code=' + allOob.code)

/* ── ④ 旧入口仍是薄包装：roi-check 跑得通且判据同源 ─────────────────────── */

console.log('④ roi-check（薄包装，--pitch 136）')
const legacy = run(['roi-check', '--image', BOARD, '--target', 'cell_0.png', '--resource-dir', RES,
  '--roi', REAL_GRID.rois[0].join(','), '--pitch', '136', '--threshold', '0.8', '--json'])
check('退出码与结论成对（0=HIT / 3=其余）', [0, 3].includes(legacy.code) && !!legacy.env?.data?.verdict,
  'code=' + legacy.code + ' verdict=' + legacy.env?.data?.verdict)
check('回执仍带本位置与对照两侧的分数', !!legacy.env?.data?.scores?.base && 'alt' in legacy.env.data.scores,
  JSON.stringify(legacy.env?.data?.scores))

/* ── 收尾 ───────────────────────────────────────────────────────────────── */

fs.rmSync(dir, { recursive: true, force: true })
console.log('\n' + (fail ? 'FAIL' : 'PASS') + '：' + pass + ' 项通过' + (fail ? '，' + fail + ' 项失败' : ''))
process.exit(fail ? 1 : 0)
