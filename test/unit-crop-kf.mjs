/**
 * 从关键帧库留存帧裁剪的单测（headless，无设备无 daemon 子进程）。
 *
 * 两个纯函数就是这条动线的契约面：
 *  - readKfCropSource：库帧当裁剪源前的三层校验（文件在 / sha256 对 / 像素尺寸与库记录一致）——
 *    任一层不符即拒绝，不许把"另一个字节"当成本次裁剪的依据；
 *  - buildL2Provenance：L2 派生物的出处记录（契约 §5）。字段白名单是硬边界：
 *    即便把整条库记录（含 session/target）递进来，设备来源也不许落进 L2（契约 §4.1 隐私）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __test } from '../src/daemon/framed.mjs'

const { readKfCropSource, buildL2Provenance, pngEncodeRGB } = __test

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

/** 内容随 seed 变化的 32x24 原图（尺寸与"控制器分辨率"无关，测的是校验不是大小） */
function framePng(seed, w = 32, h = 24) {
  const rgb = Buffer.alloc(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = (seed * 41 + i) & 0xFF
    rgb[i * 3 + 1] = (seed * 17 + i * 3) & 0xFF
    rgb[i * 3 + 2] = (seed * 7 + i * 7) & 0xFF
  }
  return pngEncodeRGB(rgb, w, h)
}

