#!/usr/bin/env node
/**
 * 契约验收（需真机/模拟器在线）：keyframe-retention-contract-v0 §9 列出但未实测的用例。
 *
 * R1 旧帧捕获后改变控制器分辨率，ROI 仍使用旧帧依据（per-frame fw/fh）
 *
 *    触发方式：重连并改 screenshot_target_short_side（720→1080）。
 *    实测备注（2026-10-05, MuMu v5 + maa-node）：`adb shell wm size` 改物理分辨率
 *    **不传导**——rawSize setter 生效，但 MuMu 上框架选的截图方法按初始化尺寸交付
 *    （改后原生 `adb exec-out screencap` 已变 1920x1080，控制器仍交 1280x720）；
 *    且默认短边 720 缩放也会把尺寸归一化掉。重连改 shortSide 是等价且可控的触发，
 *    也是契约点名的"重连"场景（connect 不清 ring，旧帧与新分辨率帧共存于缓冲）。
 *
 *    尺寸形态：1280x720 与 1920x1080 缩到长边 480 后小图同为 480x270，
 *    换算系数却是 0.375 vs 0.25——若实现误用当前全局尺寸，裁剪位置必错。
 *
 *    判据（合起来排除"碰巧通过"）：
 *      a. 改前旧 seq 同 ROI 裁两次逐字节一致（编码确定性 + ring 不可变）；
 *      b. 重连改尺寸后旧 seq 同 ROI 再裁：仍成功、ctrlW 报旧尺寸、字节与改前一致；
 *      c. 旧帧空间外、新帧空间内的 ROI（x∈[W1+20, W1+120)，W2=1.5·W1）必须报
 *         "完全越界"——若用当前尺寸换算该 ROI 合法，会静默错剪。
 *
 * 用法：node scripts/accept-emulator.mjs [--target 127.0.0.1:16384]
 * 退出码：0 全过；1 有失败。
 */
import { spawnDaemon } from '../lib/client/daemon.js'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const shaOfLocal = (buf) => createHash('sha256').update(buf).digest('hex')

const arg = (name, def) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const TARGET = arg('--target', '127.0.0.1:16384')

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询 frame_get(最新) 直到 cond 为真；返回命中的帧，超时抛错 */
async function pollLatest(c, cond, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await c.call('frame_get', {})
    if (cond(last)) return last
    await sleep(400)
  }
  throw new Error('等待超时：' + what + '（最后 seq=' + (last && last.seq) + ' ctrl=' + (last && last.ctrlW + 'x' + last.ctrlH) + '）')
}

