/**
 * miss 原因与计数的判据（纯函数，无设备）。
 *
 * 口径来自提案 §2.4：按**算法**分口径，不共用一套 OCR 名字——OCR 没有阈值这回事，
 * 模板匹配也没有 expected 这回事。派生的前提是先看 hit：`threshold 建议为 null` 在 OCR
 * 命中时也成立（OCR 无数值分），不看 hit 就会把命中标成"无置信度"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeMisses } from '../lib/runtime/reco-verdict.js'

const miss = (all, filtered = []) => ({
  ok: false,
  detail: { hit: false, detail: { all, filtered } },
})
const hit = (all, filtered = []) => ({
  ok: true,
  detail: { hit: true, detail: { all, filtered } },
})

test('OCR：all 为空 = roi 内无文字', () => {
  const v = describeMisses([miss([])], 'OCR', null)
  assert.equal(v.missReason, 'roi 内无文字')
  assert.equal(v.rawCount, 0)
  assert.equal(v.perResult[0].rawCount, 0)
})

test('OCR：all 非空但未命中 = expected 无匹配（计数给出去）', () => {
  const v = describeMisses([miss([{ text: '甲' }, { text: '乙' }])], 'OCR', null)
  assert.equal(v.missReason, 'expected 无匹配')
  assert.equal(v.rawCount, 2)
  assert.equal(v.filteredCount, 0)
})

test('OCR 命中：不给原因（无数值分不代表"无置信度"）', () => {
  const v = describeMisses([hit([{ text: '解锁' }], [{ text: '解锁' }])], 'OCR', null)
  assert.equal(v.missReason, null)
  assert.deepEqual(v.missReasons, [])
  assert.equal(v.rawCount, 1)
  assert.equal(v.filteredCount, 1)
})

test('模板匹配：有分数按阈值口径——低分是"画面不匹配"，够分是"低于阈值"', () => {
  const low = describeMisses([miss([{ score: 0.31 }])], 'TemplateMatch', { bestScore: 0.31, lowMatch: true })
  assert.equal(low.missReason, '模板与画面不匹配（最高置信度 0.31）')

  const high = describeMisses([miss([{ score: 0.83 }])], 'TemplateMatch', { bestScore: 0.83, lowMatch: false })
  assert.equal(high.missReason, '低于阈值（最高置信度 0.83）')
})

test('模板匹配：一个分数都没有 = 模板/资源读不到（沿用 noConfidence 口径）', () => {
  const v = describeMisses([miss([])], 'TemplateMatch', null)
  assert.match(String(v.missReason), /未返回任何置信度/)
})

test('严格只认已命中：ok 缺省也按未命中处理，不猜成命中', () => {
  const v = describeMisses([{ detail: { hit: true, detail: { all: [] } } }], 'TemplateMatch', null)
  assert.match(String(v.missReason), /未返回任何置信度/)
})

test('表以外的算法不编原因（ColorMatch / DirectHit 之类没有这套口径）', () => {
  const v = describeMisses([miss([{ color: [1, 2, 3] }])], 'ColorMatch', { bestScore: 0.9, lowMatch: false })
  assert.equal(v.missReason, null)
  assert.deepEqual(v.missReasons, [])
})

test('多例：原因一致时给回执级原因，不一致时只给列表；计数不求和（求和会被读成"候选规模"）', () => {
  const same = describeMisses([miss([]), miss([])], 'OCR', null)
  assert.equal(same.missReason, 'roi 内无文字')
  assert.equal(same.rawCount, null, '多例不给求和计数')
  assert.equal(same.perResult.length, 2)

  const mixed = describeMisses([miss([]), miss([{ text: '甲' }])], 'OCR', null)
  assert.equal(mixed.missReason, null)
  assert.deepEqual(mixed.missReasons, ['roi 内无文字', 'expected 无匹配'])
})

test('OCR：链上没有模型时，空结果不报"roi 内无文字"', () => {
  const missing = describeMisses([miss([])], 'OCR', null, { ocrModel: 'missing' })
  assert.match(String(missing.missReason), /OCR 模型不在资源链里/)
  const present = describeMisses([miss([])], 'OCR', null, { ocrModel: 'present' })
  assert.equal(present.missReason, 'roi 内无文字')
})

test('OCR：模型缺失判断只作用于"空结果"——有候选时仍说 expected 无匹配', () => {
  const v = describeMisses([miss([{ text: '甲' }])], 'OCR', null, { ocrModel: 'missing' })
  assert.equal(v.missReason, 'expected 无匹配')
})

test('OCR 命中时不受模型判据影响', () => {
  const v = describeMisses([hit([{ text: '解锁' }])], 'OCR', null, { ocrModel: 'missing' })
  assert.equal(v.missReason, null)
})

test('识别调用报错（detail 为 null）不按算法口径解释：先说是"没跑成"', () => {
  const v = describeMisses(
    [{ ok: false, error: 'No graph was found in the protobuf.', detail: null }],
    'OCR', null, { ocrModel: 'present' },
  )
  assert.match(String(v.missReason), /识别调用报错：No graph was found in the protobuf\./)
  assert.equal(v.rawCount, null, '没有 detail 就没有候选计数')
})

test('detail 缺失且没带 error → 明说"未返回 detail"，不自造算法原因', () => {
  const v = describeMisses([{ ok: false }], 'TemplateMatch', null)
  assert.match(String(v.missReason), /识别调用报错：未返回 detail/)
})

test('命中优先于报错口径（ok:true 不写原因）', () => {
  const v = describeMisses([{ ok: true, error: 'x', detail: null }], 'OCR', null)
  assert.equal(v.missReason, null)
})

test('failed 标志：只有 detail 缺失才算"没跑成"，普通 miss 与命中都不置位', () => {
  const failed = describeMisses([{ ok: false, error: 'x', detail: null }], 'OCR', null, { ocrModel: 'present' })
  assert.equal(failed.perResult[0].failed, true)

  const plainMiss = describeMisses([miss([])], 'OCR', null, { ocrModel: 'present' })
  assert.equal(plainMiss.perResult[0].failed, false, '正常未命中不是"没跑成"')

  const hitResult = describeMisses([{ ok: true, error: 'x', detail: null }], 'OCR', null)
  assert.equal(hitResult.perResult[0].failed, false, '命中优先')
})