/** 临时库目录 + 一帧 L0；返回 src（daemon 期望的形状）与清理函数 */
function library(seed = 1, w = 32, h = 24) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-cropkf-'))
  const png = framePng(seed, w, h)
  const file = path.join(dir, '0001.png')
  fs.writeFileSync(file, png)
  return {
    dir, png, file,
    src: {
      id: 'kf:11111111-0000-4000-8000-000000000001:0001',
      path: file, sha256: sha(png), ctrlW: w, ctrlH: h, captureSeq: 7,
      capturedAt: '2026-10-05T10:00:00.000Z',
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

test('库帧可作裁剪源：按像素解码，身份与尺寸回执', () => {
  const L = library()
  try {
    const r = readKfCropSource(L.src)
    assert.equal(r.error, undefined, JSON.stringify(r))
    assert.equal(r.dec.w, 32)
    assert.equal(r.dec.h, 24)
    assert.equal(r.sha, sha(L.png))
    assert.deepEqual(r.source, {
      kind: 'kf', id: L.src.id, sha256: sha(L.png), ctrlW: 32, ctrlH: 24,
      captureSeq: 7, capturedAt: '2026-10-05T10:00:00.000Z',
    })
  } finally { L.cleanup() }
})

test('解析后文件被替换 → 拒绝（sha256 是第二道确认）', () => {
  const L = library()
  try {
    fs.writeFileSync(L.file, framePng(99))
    const r = readKfCropSource(L.src)
    assert.match(String(r.error), /sha256 不匹配/)
    assert.equal(r.dec, undefined, '不得返回解码结果')
  } finally { L.cleanup() }
})

test('库记录尺寸与像素不一致 → 拒绝（记录与文件不同源）', () => {
  const L = library()
  try {
    const r = readKfCropSource({ ...L.src, ctrlW: 1280, ctrlH: 720 })
    assert.match(String(r.error), /与像素实际 32x24 不一致/)
  } finally { L.cleanup() }
})

test('文件丢失 / 非 PNG / 缺 id 或 path 各自可诊断', () => {
  const L = library()
  try {
    const gone = readKfCropSource({ ...L.src, path: path.join(L.dir, 'nope.png') })
    assert.match(String(gone.error), /读取失败/)
    const notPng = path.join(L.dir, 'junk.bin')
    const junk = Buffer.from('not a png at all')
    fs.writeFileSync(notPng, junk)
    /* sha 对上（否则先被 sha 层拦下），才轮到解码层报错 */
    const bad = readKfCropSource({ ...L.src, path: notPng, sha256: sha(junk) })
    assert.match(String(bad.error), /不是可解码的 PNG/)
    assert.match(String(readKfCropSource({ path: L.file }).error), /需要 id/)
    assert.match(String(readKfCropSource({ id: L.src.id }).error), /需要 id/)
    assert.match(String(readKfCropSource(null).error), /必须是对象/)
  } finally { L.cleanup() }
})

test('L2 出处记录：来源 + 裁剪变换 + 自匹配结论', () => {
  const L = library()
  try {
    const src = readKfCropSource(L.src).source
    const p = buildL2Provenance({
      source: src, loose: [10, 20, 30, 40], box: [12, 22, 16, 12], snapped: true,
      score: 0.987, positionOk: true, selfMatchBox: [12, 22, 16, 12], tries: 5,
      w: 16, h: 12, createdAt: '2026-10-05T10:01:00.000Z',
    })
    assert.equal(p.schema, 1)
    assert.equal(p.level, 'L2')
    assert.deepEqual(p.derivedFrom, src)
    assert.deepEqual(p.transform, {
      op: 'crop', resize: false, scale: 1, loose: [10, 20, 30, 40], crop: [12, 22, 16, 12], snapped: true,
    })
    assert.deepEqual(p.selfMatch, { score: 0.987, positionOk: true, box: [12, 22, 16, 12], tries: 5 })
    assert.deepEqual(p.output, { w: 16, h: 12 })
    assert.equal(p.createdAt, '2026-10-05T10:01:00.000Z')
    assert.equal(p.cross, null, '未做跨帧验证时明确为 null，不默认成功')
  } finally { L.cleanup() }
})

test('L2 出处字段白名单：整条库记录递进来也不带设备来源（契约 §4.1 隐私）', () => {
  const L = library()
  try {
    /* 故意递整条库记录（含 readKfCropSource 之后才会有的 kind）：多出的 session/target/note 一律不许进 L2 */
    const full = {
      kind: 'kf',
      ...L.src,
      session: { daemon: 'daemon-uuid-1234', gen: 3, kind: 'adb', target: '127.0.0.1:16384' },
      source: 'explicit', note: '账号 xxx 的界面', scale: 0.375, smallW: 480, smallH: 270,
    }
    const p = buildL2Provenance({
      source: full, loose: [0, 0, 8, 8], box: [0, 0, 8, 8], snapped: false,
      score: 1, positionOk: true, tries: 1, w: 8, h: 8, createdAt: '2026-10-05T10:02:00.000Z',
    })
    const text = JSON.stringify(p)
    assert.deepEqual(Object.keys(p.derivedFrom).sort(),
      ['captureSeq', 'capturedAt', 'ctrlH', 'ctrlW', 'id', 'kind', 'sha256'])
    for (const leak of ['127.0.0.1', 'daemon-uuid-1234', '账号', 'session', 'target']) {
      assert.ok(!text.includes(leak), 'L2 出处不得含 ' + leak + '：' + text)
    }
  } finally { L.cleanup() }
})

test('L2 出处对热缓存源同样成立（kind 区分，seq 保留）', () => {
  const p = buildL2Provenance({
    source: { kind: 'l0-cache', seq: 42, sha256: 'abc', ctrlW: 1280, ctrlH: 720, capturedAt: '2026-10-05T10:03:00.000Z' },
    loose: [0, 0, 8, 8], box: [0, 0, 8, 8], snapped: false, score: 1, positionOk: true,
    tries: 1, w: 8, h: 8, createdAt: '2026-10-05T10:03:00.000Z',
  })
  assert.deepEqual(p.derivedFrom, {
    kind: 'l0-cache', seq: 42, sha256: 'abc', ctrlW: 1280, ctrlH: 720, capturedAt: '2026-10-05T10:03:00.000Z',
  })
})

/**
 * resolveFrame 的契约是"如实报状态"，不该给调用方异常：
 * 非字符串 id（缺字段、拼错的调用方）走「不可复核」而不是 TypeError——
 * 实测来源：真机验收里 derivedFrom.id 为 undefined 时它抛 startsWith，把整条验收打断。
 */
test('resolveFrame：非字符串 id 报 missing 而不是抛异常', async () => {
  const { resolveFrame } = await import('../lib/runtime/keyframes.js')
  const L = library()
  try {
    for (const bad of [undefined, null, 42, {}, '']) {
      const r = resolveFrame(L.dir, bad)
      assert.equal(r.status, 'missing', JSON.stringify({ bad, r }))
      assert.match(String(r.reason), /完整 ID/)
    }
  } finally { L.cleanup() }
})

/**
 * 缺省落点不写调用方 cwd（踩过两次：maa_frame_*.png / maa_som_*.png 进了项目仓库）。
 * 约定：落到 daemon 的 runDir/out（一次性命令给的是临时目录）；给了 out 就按 out 走。
 */
test('defaultOutFile：缺省落在 runDir/out，不落 cwd；无 runDir 时退回临时目录', () => {
  const { defaultOutFile } = __test
  const r1 = defaultOutFile('C:/run/dir', 'frame-7', 1700000000000)
  assert.match(r1.file.replace(/\\/g, '/'), /^C:\/run\/dir\/out\/frame-7-1700000000000\.png$/)
  assert.equal(r1.dir.replace(/\\/g, '/'), 'C:/run/dir/out')
  const r2 = defaultOutFile(null, 'som', 1700000000000)
  assert.ok(!r2.file.replace(/\\/g, '/').startsWith(process.cwd().replace(/\\/g, '/')), '不能落在调用方 cwd：' + r2.file)
  assert.match(r2.file.replace(/\\/g, '/'), /\/out\/som-1700000000000\.png$/)
})

/**
 * 坏参数不该有副作用：既没 roi 也没 point 的请求要在**取源/升格之前**就被拒。
 *
 * 曾经校验排在升格之后——`crop --keep-source` 只要忘了给框，这次失败调用就先往关键帧库里
 * 塞了一条留存帧（框错了可以重来，"库里多一条"不会自己消失）。
 * 用合法的 L0 原图 + 临时 runDir：旧顺序会走到升格、在 runDir/frames 下落库，本用例因此有牙齿。
 */
test('tpl_crop：坏参数（既没 roi 也没 point）先被拒，不取源、不升格', async () => {
  const { cmdTplCrop, S } = __test
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-crop-args-'))
  const saved = { runDir: S.runDir, roll: S.l0.roll, anchor: S.l0.anchor, ring: S.ring, session: S.session }
  try {
    S.runDir = runDir
    S.l0.roll = [{ seq: 7, t: Date.now(), png: framePng(9), w: 32, h: 24 }]
    S.l0.anchor = []
    S.ring = [{ seq: 7, w: 8, h: 6, fw: 32, fh: 24 }]
    S.session = null
    const r = await cmdTplCrop({ keepSource: true })
    assert.equal(r.ok, false, '坏参数必须失败：' + JSON.stringify(r))
    assert.match(String(r.error), /--roi/, '要给的是用法错误，而不是走完取源/升格才失败')
    assert.ok(!fs.existsSync(path.join(runDir, 'frames')), '坏参数不该建库、更不该升格')
  } finally {
    S.runDir = saved.runDir; S.l0.roll = saved.roll; S.l0.anchor = saved.anchor
    S.ring = saved.ring; S.session = saved.session
    fs.rmSync(runDir, { recursive: true, force: true })
  }
})