async function main() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-acc-'))
  const c = spawnDaemon({ runDir })
  let offlineCheck = null
  try {
    console.log('R1 重连改分辨率后旧帧 ROI 仍用旧帧依据（target=' + TARGET + '）')

    /* 1. 短边 720 连接，等第一波帧，记旧尺寸与旧 seq */
    const conn = await c.call('connect', { kind: 'adb', target: TARGET, shortSide: 720 })
    if (!conn.ok) throw new Error('connect 失败：' + JSON.stringify(conn))
    await c.call('stream_start', { fps: 5 })
    const first = await pollLatest(c, (f) => f.seq >= 3, '初始帧到达')
    const W1 = first.ctrlW, H1 = first.ctrlH
    check('初始帧携带控制器尺寸', W1 > 0 && H1 > 0, 'ctrl=' + W1 + 'x' + H1)
    const oldSeq = first.seq
    const full = await c.call('frame_get', { seq: oldSeq })
    check('旧帧全图返回小图尺寸', full.ok && full.w > 0 && full.h > 0 && full.ctrlW === W1)

    /* 2. 判据 a：改前同 ROI 裁两次逐字节一致 + 换算尺寸核对 */
    const roi = [0, 0, Math.floor(W1 / 2), Math.floor(H1 / 4)]
    const A = await c.call('frame_get', { seq: oldSeq, roi, out: path.join(runDir, 'a.png') })
    const A2 = await c.call('frame_get', { seq: oldSeq, roi, out: path.join(runDir, 'a2.png') })
    check('a. 改前同 ROI 两次裁剪逐字节一致', A.ok && A2.ok && fs.readFileSync(A.path).equals(fs.readFileSync(A2.path)))
    const expW = Math.max(1, Math.round(roi[2] * full.w / W1))
    const expH = Math.max(1, Math.round(roi[3] * full.h / H1))
    check('a2. 裁剪尺寸 = ROI × 小图/控制器换算', A.w === expW && A.h === expH, `期望 ${expW}x${expH}，实际 ${A.w}x${A.h}`)

    /* 3. 重连改短边（720→1080：1280x720 → 1920x1080），等新尺寸帧 */
    const conn2 = await c.call('connect', { kind: 'adb', target: TARGET, shortSide: 1080 })
    if (!conn2.ok) throw new Error('重连失败：' + JSON.stringify(conn2))
    const W2 = Math.round(W1 * 1.5), H2 = Math.round(H1 * 1.5)
    const fresh = await pollLatest(c, (f) => f.ctrlW === W2 && f.ctrlH === H2 && f.seq > oldSeq, '新分辨率帧到达')
    check('新帧跟随新分辨率', fresh.ctrlW === W2, `seq=${fresh.seq} ctrl=${fresh.ctrlW}x${fresh.ctrlH}`)

    /* 4. 判据 b：旧 seq 同 ROI 再裁——成功、报旧尺寸、字节一致 */
    const B = await c.call('frame_get', { seq: oldSeq, roi, out: path.join(runDir, 'b.png') })
    check('b. 重连后旧帧裁剪仍成功', B.ok, B.error || '')
    check('b2. 旧帧 ctrlW 仍报捕获时尺寸', B.ctrlW === W1 && B.ctrlH === H1, `期望 ${W1}x${H1}，实际 ${B.ctrlW}x${B.ctrlH}`)
    check('b3. 旧帧裁剪字节与改前一致', B.ok && fs.readFileSync(B.path).equals(fs.readFileSync(A.path)))

    /* 5. 判据 c：旧帧空间外、新帧空间内的 ROI 必须明确失败 */
    const Bad = await c.call('frame_get', { seq: oldSeq, roi: [W1 + 20, 0, 100, 100] })
    check('c. 跨空间 ROI 报越界（非静默错剪）', Bad.ok === false && /越界/.test(Bad.error || ''), JSON.stringify(Bad))

    /* 6. 新 seq 全图报新尺寸 */
    const freshFull = await c.call('frame_get', { seq: fresh.seq })
    check('新帧全图 ctrlW 报新尺寸', freshFull.ok && freshFull.ctrlW === W2)

    console.log('R2 关键帧库升格路径（幂等 / 冲突 / 磁盘失败 / 淘汰拒绝 / 重启离线解析）')
    const framesDir = path.join(runDir, 'frames')
    const manifestFile = path.join(framesDir, 'manifest.json')

    /* R2a 升格 + 幂等重试 */
    const f1 = await c.call('frame_get', {})
    const p1 = await c.call('kf_promote', { seq: f1.seq })
    check('R2a 升格成功发布 kf ID', p1.ok && /kf:.+:0001$/.test(p1.id || ''), JSON.stringify(p1).slice(0, 200))
    const p2 = await c.call('kf_promote', { seq: f1.seq })
    check('R2b 同捕获重试幂等返回原对象', p2.ok && p2.idempotent === true && p2.id === p1.id, JSON.stringify(p2).slice(0, 200))
    check('R2c 发布文件 sha256 与记录一致', p1.ok && shaOfLocal(fs.readFileSync(p1.path)) === p1.sha256)

    /* R2d 篡改 manifest 的 sha 后重升格 → 明确冲突，不改写旧 ID 含义 */
    const manifestBackup = fs.readFileSync(manifestFile, 'utf8')
    const tampered = JSON.parse(manifestBackup)
    tampered.frames[0].sha256 = 'e'.repeat(64)
    fs.writeFileSync(manifestFile, JSON.stringify(tampered, null, 2))
    const p3 = await c.call('kf_promote', { seq: f1.seq })
    check('R2d 同捕获内容不符 → 冲突拒绝', p3.ok === false && /冲突/.test(p3.error || ''), (p3.error || '') + '')
    fs.writeFileSync(manifestFile, manifestBackup)

    /* R2e 磁盘失败注入：manifest 只读 → rename 失败 → 报错并回收 L0 文件，不留半成品 */
    const f2 = await pollLatest(c, (f) => f.seq > f1.seq, '新帧到达')
    fs.chmodSync(manifestFile, 0o444)
    let q = null
    try {
      q = await c.call('kf_promote', { seq: f2.seq })
    } finally { fs.chmodSync(manifestFile, 0o666) }
    check('R2e manifest 写失败 → 明确报错', q.ok === false && /manifest 写入失败/.test(q.error || ''), (q.error || '') + '')
    check('R2e2 失败后 L0 文件已回收（无半成品引用）', !fs.existsSync(path.join(framesDir, 'l0', '0002.png')))
    const afterFail = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    check('R2e3 manifest 未发布新记录', afterFail.frames.length === 1)
    try { fs.rmSync(manifestFile + '.tmp', { force: true }) } catch (e) { /* rename 失败残留的 tmp，清掉 */ }

    /* R2f 故障恢复后重试成功（没有留下卡死状态） */
    const q2 = await c.call('kf_promote', { seq: f2.seq })
    check('R2f 磁盘故障恢复后重试升格成功', q2.ok && /kf:.+:0002$/.test(q2.id || ''), JSON.stringify(q2).slice(0, 200))

    /* R2g 已淘汰捕获拒绝升格（不取最新帧冒充）——收窄滚动区强制淘汰，再找确定不在两区的 seq */
    await c.call('stream_start', { fps: 5, l0Roll: 2 })
    await pollLatest(c, (f) => f.seq > f2.seq, '收窄后新帧（触发滚动区裁剪）', 15000).catch(() => console.log('  （注意：等新帧超时，淘汰断言可能基于旧状态）'))
    const l0b = await c.call('l0_status', {})
    const held = new Set([...(l0b.roll.entries || []), ...(l0b.anchor.entries || [])].map((e) => e.seq))
    const anySeq = l0b.roll.entries?.[0]?.seq ?? l0b.anchor.entries?.[0]?.seq ?? 1
    let evictedSeq = 0
    for (let s = 1; s < anySeq; s++) if (!held.has(s)) { evictedSeq = s; break }
    check('R2g 前置：存在确定已淘汰的 seq', evictedSeq >= 1, 'roll=' + JSON.stringify((l0b.roll.entries || []).map((e) => e.seq)) + ' anchor=' + JSON.stringify((l0b.anchor.entries || []).map((e) => e.seq)))
    if (evictedSeq >= 1) {
      const pe = await c.call('kf_promote', { seq: evictedSeq })
      check('R2g 已淘汰 seq 拒绝升格并说明', pe.ok === false && /L0 已淘汰/.test(pe.error || ''), (pe.ok + ' ' + (pe.error || '')).slice(0, 160))
    }

    offlineCheck = { framesDir, id: p1.id, sha: p1.sha256 }
  } finally {
    try { await c.call('disconnect') } catch (e) { /* ignore */ }
    c.close()
  }

  /* R3 daemon 已关：离线解析仍成立（重启 / 无 daemon 场景，契约 §4.1） */
  if (offlineCheck) {
    console.log('R3 daemon 关闭后离线解析升格帧')
    const { resolveFrame } = await import('../lib/runtime/keyframes.js')
    const r = resolveFrame(offlineCheck.framesDir, offlineCheck.id)
    check('R3a 离线 resolve → available 且 sha 相符',
      r.status === 'available' && r.record.sha256 === offlineCheck.sha &&
      shaOfLocal(fs.readFileSync(r.path)) === offlineCheck.sha,
      JSON.stringify({ status: r.status, reason: r.reason, recSha: r.record?.sha256, wantSha: offlineCheck.sha }))
  }
  console.log(`\nR1-R3：${pass} 过 / ${fail} 败`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('R1 执行异常：', e.message); process.exit(1) })
