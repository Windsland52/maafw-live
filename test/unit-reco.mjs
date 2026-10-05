/**
 * reco 阈值起点建议单测（纯函数，无设备）。
 * 口径来自 maafw-pipeline 技能第 4 步：threshold 取实测置信度减约 0.1 留余量——
 * 得分在识别详情内层 detail.detail（真机实测形状：miss 时 best=null、all 仍带候选得分）；
 * 无数值得分的类型不编造；低于 0.5 = 模板与画面不匹配，建议不适用（未命中不是调低阈值的理由）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { suggestThreshold } from '../lib/commands/reco.js'

/** 真机实测的结果形状：detail={name,algorithm,hit,box, detail:{all:[{box,score}],best,filtered}} */
const withScores = (scores, hit = true) => ({
  ok: hit,
  detail: {
    name: '@reco/node', algorithm: 'TemplateMatch', hit, box: [253, 135, 293, 22],
    detail: {
      all: scores.map((score) => ({ box: [1, 2, 3, 4], score })),
      best: hit ? { box: [1, 2, 3, 4], score: Math.max(...scores) } : null,
      filtered: [],
    },
  },
})

test('带得分的 sweep：取最高置信度 − 0.1，千分位取整', () => {
  const r = suggestThreshold([withScores([0.62]), withScores([0.8567]), withScores([0.79])])
  assert.equal(r.bestScore, 0.857)
  assert.equal(r.suggest, 0.757)
  assert.equal(r.lowMatch, false)
})

test('miss 时 best=null、得分在 all 里——仍取得到实测置信度', () => {
  const r = suggestThreshold([withScores([0.121557], false)])
  assert.equal(r.bestScore, 0.122)
  assert.equal(r.lowMatch, true, '0.12 < 0.5：模板与画面不匹配')
  assert.equal(r.suggest, null, '低置信度不给 threshold 建议')
})

test('高分命中：正常建议', () => {
  const r = suggestThreshold([withScores([0.93], true)])
  assert.deepEqual({ bestScore: r.bestScore, suggest: r.suggest, lowMatch: r.lowMatch },
    { bestScore: 0.93, suggest: 0.83, lowMatch: false })
})

test('无得分（OCR/结构不符/缺 detail）→ null，不编造', () => {
  assert.equal(suggestThreshold([{ ok: true, detail: { hit: true, detail: { text: '开始行动' } } }]), null)
  assert.equal(suggestThreshold([{ ok: false, detail: null }]), null)
  assert.equal(suggestThreshold([]), null)
  assert.equal(suggestThreshold([{ ok: true }]), null)
  assert.equal(suggestThreshold([{ ok: true, detail: { hit: true, box: [1, 2, 3, 4], detail: { best: null, all: [] } } }]), null)
})

test('建议下限不低于 0', () => {
  const r = suggestThreshold([withScores([0.55], true)])
  assert.equal(r.suggest, 0.45)
  assert.equal(suggestThreshold([withScores([0.5], true)]).suggest, 0.4)
})
