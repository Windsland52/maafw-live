/**
 * 关键帧库磁盘配额单测（headless，无设备无 daemon 子进程）。
 *
 * cmdKfPromote 只依赖 S（模块态）+ 文件系统，可直接调用：
 * 契约 §4.1"保留与清理"——满额拒绝新增并报告，不后台静默删除；
 * 幂等重试不消耗新字节，不受配额拦截。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __test } from '../src/daemon/framed.mjs'

const { cmdKfPromote, kfUsageBytes, S } = __test

/** 独立库环境：临时 runDir + 受控 L0 滚动区；返回还原函数 */
function setupLibrary(entries, quota) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-kfq-'))
  const saved = {
    runDir: S.runDir, kfQuota: S.kfQuota,
    roll: S.l0.roll, anchor: S.l0.anchor, ring: S.ring, session: S.session, connGen: S.connGen,
  }
  S.runDir = runDir
  S.kfQuota = quota
  S.l0.roll = entries
  S.l0.anchor = []
  S.ring = entries.map((e) => ({ seq: e.seq, w: 8, h: 6, fw: 16, fh: 12 }))
  S.session = { kind: 'adb', target: 'quota-test' }
  const restore = () => {
    S.runDir = saved.runDir; S.kfQuota = saved.kfQuota
    S.l0.roll = saved.roll; S.l0.anchor = saved.anchor
    S.ring = saved.ring; S.session = saved.session; S.connGen = saved.connGen
    fs.rmSync(runDir, { recursive: true, force: true })
  }
  return { runDir, restore }
}

const ent = (seq, bytes, fill = 1) => ({ seq, t: Date.now(), png: Buffer.alloc(bytes, fill), w: 16, h: 12 })

test('配额内升格成功，库用量按实测文件统计', async () => {
  const { runDir, restore } = setupLibrary([ent(1, 1000), ent(2, 1000, 2)], 4096)
  try {
    const p = await cmdKfPromote({ seq: 1 })
    assert.equal(p.ok, true, JSON.stringify(p))
    assert.match(p.id, /kf:.+:0001$/)
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'frames', 'manifest.json'), 'utf8'))
    assert.equal(manifest.frames.length, 1)
    assert.equal(kfUsageBytes(manifest), 1000, '实测 L0 文件字节数')
  } finally { restore() }
})

test('满额拒绝新增并报告：不写文件、不发布记录', async () => {
  const { runDir, restore } = setupLibrary([ent(1, 1000), ent(2, 2000, 2)], 2500) // 已用 1000 + 新 2000 > 2500
  try {
    const p1 = await cmdKfPromote({ seq: 1 }) // 占用 1000
    assert.equal(p1.ok, true)
    const p2 = await cmdKfPromote({ seq: 2 }) // 1000 + 2000 > 2500 → 拒绝
    assert.equal(p2.ok, false)
    assert.match(p2.error, /配额不足/)
    assert.match(p2.error, /清理|扩容/, '报告里要给出处理途径')
    assert.ok(!fs.existsSync(path.join(runDir, 'frames', 'l0', '0002.png')), '不得留下半写文件')
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'frames', 'manifest.json'), 'utf8'))
    assert.equal(manifest.frames.length, 1, 'manifest 不发布新记录')
    assert.equal(manifest.next, 2, '序号不消耗')
  } finally { restore() }
})

test('幂等重试不消耗新字节：满额仍返回原对象', async () => {
  const { restore } = setupLibrary([ent(1, 1000)], 1000) // 配额恰等于已用
  try {
    const p1 = await cmdKfPromote({ seq: 1 })
    assert.equal(p1.ok, true)
    const p2 = await cmdKfPromote({ seq: 1 }) // 同捕获重试：无新增字节
    assert.equal(p2.ok, true)
    assert.equal(p2.idempotent, true)
    assert.equal(p2.id, p1.id)
  } finally { restore() }
})

test('配额 0 = 不设限', async () => {
  const { restore } = setupLibrary([ent(1, 1000), ent(2, 5000, 2)], 0)
  try {
    assert.equal((await cmdKfPromote({ seq: 1 })).ok, true)
    assert.equal((await cmdKfPromote({ seq: 2 })).ok, true)
  } finally { restore() }
})

test('kfUsageBytes 丢失文件计 0（磁盘占用只算真实存在的）', () => {
  const { runDir, restore } = setupLibrary([], 0)
  try {
    fs.mkdirSync(path.join(runDir, 'frames', 'l0'), { recursive: true })
    fs.writeFileSync(path.join(runDir, 'frames', 'l0', '0001.png'), Buffer.alloc(300))
    const m = { frames: [{ file: 'l0/0001.png' }, { file: 'l0/0002.png' }] } // 0002 不存在
    assert.equal(kfUsageBytes(m), 300)
  } finally { restore() }
})
