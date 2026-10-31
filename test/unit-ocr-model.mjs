/**
 * OCR 模型在不在资源链上（纯文件系统判据，无设备）。
 *
 * 这条判据存在的理由：OCR 模型缺失时框架**不报错**，只回空结果，与"roi 里真的没有字"同形。
 * 依据见 src/runtime/ocr-model.ts 的注释（MaaFW 5.11.2 pinned source 的 OCRResMgr）：
 * 每个 bundle 的 `model/ocr/` 是一个 root，`load_deter` 与 `load_recer` 各自扫 roots 找第一个
 * 命中的，`load_ocrer` 要两者都拿到。所以 det 与 rec 可以来自不同段，rec 与 keys 必须同段。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ocrModelStatus } from '../lib/runtime/ocr-model.js'

const FILES = ['det.onnx', 'rec.onnx', 'keys.txt']

/** 造一个资源包目录；files 里给相对路径（如 'model/ocr' 或 'model/ocr/v4'） */
function bundle(dirs) {
  const root = mkdtempSync(join(tmpdir(), 'maafw-ocr-model-'))
  for (const { dir, files } of dirs) {
    mkdirSync(join(root, dir), { recursive: true })
    for (const f of files) writeFileSync(join(root, dir, f), '')
  }
  return root
}

test('空资源包 → missing（框架不会报错，只会拿不到 ocrer）', () => {
  const root = bundle([{ dir: 'pipeline', files: ['a.json'] }])
  try {
    assert.equal(ocrModelStatus([root]), 'missing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('model/ocr 下三件套齐全 → present（缺省模型名是空串）', () => {
  const root = bundle([{ dir: 'model/ocr', files: FILES }])
  try {
    assert.equal(ocrModelStatus([root]), 'present')
    assert.equal(ocrModelStatus([root], ''), 'present')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('三件套缺一件（只缺 keys.txt）→ missing：load_recer 要求 model + keys 同时存在', () => {
  const root = bundle([{ dir: 'model/ocr', files: ['det.onnx', 'rec.onnx'] }])
  try {
    assert.equal(ocrModelStatus([root]), 'missing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('自定义模型名：文件在 model/ocr/v4 下且名字对得上才算 present', () => {
  const root = bundle([{ dir: 'model/ocr/v4', files: FILES }])
  try {
    assert.equal(ocrModelStatus([root], 'v4'), 'present')
    assert.equal(ocrModelStatus([root], 'other'), 'missing', '模型名对不上时框架也找不到')
    assert.equal(ocrModelStatus([root]), 'missing', '缺省空串只找 model/ocr 根下，不递归')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('资源链：任一整段齐全即 present（roots 是逐个找，不是后一段覆盖前一段）', () => {
  const empty = bundle([{ dir: 'pipeline', files: ['a.json'] }])
  const withModel = bundle([{ dir: 'model/ocr', files: FILES }])
  try {
    assert.equal(ocrModelStatus([empty, withModel]), 'present')
    assert.equal(ocrModelStatus([withModel, empty]), 'present')
    assert.equal(ocrModelStatus([]), 'missing', '没有链就没有模型可谈')
  } finally {
    rmSync(empty, { recursive: true, force: true })
    rmSync(withModel, { recursive: true, force: true })
  }
})

test('拆分：det 在 base、rec+keys 在 overlay → present（det 与 rec 允许来自不同段）', () => {
  const base = bundle([{ dir: 'model/ocr', files: ['det.onnx'] }])
  const overlay = bundle([{ dir: 'model/ocr', files: ['rec.onnx', 'keys.txt'] }])
  try {
    // 这是最容易被误判的一种布局：按"某一段三件套齐全"会报 missing，但框架实际能加载。
    assert.equal(ocrModelStatus([base, overlay]), 'present')
    assert.equal(ocrModelStatus([overlay, base]), 'present', 'roots 逐个找，段序不影响结论')
  } finally {
    rmSync(base, { recursive: true, force: true })
    rmSync(overlay, { recursive: true, force: true })
  }
})

test('拆分但 rec 与 keys 不同段 → missing：load_recer 要同一 root 下两项同时存在', () => {
  const detOnly = bundle([{ dir: 'model/ocr', files: ['det.onnx'] }])
  const recOnly = bundle([{ dir: 'model/ocr', files: ['rec.onnx'] }])
  const keysOnly = bundle([{ dir: 'model/ocr', files: ['keys.txt'] }])
  try {
    assert.equal(ocrModelStatus([detOnly, recOnly, keysOnly]), 'missing')
    assert.equal(ocrModelStatus([recOnly, keysOnly]), 'missing', '没有 det 时连 deter 都拿不到')
  } finally {
    rmSync(detOnly, { recursive: true, force: true })
    rmSync(recOnly, { recursive: true, force: true })
    rmSync(keysOnly, { recursive: true, force: true })
  }
})

test('自定义模型名 + 拆分：model/ocr/v4 的 det 在 base、rec+keys 在 overlay → present', () => {
  const base = bundle([{ dir: 'model/ocr/v4', files: ['det.onnx'] }])
  const overlay = bundle([{ dir: 'model/ocr/v4', files: ['rec.onnx', 'keys.txt'] }])
  try {
    assert.equal(ocrModelStatus([base, overlay], 'v4'), 'present')
    assert.equal(ocrModelStatus([base, overlay]), 'missing', '缺省空串只看 model/ocr 根下，不看 v4')
  } finally {
    rmSync(base, { recursive: true, force: true })
    rmSync(overlay, { recursive: true, force: true })
  }
})
