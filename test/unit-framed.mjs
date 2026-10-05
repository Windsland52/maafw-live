/**
 * framed.mjs 纯函数单测（headless import，无 --child、无设备）。
 *
 * 这些函数是帧流观测的数学地基：变化检测（blockAnalyze/regionOfBlocks）、
 * L0 字节预算淘汰（l0EvictToBudget）、模板 snap 收紧（tightenBounds）、
 * 裁剪（cropRgb）、SoM 候选（connComponents/edgeDensityBoxes）。
 * 信封级回归（verify-cli）测的是外部契约，这里测的是数值行为——
 * 没有 this 层，下次动 daemon 就只能真机手测兜底。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../src/daemon/framed.mjs'

const { pngDecode, pngEncodeRGB, downscale, blockAnalyze, hashDist,
  regionOfBlocks, tightenBounds, cropRgb, connComponents, edgeDensityBoxes,
  l0EvictToBudget, S } = __test

/* ── 构图工具：所有用例的图像都在这里造，像素级可控 ── */
/** 纯色图 */
function solid(w, h, [r, g, b]) {
  const buf = Buffer.alloc(w * h * 3)
  for (let i = 0; i < w * h; i++) { buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b }
  return buf
}
/** 在图上画实心矩形（不裁剪越界） */
function fillRect(buf, w, x0, y0, rw, rh, [r, g, b]) {
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) {
      if (x < 0 || y < 0 || x >= w) continue
      const i = (y * w + x) * 3
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b
    }
  }
  return buf
}

/* ────────────────────────── PNG 编解码 ────────────────────────── */
test('png 编解码往返保持像素与尺寸', () => {
  const rgb = solid(37, 23, [12, 200, 77])
  fillRect(rgb, 37, 5, 7, 11, 6, [255, 0, 0])
  const png = pngEncodeRGB(rgb, 37, 23)
  const dec = pngDecode(png)
  assert.equal(dec.w, 37); assert.equal(dec.h, 23)
  assert.deepEqual(Buffer.from(dec.data), rgb)
})

test('pngDecode 拒绝非 PNG', () => {
  assert.throws(() => pngDecode(Buffer.from('not a png at all....')), /not a png/)
})

/* ────────────────────────── downscale ────────────────────────── */
test('downscale 保持长边比例且不放大', () => {
  const rgb = solid(100, 60, [10, 20, 30])
  const s = downscale(rgb, 100, 60, 50)
  assert.equal(s.w, 50); assert.equal(s.h, 30)
  const tiny = downscale(rgb, 100, 60, 300) // 目标大于原图：不放大
  assert.equal(tiny.w, 100); assert.equal(tiny.h, 60)
})

/* ────────────────────────── blockAnalyze（变化检测地基） ────────────────────────── */
test('blockAnalyze 均匀图：均值相等、哈希全 1（>= 全局均值）', () => {
  const rgb = solid(64, 64, [100, 100, 100])
  const { hash, means } = blockAnalyze(rgb, 64, 64)
  assert.equal(means.filter((v) => v > 0).length, 64)
  assert.ok(Array.from(hash).every((v) => v === 1))
})

test('blockAnalyze 半亮半暗：哈希位精确反映亮区', () => {
  const w = 64, h = 64
  const rgb = solid(w, h, [0, 0, 0])
  fillRect(rgb, w, 0, 0, w / 2, h, [255, 255, 255]) // 左半亮
  const { hash, means } = blockAnalyze(rgb, w, h)
  for (let k = 0; k < 64; k++) {
    const col = k % 8
    assert.equal(hash[k], col < 4 ? 1 : 0, 'block ' + k)
  }
  assert.ok(means[0] > means[63])
})

test('blockAnalyze 亮度公式：加权 3:6:1', () => {
  // 8x8 单像素/格：每格恰好 1px，means[k] 即该像素亮度
  const w = 8, h = 8
  const rgb = solid(w, h, [0, 0, 0])
  fillRect(rgb, w, 3, 0, 1, 1, [30, 30, 30]) // 亮度 = (90+180+30)*0.1 = 30
  fillRect(rgb, w, 5, 0, 1, 1, [10, 20, 40]) // 亮度 = (30+120+40)*0.1 = 19
  const { means } = blockAnalyze(rgb, w, h)
  assert.equal(means[3], 30)
  assert.equal(means[5], 19)
})

test('hashDist：相同 0、互补 1、已知差异为分数', () => {
  const a = new Uint8Array(64).fill(1)
  assert.equal(hashDist(a, a), 0)
  const b = new Uint8Array(64).fill(0)
  assert.equal(hashDist(a, b), 1)
  const c = new Uint8Array(64).fill(1); c[0] = 0; c[7] = 0 // 2/64
  assert.equal(hashDist(a, c), 2 / 64)
})

