/**
 * OCR 模型在不在资源链上（纯文件系统判据，无设备）。
 *
 * 这条判据存在的理由：OCR 模型缺失时框架**不报错**，只回空结果，与"roi 里真的没有字"同形。
 * 依据见 src/runtime/ocr-model.ts 的注释（MaaFW 5.11.2 pinned source 的 OCRResMgr：
 * `model/ocr/<model>/` 下 det.onnx + rec.onnx + keys.txt 三件套齐全才算能加载）。
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

test('资源链：只在某一段里有也算 present（后加载的段覆盖前一段）', () => {
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
