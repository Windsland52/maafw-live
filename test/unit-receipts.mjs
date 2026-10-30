#!/usr/bin/env node
/**
 * 回执落盘的两条硬约束：文件名到毫秒、撞名不覆盖。
 *
 * 背景：`slice(0, 17)` 把 ISO 时间戳的毫秒截成两位（10ms 一个桶），而 `writeFileSync` 缺省是覆盖写——
 * 同一 entry 在同一个 10ms 桶里写两次，后一次会把前一份回执静默踩掉。回执是"当时只能观测一次"
 * 的证据，静默覆盖等于丢证据，正是这个功能要防的那类事故。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { receiptFileName, writeRunReceipt } from '../lib/runtime/receipts.js'

/** 把 MAAFW_LIVE_RUNS_DIR 指进临时目录跑一段：真实 home 一份桩回执都不许留 */
function withRuns(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-receipt-'))
  const prev = process.env.MAAFW_LIVE_RUNS_DIR
  process.env.MAAFW_LIVE_RUNS_DIR = dir
  try {
    return fn(dir)
  } finally {
    if (prev === undefined) delete process.env.MAAFW_LIVE_RUNS_DIR
    else process.env.MAAFW_LIVE_RUNS_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

test('文件名保留完整毫秒（19 位：YYYYMMDDTHHmmssSSSZ）', () => {
  const name = receiptFileName('X', new Date('2026-10-30T19:49:53.123Z'))
  assert.equal(name, 'run-20261030T194953123Z-X.json')
})

test('毫秒有效：123 与 124 是两个名字（旧实现同桶）', () => {
  const a = receiptFileName('X', new Date('2026-10-30T19:49:53.123Z'))
  const b = receiptFileName('X', new Date('2026-10-30T19:49:53.124Z'))
  assert.notEqual(a, b)
})

test('entry 里的路径分隔符与空白不落到文件名里', () => {
  const name = receiptFileName('a/b c:d*e?f"g<h>i|j\\k', new Date('2026-10-30T19:49:53.123Z'))
  assert.doesNotMatch(name, /[/\\:*?"<>|\s]/)
  assert.equal(name, 'run-20261030T194953123Z-a_b_c_d_e_f_g_h_i_j_k.json')
})

test('同一毫秒同一 entry 写两次：不覆盖，各自留档', () => withRuns((dir) => {
  const now = new Date('2026-10-30T19:49:53.123Z')
  const a = writeRunReceipt({ seq: 1 }, 'X', now)
  const b = writeRunReceipt({ seq: 2 }, 'X', now)
  assert.ok(a.path !== undefined, '第一份要落盘')
  assert.ok(b.path !== undefined, '第二份也要落盘（不能返回空）')
  assert.notEqual(a.path, b.path, '撞名要换序号，不能覆盖')
  const files = readdirSync(dir).sort()
  assert.equal(files.length, 2, '两份都在：' + JSON.stringify(files))
  assert.deepEqual(JSON.parse(readFileSync(a.path, 'utf8')), { seq: 1 }, '第一份没被踩掉')
  assert.deepEqual(JSON.parse(readFileSync(b.path, 'utf8')), { seq: 2 })
}))

test('落盘失败（目录建不出来）→ 返回空对象、不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maafw-receipt-bad-'))
  const prev = process.env.MAAFW_LIVE_RUNS_DIR
  writeFileSync(join(dir, 'blocked'), 'not a dir')
  process.env.MAAFW_LIVE_RUNS_DIR = join(dir, 'blocked', 'runs')
  try {
    assert.deepEqual(writeRunReceipt({ seq: 1 }, 'X'), {})
  } finally {
    if (prev === undefined) delete process.env.MAAFW_LIVE_RUNS_DIR
    else process.env.MAAFW_LIVE_RUNS_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
})
