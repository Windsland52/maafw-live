#!/usr/bin/env node
/**
 * 契约验收（离线，无设备）：keyframe-retention-contract-v0 §9 关键帧库读侧。
 *
 * 全部直接构造库目录（手写 manifest.json + l0/*.png），走 lib/runtime/keyframes.js
 * 的正式解析入口——与 CLI `kf list/resolve` 共用同一条代码路径，不出现第二份解析。
 * PNG 用 framed.mjs __test 导出的 pngEncodeRGB 生成（无 --child import 无副作用）。
 *
 * 覆盖：
 *  O1 同序号跨库不误解析（完整 ID 含库 UUID；A 库的 ID 在 B 库 → missing）
 *  O2 裸序号 / 不完整 ID 拒绝并说明格式
 *  O3 manifest 未知 schema → unsupported，报错带版本号
 *  O4 manifest 非法 JSON → unsupported "损坏"（不默认重建）
 *  O5 manifest 结构不符（缺 frames）→ unsupported
 *  O6 半写模拟：manifest.json.tmp 残留垃圾，完好 manifest 不受影响（tmp 不入读路径）
 *  O7 L0 文件丢失 → missing；文件被改 → corrupt（sha256 不匹配）
 *  O8 现状记录：同 ID 双记录（库副本手工合并的产物）解析到第一条、不报错——
 *     v0 单写者假设下的已知边界，不是"明确失败"；验收结论记入契约文档。
 *
 * 用法：node scripts/accept-kf-offline.mjs   （无参数，库目录建在系统临时目录）
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadManifest, resolveFrame } from '../lib/runtime/keyframes.js'
import { __test } from '../lib/daemon/framed.mjs'

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`) }
}

/** 内容随 seed 变化的 16x12 PNG */
function framePng(seed) {
  const w = 16, h = 12
  const rgb = Buffer.alloc(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = (seed * 41 + i) & 0xFF
    rgb[i * 3 + 1] = (seed * 17 + i * 3) & 0xFF
    rgb[i * 3 + 2] = (seed * 7 + i * 7) & 0xFF
  }
  return __test.pngEncodeRGB(rgb, w, h)
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

/** 建一个最小库：manifest + n 帧不同内容的 L0 文件。seedBase 按库区分——
 * 两个库的同序号帧内容必须不同，"同序号≠同图"才是有效判据。 */
function makeLib(root, libraryId, n, seedBase) {
  const dir = path.join(root, 'lib-' + libraryId)
  fs.mkdirSync(path.join(dir, 'l0'), { recursive: true })
  const frames = []
  for (let k = 1; k <= n; k++) {
    const png = framePng(seedBase + k)
    const file = 'l0/' + String(k).padStart(4, '0') + '.png'
    fs.writeFileSync(path.join(dir, file), png)
    frames.push({
      id: 'kf:' + libraryId + ':' + String(k).padStart(4, '0'),
      file, sha256: sha(png),
      session: { daemon: 'accept-test', gen: 1, kind: 'adb', target: 'sim' },
      capturedAt: new Date(2026, 9, 5, 10, k).toISOString(),
      captureSeq: k, ctrlW: 1280, ctrlH: 720, smallW: 480, smallH: 270, scale: 0.375,
      source: 'explicit', note: null,
    })
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schema: 1, libraryId, next: n + 1, frames }, null, 2))
  return { dir, frames, libraryId }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-kf-'))
