/**
 * `--option` 的 argv 切分单测。
 *
 * 这里只钉"写法解析"：切分错了后面的类型判定与模板替换都会拿着错的键/值跑，
 * 而 run 是无人值守消费面——参数静默变形比报错贵得多。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseOptionArgs } from '../lib/option-args.js'

test('无参数：两张表都空，无错误', () => {
  const r = parseOptionArgs(undefined)
  assert.deepEqual(r.cases, {})
  assert.deepEqual(r.fields, {})
  assert.equal(r.error, undefined)
})

test('<键>=<值>：单值走 cases；同键多次给后者覆盖', () => {
  assert.deepEqual(parseOptionArgs(['taskOpt=b']).cases, { taskOpt: 'b' })
  assert.deepEqual(parseOptionArgs(['sw=on', 'sw=off']).cases, { sw: 'off' })
})

test('checkbox：逗号分隔成数组，逐项去空白；空段丢弃', () => {
  assert.deepEqual(parseOptionArgs(['names=自动战斗, 自动拾取']).cases, { names: ['自动战斗', '自动拾取'] })
  assert.deepEqual(parseOptionArgs(['names=a,,b,']).cases, { names: ['a', 'b'] })
})

test('<键>.<字段>=<值>：走 fields，同键多字段累积', () => {
  const r = parseOptionArgs(['章节数.章节号=4', '章节数.超时=30'])
  assert.deepEqual(r.fields, { 章节数: { 章节号: '4', 超时: '30' } })
  assert.deepEqual(r.cases, {}, '带点的不进 cases')
})

test('值里可以有 = 与逗号之外的一切（只按第一个 = 切）', () => {
  assert.deepEqual(parseOptionArgs(['x=a=b']).cases, { x: 'a=b' })
})

test('非法写法：没有键、或者字段名为空 → 给错误而不是猜', () => {
  assert.ok(parseOptionArgs(['noequals']).error)
  assert.ok(parseOptionArgs(['=v']).error)
  assert.ok(parseOptionArgs(['k.']).error, '字段名不能为空')
  assert.ok(parseOptionArgs(['k.=']).error, '字段名不能为空')
})
