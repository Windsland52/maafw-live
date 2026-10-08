/**
 * `parseJsonc` 单测（interface.json 的读入路径，此前零直接覆盖）。
 *
 * 它是**手写的两遍脱敏**（去注释 → 去尾随逗号），不是完整的 JSONC 解析器，所以边界全在这里钉住：
 * 字符串里的 `//`、注释里的引号、转义引号、注释与尾随逗号的**顺序**、BOM、以及"到底能容错到什么程度"。
 * 真实项目的 interface.json 是官方 meojson 解析的，注释是常规写法——所以这些用例都取自真实形态。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseJsonc } from '../lib/interface/jsonc.js'

test('parseJsonc：纯 JSON 原样通过', () => {
  assert.deepEqual(parseJsonc('{"a":1,"b":[1,2],"c":{"d":"e"}}'), { a: 1, b: [1, 2], c: { d: 'e' } })
})

test('parseJsonc：行注释（含注释里的引号、以及文件末尾没有换行的那种）', () => {
  assert.deepEqual(parseJsonc('{\n  "a": 1 // 这条注释里有 \' 和 " 引号\n}\n'), { a: 1 })
  /* 末尾无换行：注释吃到 EOF 也要能收 */
  assert.deepEqual(parseJsonc('{"a":1} // 结尾注释没有换行'), { a: 1 })
})

test('parseJsonc：块注释（多行、内含 // 与引号）', () => {
  const s = '{\n  /* 多行\n     注释里有 // 和 " 引号 */\n  "a": 1\n}'
  assert.deepEqual(parseJsonc(s), { a: 1 })
})

test('parseJsonc：字符串里的 // 与 /* 不能被当成注释', () => {
  assert.deepEqual(parseJsonc('{"url":"https://example.com/a//b","p":"C:\\\\x/*y"}'),
    { url: 'https://example.com/a//b', p: 'C:\\x/*y' })
})

test('parseJsonc：转义引号不会让字符串提前结束（后面的 // 仍在串内）', () => {
  assert.deepEqual(parseJsonc('{"s":"他说 \\"看这里// 不是注释\\" 完毕","n":1}'),
    { s: '他说 "看这里// 不是注释" 完毕', n: 1 })
})

test('parseJsonc：尾随逗号（对象/数组、带空白与注释夹在中间）', () => {
  assert.deepEqual(parseJsonc('{"a":[1,2,],"b":{"c":3,},}'), { a: [1, 2], b: { c: 3 } })
  /* 顺序必须是"先去注释再去逗号"：不然 `, // 注释\n}` 里的逗号后面跟着的不是 } 而是注释 */
  assert.deepEqual(parseJsonc('{\n  "a": 1, // 末尾那个逗号\n}\n'), { a: 1 })
  assert.deepEqual(parseJsonc('{\n  "a": [1, /* 中间 */ 2, /* 尾 */],\n}'), { a: [1, 2] })
})

test('parseJsonc：CRLF 与制表符', () => {
  assert.deepEqual(parseJsonc('{\r\n\t"a":\t1, // 注释\r\n}\r\n'), { a: 1 })
})

test('parseJsonc：开头 BOM 剥掉（Windows 记事本写的文件）', () => {
  assert.deepEqual(parseJsonc('\uFEFF{"a":1}'), { a: 1 })
})

test('parseJsonc：超出容错范围的仍然如实抛（不做更多扩展）', () => {
  assert.throws(() => parseJsonc('{a:1}'), '无引号键不猜')
  assert.throws(() => parseJsonc("{'a':1}"), '单引号不猜')
  assert.throws(() => parseJsonc('{"a":1'))
})