/* ────────────────────────── regionOfBlocks（事件变化区域 bbox） ────────────────────────── */
test('regionOfBlocks 单块 → 1/8 尺寸，ctrl 空间按比例放大', () => {
  const r = regionOfBlocks([0], 480, 270, 1280, 720)
  assert.deepEqual(r.small, [0, 0, 60, 34])   // 480/8=60, round(270/8)=34
  assert.deepEqual(r.ctrl, [0, 0, 160, 91])   // ×(1280/480, 720/270)
})

test('regionOfBlocks 跨角两块 → 覆盖大半区域；fw=0 退化为 small 原值', () => {
  const r = regionOfBlocks([0, 63], 480, 270, 1280, 720)
  assert.equal(r.small[0], 0); assert.equal(r.small[1], 0)
  assert.equal(r.small[2], 480); assert.equal(r.small[3], 270)
  assert.equal(r.ctrl[2], 1280); assert.equal(r.ctrl[3], 720)
  const noFw = regionOfBlocks([9], 480, 270, 0, 0) // 换算依据缺失：不猜
  assert.deepEqual(noFw.ctrl, noFw.small)
})

/* ────────────────────────── cropRgb ────────────────────────── */
test('cropRgb 精确裁剪 + 右下越界钳制', () => {
  const w = 10, h = 10
  const rgb = solid(w, h, [0, 0, 0])
  fillRect(rgb, w, 4, 4, 2, 2, [9, 9, 9])
  const c = cropRgb(rgb, w, h, { x: 4, y: 4, w: 2, h: 2 })
  assert.equal(c.w, 2); assert.equal(c.h, 2)
  assert.ok(Buffer.from(c.data).every((v) => v === 9))
  const clipped = cropRgb(rgb, w, h, { x: 9, y: 9, w: 5, h: 5 })
  assert.equal(clipped.w, 1); assert.equal(clipped.h, 1) // 10-9=1
})

/* ────────────────────────── tightenBounds（snap 收紧） ────────────────────────── */
test('tightenBounds 边框背景 + 中央亮块 → 收紧到亮块邻域', () => {
  const w = 120, h = 90
  const rgb = solid(w, h, [20, 20, 20])          // 深色背景铺满
  fillRect(rgb, w, 30, 25, 60, 40, [230, 230, 230]) // 中央亮块 x∈[30,90) y∈[25,65)
  const b = tightenBounds(rgb, w, h)
  assert.ok(b, '应能收紧')
  // 容忍边缘过渡行/列（12% 阈值）：框不得明显小于内容，也不得缩成一点
  assert.ok(b.x >= 25 && b.x <= 32, 'x0 邻域: ' + JSON.stringify(b))
  assert.ok(b.y >= 20 && b.y <= 27, 'y0 邻域')
  assert.ok(b.x + b.w >= 88 && b.x + b.w <= 95, 'x1 邻域')
  assert.ok(b.y + b.h >= 63 && b.y + b.h <= 70, 'y1 邻域')
})

test('tightenBounds 均匀图无内容 → null（交回调用方）', () => {
  assert.equal(tightenBounds(solid(120, 90, [50, 50, 50]), 120, 90), null)
})

/* ────────────────────────── connComponents（SoM 连通域候选） ────────────────────────── */
test('connComponents 找出孤立亮块（面积/边长过滤内）', () => {
  const w = 160, h = 120
  const rgb = solid(w, h, [128, 128, 128])
  fillRect(rgb, w, 20, 30, 40, 40, [255, 255, 255])
  fillRect(rgb, w, 100, 60, 44, 40, [0, 0, 0])
  const boxes = connComponents(rgb, w, h)
  assert.equal(boxes.length, 2, JSON.stringify(boxes))
  const near = (box, cx, cy) => Math.abs(box[0] + box[2] / 2 - cx) < 8 && Math.abs(box[1] + box[3] / 2 - cy) < 8
  assert.ok(boxes.some((b) => near(b, 40, 50) && b[2] >= 32 && b[3] >= 32), '白块')
  assert.ok(boxes.some((b) => near(b, 122, 80) && b[2] >= 36 && b[3] >= 32), '黑块')
})

test('connComponents 平坦图无候选；小噪声块被面积过滤', () => {
  assert.deepEqual(connComponents(solid(160, 120, [90, 90, 90]), 160, 120), [])
  const rgb = solid(160, 120, [90, 90, 90])
  fillRect(rgb, 160, 10, 10, 12, 12, [255, 255, 255]) // 144px² ≥120 但边长 12≥10 → 保留
  const one = connComponents(rgb, 160, 120)
  assert.equal(one.length, 1)
  const rgb2 = solid(160, 120, [90, 90, 90])
  fillRect(rgb2, 160, 10, 10, 8, 8, [255, 255, 255]) // 64px² < 120 → 过滤
  assert.deepEqual(connComponents(rgb2, 160, 120), [])
})

