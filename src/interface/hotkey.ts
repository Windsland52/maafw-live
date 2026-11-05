/**
 * hotkey 占位符 → 当前控制器的虚拟按键码（PI v2.8.0+）。
 *
 * 协议只给规则、不给表：`{名称}` / `{名称}.primary` / `{名称}.modifier1` / `{名称}.modifier2`
 * 要替换成"**当前控制器 type** 支持的虚拟按键码"，且"映射规则应与 ClickKey、KeyDown 等动作所用
 * 键码表一致"（MaaFW 5.14.2 `3.3-ProjectInterfaceV2协议`，pinned commit 8061d5bc）。
 *
 * 这里四张表的数值是各 OS **公开的键码常量**，不是谁发明的东西：
 * - `Win32`  → Windows Virtual-Key Codes（`VK_*`，见 winuser.h）
 * - `Adb`    → Android `KeyEvent`（`KEYCODE_*`）
 * - `MacOS`  → Carbon `Events.h`（`kVK_*`，ANSI 键盘物理位置）
 * - `WlRoots`/`Linux` → Linux `input-event-codes.h`（`KEY_*`/evdev）
 *
 * 取值与 MXU 的实现交叉核对过（MXU 是 AGPL-3.0，本仓 MIT：**只核数值，不搬代码**）。
 * 键名按 MXU 的持久化约定规范化（大写、`+` 连接、末段为主键），因为它就是协议里"人类可读
 * 快捷键字符串"的实际来源之一。
 */

/** 一张表：规范化键名 → 虚拟按键码 */
export type HotkeyTable = Record<string, number>

const WIN32: HotkeyTable = {
  BACKSPACE: 0x08, TAB: 0x09, ENTER: 0x0d, SHIFT: 0x10, CTRL: 0x11, ALT: 0x12,
  META: 0x5b, COMMAND: 0x5b, CMD: 0x5b, PAUSE: 0x13, CAPSLOCK: 0x14, ESC: 0x1b, SPACE: 0x20,
  PAGEUP: 0x21, PAGEDOWN: 0x22, END: 0x23, HOME: 0x24,
  LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28, INSERT: 0x2d, DELETE: 0x2e,
  '0': 0x30, '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34,
  '5': 0x35, '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39,
  A: 0x41, B: 0x42, C: 0x43, D: 0x44, E: 0x45, F: 0x46, G: 0x47, H: 0x48, I: 0x49,
  J: 0x4a, K: 0x4b, L: 0x4c, M: 0x4d, N: 0x4e, O: 0x4f, P: 0x50, Q: 0x51, R: 0x52,
  S: 0x53, T: 0x54, U: 0x55, V: 0x56, W: 0x57, X: 0x58, Y: 0x59, Z: 0x5a,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b,
}

const MACOS: HotkeyTable = {
  BACKSPACE: 0x33, TAB: 0x30, ENTER: 0x24, SHIFT: 0x38, CTRL: 0x3b, ALT: 0x3a,
  META: 0x37, COMMAND: 0x37, CMD: 0x37, CAPSLOCK: 0x39, ESC: 0x35, SPACE: 0x31,
  PAGEUP: 0x74, PAGEDOWN: 0x79, END: 0x77, HOME: 0x73,
  LEFT: 0x7b, UP: 0x7e, RIGHT: 0x7c, DOWN: 0x7d, DELETE: 0x75,
  '0': 0x1d, '1': 0x12, '2': 0x13, '3': 0x14, '4': 0x15,
  '5': 0x17, '6': 0x16, '7': 0x1a, '8': 0x1c, '9': 0x19,
  A: 0x00, B: 0x0b, C: 0x08, D: 0x02, E: 0x0e, F: 0x03, G: 0x05, H: 0x04, I: 0x22,
  J: 0x26, K: 0x28, L: 0x25, M: 0x2e, N: 0x2d, O: 0x1f, P: 0x23, Q: 0x0c, R: 0x0f,
  S: 0x01, T: 0x11, U: 0x20, V: 0x09, W: 0x0d, X: 0x07, Y: 0x10, Z: 0x06,
  F1: 0x7a, F2: 0x78, F3: 0x63, F4: 0x76, F5: 0x60, F6: 0x61,
  F7: 0x62, F8: 0x64, F9: 0x65, F10: 0x6d, F11: 0x67, F12: 0x6f,
}

