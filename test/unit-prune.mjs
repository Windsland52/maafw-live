/**
 * pruneDir：按 mtime 留最新 keep 个、只删 suffix 匹配、目录不存在/失败不抛。
 * 落盘保留上限的唯一实现（runs/、png/ 走它；daemon out/ 是同逻辑内联副本）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pruneDir } from '../lib/runtime/prune.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-prune-'))

test('pruneDir：留最新 keep 个，删其余（按 mtime 降序）', () => {
  const dir = tmp()
  try {
    /* 5 个 .json，mtime 0..4 递升 → 留 4,5（mtime 3,4），删 1,2,3 */
    for (let i = 0; i < 5; i++) {
      const p = path.join(dir, `f${i}.json`)
      fs.writeFileSync(p, 'x')
      fs.utimesSync(p, new Date(1000 + i * 1000), new Date(1000 + i * 1000))
    }
    pruneDir(dir, { keep: 2, suffix: '.json' })
    const left = fs.readdirSync(dir).sort()
    assert.deepEqual(left, ['f3.json', 'f4.json'], '留 mtime 最大的 2 个')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('pruneDir：只删 suffix 匹配的——别的扩展名与目录原样留', () => {
  const dir = tmp()
  try {
    for (let i = 0; i < 4; i++) {
      const p = path.join(dir, `f${i}.png`)
      fs.writeFileSync(p, 'x')
      fs.utimesSync(p, new Date(1000 + i * 1000), new Date(1000 + i * 1000))
    }
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x')
    fs.mkdirSync(path.join(dir, 'sub'))
    pruneDir(dir, { keep: 1, suffix: '.png' })
    const left = fs.readdirSync(dir).sort()
    assert.deepEqual(left, ['f3.png', 'keep.txt', 'sub'], '.png 只留 1 个；.txt 与子目录不动')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('pruneDir：目录不存在/空 keep 不抛；keep 全盖时不删', () => {
  assert.doesNotThrow(() => pruneDir(path.join(os.tmpdir(), 'maafw-prune-nonexistent-xyz'), { keep: 5 }))
  const dir = tmp()
  try {
    fs.writeFileSync(path.join(dir, 'a.json'), 'x')
    pruneDir(dir, { keep: 10, suffix: '.json' })
    assert.deepEqual(fs.readdirSync(dir), ['a.json'], 'keep 多于文件数不动')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