/* ────────────────────────── edgeDensityBoxes（SoM 边缘密度候选） ────────────────────────── */
test('edgeDensityBoxes 棋盘格高频区成框、平坦区无框', () => {
  const w = 128, h = 128
  const flat = solid(w, h, [100, 100, 100])
  const rgb = solid(w, h, [100, 100, 100])
  for (let y = 16; y < 80; y++) for (let x = 16; x < 80; x++) {
    const v = (((x >> 3) + (y >> 3)) & 1) ? 255 : 0
    const i = (y * w + x) * 3; rgb[i] = v; rgb[i + 1] = v; rgb[i + 2] = v
  }
  assert.deepEqual(edgeDensityBoxes(flat, w, h), [])
  const boxes = edgeDensityBoxes(rgb, w, h)
  assert.ok(boxes.length >= 1, JSON.stringify(boxes))
  const b = boxes[0]
  assert.ok(b[0] <= 16 && b[1] <= 16, '框从棋盘格左上开始: ' + JSON.stringify(b))
  assert.ok(b[0] + b[2] >= 72 && b[1] + b[3] >= 72, '覆盖到棋盘格右下: ' + JSON.stringify(b))
})

/* ────────────────────────── l0EvictToBudget（L0 字节预算淘汰） ────────────────────────── */
/* 作用于模块态 S：用例自建快照，结束时整体还原，不污染其他用例。 */
const ent = (seq, bytes) => ({ seq, t: 0, png: Buffer.alloc(bytes), w: 2, h: 2, source: 'test' })
test('l0EvictToBudget 超限先淘汰滚动区；两区共享 seq 不双计', () => {
  const backup = JSON.parse(JSON.stringify({ roll: S.l0.roll, anchor: S.l0.anchor, bytesCap: S.l0.bytesCap, evicted: S.l0.evicted, rollCap: S.l0.rollCap, anchorCap: S.l0.anchorCap }))
  try {
    // 唯一字节 = 10(seq1) + 20(seq2, 两区共享) + 30(seq3) = 60
    S.l0.roll = [ent(1, 10), ent(2, 20)]
    S.l0.anchor = [ent(2, 20), ent(3, 30)]
    S.l0.evicted = 0
    S.l0.bytesCap = 55 // 淘汰 roll.seq1(10) 后 50 ≤ 55
    l0EvictToBudget()
    assert.deepEqual(S.l0.roll.map((e) => e.seq), [2], '只淘汰滚动区最旧')
    assert.deepEqual(S.l0.anchor.map((e) => e.seq), [2, 3], '预算内锚区不动')
    assert.equal(S.l0.evicted, 1)
  } finally {
    Object.assign(S.l0, backup)
  }
})

test('l0EvictToBudget 滚动区耗尽后淘汰锚区最旧；共享字节只在两区都放手时才减', () => {
  const backup = JSON.parse(JSON.stringify({ roll: S.l0.roll, anchor: S.l0.anchor, bytesCap: S.l0.bytesCap, evicted: S.l0.evicted }))
  try {
    S.l0.roll = [ent(1, 10), ent(2, 20)]
    S.l0.anchor = [ent(2, 20), ent(3, 30)]
    S.l0.evicted = 0
    S.l0.bytesCap = 25 // 需要降到 ≤25：roll 全汰(共享 seq2 不减) → 汰锚区 seq2(−20) → 30 仍超 → 汰 seq3(−30) → 0
    l0EvictToBudget()
    assert.equal(S.l0.roll.length, 0)
    assert.deepEqual(S.l0.anchor.map((e) => e.seq), [], '锚区也全数淘汰（30>25）')
    assert.equal(S.l0.evicted, 4)
  } finally {
    Object.assign(S.l0, backup)
  }
})

test('l0EvictToBudget 预算为 0（未配置）不淘汰', () => {
  const backup = JSON.parse(JSON.stringify({ roll: S.l0.roll, anchor: S.l0.anchor, bytesCap: S.l0.bytesCap, evicted: S.l0.evicted }))
  try {
    S.l0.roll = [ent(1, 10)]
    S.l0.anchor = []
    S.l0.evicted = 0
    S.l0.bytesCap = 0
    l0EvictToBudget()
    assert.equal(S.l0.roll.length, 1)
    assert.equal(S.l0.evicted, 0)
  } finally {
    Object.assign(S.l0, backup)
  }
})