const ADB: HotkeyTable = {
  BACKSPACE: 67, TAB: 61, ENTER: 66, SHIFT: 59, CTRL: 113, ALT: 57,
  META: 117, COMMAND: 117, CMD: 117, SPACE: 62, ESC: 111, DELETE: 112,
  HOME: 3, END: 123, PAGEUP: 92, PAGEDOWN: 93,
  LEFT: 21, RIGHT: 22, UP: 19, DOWN: 20,
  '0': 7, '1': 8, '2': 9, '3': 10, '4': 11, '5': 12, '6': 13, '7': 14, '8': 15, '9': 16,
  A: 29, B: 30, C: 31, D: 32, E: 33, F: 34, G: 35, H: 36, I: 37, J: 38, K: 39, L: 40,
  M: 41, N: 42, O: 43, P: 44, Q: 45, R: 46, S: 47, T: 48, U: 49, V: 50, W: 51, X: 52,
  Y: 53, Z: 54,
  F1: 131, F2: 132, F3: 133, F4: 134, F5: 135, F6: 136, F7: 137, F8: 138, F9: 139,
  F10: 140, F11: 141, F12: 142,
}

const WLROOTS: HotkeyTable = {
  BACKSPACE: 14, TAB: 15, ENTER: 28, SHIFT: 42, CTRL: 29, ALT: 56,
  META: 125, COMMAND: 125, CMD: 125, SPACE: 57, ESC: 1, DELETE: 111,
  HOME: 102, END: 107, PAGEUP: 104, PAGEDOWN: 109,
  LEFT: 105, RIGHT: 106, UP: 103, DOWN: 108,
  '0': 11, '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10,
  A: 30, B: 48, C: 46, D: 32, E: 18, F: 33, G: 34, H: 35, I: 23, J: 36, K: 37, L: 38,
  M: 50, N: 49, O: 24, P: 25, Q: 16, R: 19, S: 31, T: 20, U: 22, V: 47, W: 17, X: 45,
  Y: 21, Z: 44,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  F11: 87, F12: 88,
}

/** 同义键名归一：用户手写的组合键五花八门，认得出就认，认不出会在下面报"未知按键"。 */
const ALIASES: Record<string, string> = {
  CONTROL: 'CTRL', ESCAPE: 'ESC', RETURN: 'ENTER', DEL: 'DELETE', INS: 'INSERT',
  PGUP: 'PAGEUP', PGDN: 'PAGEDOWN', WIN: 'META', WINDOWS: 'META', SUPER: 'META',
  SPACEBAR: 'SPACE', CAPS: 'CAPSLOCK', OPTION: 'ALT',
}

/** 按控制器 **type** 取表（不是 name）。没有表的类型返回 null——调用方要告警，不能退回 Win32 猜。 */
export function hotkeyTableFor(controllerType: string | null, useWin32VkCode = false): HotkeyTable | null {
  switch (controllerType) {
    case 'Win32':
      return WIN32
    case 'Adb':
      return ADB
    case 'MacOS':
      return MACOS
    case 'WlRoots':
      return WLROOTS
    /* Linux 控制器可声明 `linux.use_win32_vk_code`：true 时服务端按 Win32 VK 解释，false 用 evdev */
    case 'Linux':
      return useWin32VkCode ? WIN32 : WLROOTS
    default:
      return null
  }
}

function normalizeKey(name: string): string {
  const up = name.trim().toUpperCase()
  return ALIASES[up] ?? up
}

/** "Ctrl+Shift+A" → { primary: "A", modifiers: ["Ctrl","Shift"] }；末段为主键。 */
export function splitHotkeyCombo(value: string): { primary: string; modifiers: string[] } {
  const parts = value.split('+').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) return { primary: '', modifiers: [] }
  return { primary: parts[parts.length - 1], modifiers: parts.slice(0, -1) }
}

/**
 * 把一个 hotkey 字段解析成四种占位符的取值。
 *
 * 缺修饰键不是错（单键 "E" 本来就没有修饰键），补 0 = 无按键；**主键查不到是错**——
 * 写个 0 进去等于"按了空键"，任务会静默点不动。
 */
export function resolveHotkeyTokens(
  fieldName: string,
  raw: string,
  table: HotkeyTable,
): { tokens: Record<string, number>; error?: string } {
  const { primary, modifiers } = splitHotkeyCombo(raw)
  if (!primary) return { tokens: {}, error: '取值为空' }
  const code = table[normalizeKey(primary)]
  if (code === undefined) {
    return { tokens: {}, error: '主键 ' + primary + ' 不在该控制器的键码表里（' + raw + '）' }
  }
  const mod = (name: string | undefined): number => {
    if (!name) return 0
    const c = table[normalizeKey(name)]
    /* 修饰键查不到也按"无"处理会让组合键变成单键——那是静默错，直接报错 */
    if (c === undefined) throw new Error('修饰键 ' + name + ' 不在该控制器的键码表里（' + raw + '）')
    return c
  }
  try {
    const m1 = mod(modifiers[0])
    const m2 = mod(modifiers[1])
    return {
      tokens: {
        [fieldName]: code,
        [fieldName + '.primary']: code,
        [fieldName + '.modifier1']: m1,
        [fieldName + '.modifier2']: m2,
      },
    }
  } catch (e) {
    return { tokens: {}, error: String((e as Error).message || e) }
  }
}
