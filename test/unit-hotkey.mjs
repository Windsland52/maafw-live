/**
 * hotkey 键码映射单测。
 *
 * 这里的数值是各 OS 的公开常量（Win32 VK / Android KeyEvent / Carbon kVK / evdev），
 * 钉住几条代表值就够了：真正的风险不是"表抄错一个"，而是**整条链没接上还静默**——
 * 比如未知按键被写成 0、控制器类型没有表却按 Win32 猜。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { hotkeyTableFor, resolveHotkeyTokens, splitHotkeyCombo } from '../lib/interface/hotkey.js'

test('四张表各取一个代表值：Win32 VK / Adb KeyEvent / macOS kVK / evdev', () => {
  assert.equal(hotkeyTableFor('Win32').A, 0x41)
  assert.equal(hotkeyTableFor('Adb').A, 29)
  assert.equal(hotkeyTableFor('MacOS').A, 0x00)
  assert.equal(hotkeyTableFor('WlRoots').A, 30)
  assert.equal(hotkeyTableFor('Win32').F1, 0x70)
  assert.equal(hotkeyTableFor('Adb').ENTER, 66)
})

test('Linux 控制器：默认 evdev，声明 use_win32_vk_code 时用 Win32 VK', () => {
  assert.equal(hotkeyTableFor('Linux', false).A, 30)
  assert.equal(hotkeyTableFor('Linux', true).A, 0x41)
})

test('没有表的控制器类型 → null（调用方要告警，不能退回 Win32）', () => {
  assert.equal(hotkeyTableFor('Gamepad'), null)
  assert.equal(hotkeyTableFor(null), null)
})

test('组合键拆分：末段是主键，其余是修饰键；空白与空段容错', () => {
  assert.deepEqual(splitHotkeyCombo('Ctrl+Shift+A'), { primary: 'A', modifiers: ['Ctrl', 'Shift'] })
  assert.deepEqual(splitHotkeyCombo('E'), { primary: 'E', modifiers: [] })
  assert.deepEqual(splitHotkeyCombo(' + A + '), { primary: 'A', modifiers: [] })
  assert.deepEqual(splitHotkeyCombo(''), { primary: '', modifiers: [] })
})

test('四个占位符的取值：单键时修饰键补 0（"没按修饰键"是合法状态）', () => {
  const t = hotkeyTableFor('Win32')
  const single = resolveHotkeyTokens('热键', 'E', t)
  assert.deepEqual(single.tokens, { 热键: 0x45, '热键.primary': 0x45, '热键.modifier1': 0, '热键.modifier2': 0 })

  const combo = resolveHotkeyTokens('热键', 'Ctrl+Shift+A', t)
  assert.deepEqual(combo.tokens, { 热键: 0x41, '热键.primary': 0x41, '热键.modifier1': 0x11, '热键.modifier2': 0x10 })
})

test('未知按键是错，不是 0：主键或修饰键查不到都报错', () => {
  const t = hotkeyTableFor('Win32')
  assert.ok(resolveHotkeyTokens('热键', '不存在的键', t).error)
  assert.ok(resolveHotkeyTokens('热键', 'Ctrl+不存在的键', t).error)
  assert.ok(resolveHotkeyTokens('热键', '不存在+A', t).error)
})

test('键名归一：大小写、别名（CONTROL→CTRL、ESC→ESCAPE、WIN→META）', () => {
  const t = hotkeyTableFor('Win32')
  assert.equal(resolveHotkeyTokens('h', 'e', t).tokens.h, 0x45)
  assert.equal(resolveHotkeyTokens('h', 'Control+A', t).tokens['h.modifier1'], 0x11)
  assert.equal(resolveHotkeyTokens('h', 'Escape', t).tokens.h, 0x1b)
  assert.equal(resolveHotkeyTokens('h', 'Win+A', t).tokens['h.modifier1'], 0x5b)
})