try {
  console.log('O 组：关键帧库读侧（离线）')

  /* O1 同序号跨库不误解析 */
  const A = makeLib(root, 'aaaaaaaa-0000-0000-0000-000000000001', 3, 100)
  const B = makeLib(root, 'bbbbbbbb-0000-0000-0000-000000000002', 2, 200)
  const ra = resolveFrame(A.dir, A.frames[0].id)
  const rb = resolveFrame(B.dir, B.frames[0].id)
  check('O1a 两库各自的 0001 解析成功', ra.status === 'available' && rb.status === 'available', JSON.stringify(ra) + ' / ' + JSON.stringify(rb))
  check('O1b 两库 0001 内容不同（同序号≠同图）', ra.record.sha256 !== rb.record.sha256)
  check('O1c 解析出的文件内容与各自 sha 相符', sha(fs.readFileSync(ra.path)) === ra.record.sha256 && sha(fs.readFileSync(rb.path)) === rb.record.sha256)
  const cross = resolveFrame(B.dir, A.frames[0].id)
  check('O1d A 库的完整 ID 在 B 库 → missing（不误解析成 B 的同序号帧）', cross.status === 'missing' && /无此 ID/.test(cross.reason || ''), JSON.stringify(cross))

  /* O2 不完整 ID */
  const bare = resolveFrame(A.dir, '0001')
  check('O2 裸序号拒绝并说明完整格式', bare.status === 'missing' && /kf:/.test(bare.reason || ''), JSON.stringify(bare))

  /* O3-O5 manifest 各类坏法 */
  const bad = (name, mutate, expectRe) => {
    const C = makeLib(root, 'cccccccc-0000-0000-0000-000000000003', 1, 300)
    const file = path.join(C.dir, 'manifest.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const next = mutate(raw)
    fs.writeFileSync(file, next === undefined ? JSON.stringify(raw) : next)
    const r = loadManifest(C.dir)
    check(name, r.error !== undefined && expectRe.test(r.error || ''), (r.error || '无报错') + '')
    const rf = resolveFrame(C.dir, C.frames[0].id)
    check(name + '（resolve 侧 → unsupported）', rf.status === 'unsupported')
  }
  bad('O3 未知 schema 明确报错', (raw) => { raw.schema = 99 }, /schema=99.*支持/)
  bad('O4 非法 JSON → 损坏', () => '{ "schema": 1, "frames": [ 半写', /损坏.*JSON/)
  bad('O5 缺 frames 数组 → 结构不符', (raw) => { delete raw.frames }, /结构不符/)

  /* O6 半写：tmp 残留不影响完好 manifest */
  const D = makeLib(root, 'dddddddd-0000-0000-0000-000000000004', 1, 400)
  fs.writeFileSync(path.join(D.dir, 'manifest.json.tmp'), '{ 半写垃圾，rename 前崩溃的残骸')
  const rd = resolveFrame(D.dir, D.frames[0].id)
  check('O6 manifest.json.tmp 残留不影响解析（tmp 不入读路径）', rd.status === 'available', JSON.stringify(rd))

  /* O7 文件级损坏 */
  const E = makeLib(root, 'eeeeeeee-0000-0000-0000-000000000005', 2, 500)
  fs.rmSync(path.join(E.dir, 'l0/0001.png'))
  const rmiss = resolveFrame(E.dir, E.frames[0].id)
  check('O7a L0 文件丢失 → missing（不取最新图补位）', rmiss.status === 'missing' && /文件丢失/.test(rmiss.reason || ''), JSON.stringify(rmiss))
  fs.writeFileSync(path.join(E.dir, 'l0/0002.png'), framePng(999))
  const rcorrupt = resolveFrame(E.dir, E.frames[1].id)
  check('O7b 文件被改 → corrupt（sha256 不匹配）', rcorrupt.status === 'corrupt' && /sha256/.test(rcorrupt.reason || ''), JSON.stringify(rcorrupt))

  /* O8 同 ID 双记录（库副本手工合并的形态）——记录现状 */
  const F = makeLib(root, 'ffffffff-0000-0000-0000-000000000006', 1, 600)
  const fm = JSON.parse(fs.readFileSync(path.join(F.dir, 'manifest.json'), 'utf8'))
  const copyRec = { ...fm.frames[0], sha256: sha(framePng(55)), file: 'l0/0002.png' }
  fs.writeFileSync(path.join(F.dir, 'l0/0002.png'), framePng(55))
  fm.frames.push(copyRec)
  fs.writeFileSync(path.join(F.dir, 'manifest.json'), JSON.stringify(fm))
  const rdup = resolveFrame(F.dir, F.frames[0].id)
  if (rdup.status === 'available' && rdup.record.file === 'l0/0001.png') {
    console.log('  （现状）O8 同 ID 双记录解析到第一条、不报错——v0 单写者边界，契约文档记录，不计失败')
  } else {
    check('O8 同 ID 双记录行为可诊断', false, JSON.stringify(rdup))
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
console.log(`\nO 组：${pass} 过 / ${fail} 败`)
process.exit(fail ? 1 : 0)
