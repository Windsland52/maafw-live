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
import zlib from 'node:zlib'
import { __test } from '../src/daemon/framed.mjs'

const { pngDecode, pngEncodeRGB, downscale, blockAnalyze, hashDist,
  regionOfBlocks, tightenBounds, tightenBoundsByEdges, cropRgb, connComponents, edgeDensityBoxes, pickBalancedCandidates, pickNodeName,
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

/** 结构合法、但 IDAT 解压后字节不足的 PNG。CRC 随便填：这个最小解码器只按 chunk 长度切，不校 CRC */
function shortIdatPng(w, h, rawBytes) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(rawBytes))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 像素数据不足必须报错，不能静默给一张全黑图。
 * 旧行为：`line[x]` 取到 undefined → NaN & 255 = 0，于是"什么都没解出来"和"画面本来就是黑的"
 * 长得一模一样——观测类工具最不能出的错就是把解码失败当成证据。
 */
test('pngDecode 拒绝像素数据不足的 PNG（不给"静默全黑图"留口子）', () => {
  /* 4x4 RGB 需要 4×(1+12) = 52 字节；这里只给 3 字节 */
  assert.throws(() => pngDecode(shortIdatPng(4, 4, 3)), /长度不符/)
  /* 同尺寸给足字节就正常解码：确认拒绝的是长度，不是别的 */
  const ok = pngDecode(shortIdatPng(4, 4, 4 * 13))
  assert.equal(ok.w, 4)
  assert.equal(ok.h, 4)
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

test('tightenBounds 测量覆盖：tol 放宽到看不见弱纹理、收紧到看不见强纹理', () => {
  /* 背景 20，弱纹理块 20+40（通道差合计 120）——默认 TOL=90 视为内容，TOL=150 视为背景 */
  const w = 120, h = 90
  const mk = () => {
    const rgb = solid(w, h, [20, 20, 20])
    fillRect(rgb, w, 30, 25, 60, 40, [60, 60, 60])
    return rgb
  }
  const dflt = tightenBounds(mk(), w, h)
  assert.ok(dflt, '默认 TOL 下弱纹理算内容：' + JSON.stringify(dflt))
  assert.equal(tightenBounds(mk(), w, h, { tol: 150 }), null, '抬高 TOL 后同一张图应判为无内容')
  /* frac 覆盖：把"整行算命中"的门槛抬到不可能达到，收紧同样退化为 null */
  assert.equal(tightenBounds(mk(), w, h, { frac: 0.99 }), null, 'frac 拉高后不构成命中行')
})

test('tightenBounds 不传覆盖时行为与默认常数一致（旧调用点零影响）', () => {
  const w = 120, h = 90
  const rgb = solid(w, h, [20, 20, 20])
  fillRect(rgb, w, 30, 25, 60, 40, [230, 230, 230])
  assert.deepEqual(tightenBounds(rgb, w, h, {}), tightenBounds(rgb, w, h))
  assert.deepEqual(tightenBounds(rgb, w, h, { tol: 0, frac: 0 }), tightenBounds(rgb, w, h),
    '非法覆盖（0/负）回落到生产常数')
})

/* ────────────────────────── pickBalancedCandidates（SoM 上限截断） ────────────────────────── */
test('候选不超上限：原样返回（不打乱源优先级顺序）', () => {
  const list = [
    { source: 'ocr', box: [10, 10, 40, 40] },       // top
    { source: 'conn', box: [10, 400, 40, 40] },     // mid
    { source: 'edge', box: [10, 700, 40, 40] },     // bottom
  ]
  assert.deepEqual(pickBalancedCandidates(list, 30, 720), list)
})

test('候选超上限：按横向分带轮转，底部候选不再被整体截掉', () => {
  /* 供给偏顶部（模拟扫描顺序）：顶部 20 个、中部 2 个、底部 3 个，上限 6 */
  const list = []
  for (let i = 0; i < 20; i++) list.push({ source: 'conn', box: [i, 10, 40, 40] })      // top
  for (let i = 0; i < 2; i++) list.push({ source: 'conn', box: [i, 400, 40, 40] })       // mid
  for (let i = 0; i < 3; i++) list.push({ source: 'conn', box: [i, 700, 40, 40] })       // bottom
  const picked = pickBalancedCandidates(list, 6, 720)
  assert.equal(picked.length, 6)
  const band = (b) => (b[1] + b[3] / 2 < 240 ? 'top' : (b[1] + b[3] / 2 < 480 ? 'mid' : 'bottom'))
  const counts = picked.reduce((a, c) => (a[band(c.box)] = (a[band(c.box)] ?? 0) + 1, a), {})
  /* 轮转一轮各带取一个：上限 6 = 两轮 → 2/2/2；旧策略（截前 6 个）会是 6/0/0 */
  assert.deepEqual(counts, { top: 2, mid: 2, bottom: 2 }, JSON.stringify(counts))
})

test('某一带无供给：其余带补满上限', () => {
  const list = []
  for (let i = 0; i < 10; i++) list.push({ source: 'conn', box: [i, 10, 40, 40] })   // 只有顶部
  const picked = pickBalancedCandidates(list, 4, 720)
  assert.equal(picked.length, 4)
  assert.ok(picked.every((c) => c.box[1] === 10))
})

test('带内保持原顺序（源优先级在带内不被轮转打乱）', () => {
  const list = [
    { source: 'ocr', box: [0, 10, 40, 40] },
    { source: 'conn', box: [0, 20, 40, 40] },
    { source: 'ocr', box: [0, 700, 40, 40] },
    { source: 'conn', box: [0, 710, 40, 40] },
  ]
  const picked = pickBalancedCandidates(list, 3, 720)
  assert.deepEqual(picked.map((c) => c.source), ['ocr', 'ocr', 'conn'],
    '每带先取更高优先级的源：' + JSON.stringify(picked))
})

/* ────────────────────────── pickNodeName（节点记录取哪个名字字段） ──────────────────────────
 * 形状照抄真机抓到的原始通知（MAAFW_NOTIFY_DUMP）：顶层 name 是任务入口名，真名在内嵌 details 里。
 * 这个 bug 曾让 record.nodes[].name 两条记录同名、看不出走了哪条分支，所以按原始形状钉住。 */
test('PipelineNode.Starting：只有顶层名（入口名）→ nameSource=entry，如实标未确认', () => {
  const m = { msg: 'PipelineNode.Starting', node_id: 300000002, name: 'ProbeA' }
  assert.deepEqual(pickNodeName(m), { name: 'ProbeA', source: 'entry' })
})

test('PipelineNode.Succeeded：内嵌 node_details.name 是真节点名，压过顶层入口名', () => {
  const m = {
    msg: 'PipelineNode.Succeeded', node_id: 300000002, name: 'ProbeA',
    node_details: { name: 'ProbeB', node_id: 300000002, reco_id: 400000002, action_id: 500000002, completed: true },
    action_details: { name: 'ProbeB', action: 'DoNothing', success: true },
  }
  assert.deepEqual(pickNodeName(m), { name: 'ProbeB', source: 'node_details' })
})

test('只有 action_details / reco_details 时同样取到真名（字段缺失的版本也能退化工作）', () => {
  assert.deepEqual(pickNodeName({ msg: 'PipelineNode.Succeeded', node_id: 1, name: 'Entry', action_details: { name: 'Real' } }),
    { name: 'Real', source: 'node_details' })
  assert.deepEqual(pickNodeName({ msg: 'PipelineNode.Succeeded', node_id: 1, name: 'Entry', reco_details: { name: 'Real2' } }),
    { name: 'Real2', source: 'node_details' })
  assert.deepEqual(pickNodeName({ msg: 'PipelineNode.Starting', node_id: 7 }), { name: 'node#7', source: 'entry' },
    '连顶层名都没有时给出可辨认的兜底，不返回 undefined')
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

test('connComponents 被拒计数：面积窗两侧分开记，passed 与返回框数一致', () => {
  const w = 200, h = 200
  /* 构造依据（实测，别改成"想当然"的形状）：
   *  - dev 掩码是「偏离局部均值（R=12）」，同色大块的内部并不偏离 → 大块只留一圈边缘环、面积不会超窗；
   *    所以 tooLarge 必须用**大面积细纹理**来构造。
   *  - tooNarrow 在本算法下几乎不可达：环形效应会把细条原地加宽（实测 4×100 与 180×2 都判成通过），
   *    而细密纹理又会碎成逐像素小块落进 tooSmall。此处只断言该计数存在且为 0，并在 roadmap 记下这个发现。 */
  const small = solid(w, h, [90, 90, 90])
  fillRect(small, w, 20, 20, 8, 8, [255, 255, 255])
  const smallStats = { passed: 0, tooSmall: 0, tooLarge: 0, tooNarrow: 0 }
  assert.deepEqual(connComponents(small, w, h, smallStats), [])
  assert.ok(smallStats.tooSmall >= 1, '小块要记进 tooSmall：' + JSON.stringify(smallStats))

  const huge = solid(w, h, [90, 90, 90])
  for (let y = 10; y < 190; y++) for (let x = 10; x < 190; x++) {
    const v = (((x >> 2) + (y >> 2)) & 1) ? 200 : 90
    const i = (y * w + x) * 3
    huge[i] = v; huge[i + 1] = v; huge[i + 2] = v
  }
  const hugeStats = { passed: 0, tooSmall: 0, tooLarge: 0, tooNarrow: 0 }
  connComponents(huge, w, h, hugeStats)
  assert.ok(hugeStats.tooLarge >= 1, '大面积纹理要记进 tooLarge：' + JSON.stringify(hugeStats))

  const kept = solid(w, h, [90, 90, 90])
  fillRect(kept, w, 20, 20, 40, 40, [255, 255, 255])
  const keptStats = { passed: 0, tooSmall: 0, tooLarge: 0, tooNarrow: 0 }
  const boxes = connComponents(kept, w, h, keptStats)
  assert.ok(boxes.length >= 1, '正常块应保留：' + JSON.stringify(boxes))
  assert.equal(keptStats.passed, boxes.length, 'passed 必须等于实际返回的框数：' + JSON.stringify(keptStats))
  assert.equal(keptStats.tooNarrow, 0, '该形状不触发 tooNarrow')
})

test('connComponents 不传 stats 时行为不变（只记账，不改判定）', () => {
  const w = 160, h = 120
  const rgb = solid(w, h, [90, 90, 90])
  fillRect(rgb, w, 10, 10, 12, 12, [255, 255, 255])
  fillRect(rgb, w, 60, 60, 40, 40, [0, 0, 0])
  assert.deepEqual(connComponents(rgb, w, h), connComponents(rgb, w, h, { passed: 0, tooSmall: 0, tooLarge: 0, tooNarrow: 0 }))
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

test('edgeDensityBoxes 测量覆盖：抬高 z 门槛与绝对地板都能让同一张图不再出框', () => {
  /* 弱纹理区：块边缘密度高于均值但不极端——默认门槛能出框，抬高后两类门槛各自都能滤掉它。
   * 这两个旋钮用于量"edge 不出力到底是阈值太严，还是这类内容本来就没边缘"。 */
  const w = 128, h = 128
  const rgb = solid(w, h, [100, 100, 100])
  for (let y = 16; y < 80; y++) for (let x = 16; x < 80; x++) {
    const v = (((x >> 3) + (y >> 3)) & 1) ? 190 : 100   // 对比度 90：弱于上面那块的 255/0
    const i = (y * w + x) * 3; rgb[i] = v; rgb[i + 1] = v; rgb[i + 2] = v
  }
  const dflt = edgeDensityBoxes(rgb, w, h)
  assert.ok(dflt.length >= 1, '默认门槛下弱纹理仍成框: ' + JSON.stringify(dflt))
  assert.deepEqual(edgeDensityBoxes(rgb, w, h, { z: 50 }), [], 'z 门槛高到 50σ → 无框')
  assert.deepEqual(edgeDensityBoxes(rgb, w, h, { min: 1e9 }), [], '绝对地板抬到不可能 → 无框')
  assert.deepEqual(edgeDensityBoxes(rgb, w, h, {}), dflt, '空覆盖 = 生产常数，逐字段一致')
  assert.deepEqual(edgeDensityBoxes(rgb, w, h, { z: 0, min: 0 }), dflt, '非法覆盖（0）回落到生产常数')
})

test('edgeDensityBoxes 被拒计数：平坦图全记 belowZ，passed 与返回框数一致', () => {
  const w = 128, h = 128
  const BS = 16
  const blocks = Math.ceil(w / BS) * Math.ceil(h / BS)
  const flatStats = { passed: 0, belowZ: 0, belowMin: 0, singleBlock: 0 }
  const flat = edgeDensityBoxes(solid(w, h, [100, 100, 100]), w, h, {}, flatStats)
  assert.deepEqual(flat, [], '平坦图无框')
  assert.equal(flatStats.passed, 0)
  assert.equal(flatStats.belowZ, blocks, '平坦图每块都不超均值 → 全部记 belowZ：' + JSON.stringify(flatStats))

  /* 棋盘格：有块超门槛 → 记账要与实际出框数一致 */
  const rgb = solid(w, h, [100, 100, 100])
  for (let y = 16; y < 80; y++) for (let x = 16; x < 80; x++) {
    const v = (((x >> 3) + (y >> 3)) & 1) ? 255 : 0
    const i = (y * w + x) * 3; rgb[i] = v; rgb[i + 1] = v; rgb[i + 2] = v
  }
  const stats = { passed: 0, belowZ: 0, belowMin: 0, singleBlock: 0 }
  const boxes = edgeDensityBoxes(rgb, w, h, {}, stats)
  assert.equal(stats.passed, boxes.length, 'passed 等于出框数：' + JSON.stringify(stats))
  assert.ok(stats.belowZ >= 1 && stats.belowMin >= 0, JSON.stringify(stats))
})

/* ────────────────────────── tightenBoundsByEdges（修法① 的测量旋钮，默认关） ──────────────────────────
 * 语义：阈值跟着**边框环自身**的对比度走（p90 × z，与绝对地板取大者），于是"背景自带纹理"不再是
 * 拦路虎——背景差分会把整片纹理判成非背景而剪不动。这个用例同时钉住"它会收到元素边界"与
 * "均匀图返回 null"，因为它是可复跑的定标旋钮（生产默认走背景差分）。 */
test('tightenBoundsByEdges：纹理背景上收出元素框；均匀图返回 null', () => {
  const w = 80, h = 60
  const rgb = Buffer.alloc(w * h * 3)
  /* 背景：低频正弦纹理（幅度刻意小于元素对比度） */
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const v = 100 + Math.round(8 * Math.sin((x + y) / 6))
      rgb[i] = v; rgb[i + 1] = v; rgb[i + 2] = v
    }
  }
  /* 元素：20..54 × 15..39，强描边 + 内部棋盘（文字/图标那类内部结构） */
  for (let y = 15; y <= 39; y++) {
    for (let x = 20; x <= 54; x++) {
      const i = (y * w + x) * 3
      const border = x === 20 || x === 54 || y === 15 || y === 39
      const v = border ? 240 : (60 + ((x + y) % 2 ? 120 : 0))
      rgb[i] = v; rgb[i + 1] = v; rgb[i + 2] = v
    }
  }
  const t = tightenBoundsByEdges(rgb, w, h)
  assert.ok(t, '应当收出元素框')
  assert.ok(Math.abs(t.x - 20) <= 2 && Math.abs(t.y - 15) <= 2, JSON.stringify(t))
  assert.ok(Math.abs(t.w - 35) <= 4 && Math.abs(t.h - 25) <= 4, JSON.stringify(t))
  assert.equal(tightenBoundsByEdges(solid(w, h, [128, 128, 128]), w, h), null, '均匀图没有内容可收 → null')
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
