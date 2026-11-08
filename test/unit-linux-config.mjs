/**
 * buildLinuxConfig 纯函数单测（headless，无 --child、无 Linux 环境要求）。
 *
 * LinuxController 的 config JSON 组装规则对账 maa-support-extension
 * buildControllerRuntime 与 MXU build_linux_controller_config——两家客户端都按
 * typed fields 组 JSON，本工具此前只接受整串 JSON（用户手写蛇形键）。
 *
 * 钉住的行为：
 *   - JSON 逃逸口：target/config 给 { 开头的串原样透传；
 *   - 缺省 Wlr/Wlr（maa-support 与 MaaPiCli 同款）；
 *   - 方法名→数值枚举、用户字段优先于 interface.json linux{}；
 *   - Wlr 必填 wlr_socket_path、pipewire_source:Portal 明确拒、
 *     UInput/Libei/display_no 各自补字段。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../src/daemon/framed.mjs'

const { buildLinuxConfig } = __test

/* 假 maa 模块：枚举表只放真值（binding 导出的是十进制字符串）。 */
const m = {
  LinuxScreencapMethod: { Wlr: '1', ExtImage: '2', PipeWire: '4' },
  LinuxInputMethod: { Wlr: '1', UInput: '2', Libei: '4' },
}
const cfg = (args) => {
  const r = buildLinuxConfig(m, args)
  assert.equal(r.ok, true, r.error)
  return JSON.parse(r.json)
}
const err = (args) => {
  const r = buildLinuxConfig(m, args)
  assert.equal(r.ok, false)
  return r.error
}

test('raw JSON 逃逸口原样透传', () => {
  const j = '{"screencap_method":4,"input_method":2,"custom_key":1}'
  assert.equal(buildLinuxConfig(m, { target: j }).json, j)
  /* config 字段与 target 同权 */
  assert.equal(buildLinuxConfig(m, { config: j }).json, j)
  /* 给了 JSON 就不做声明式校验——Portal/缺字段都放行（用户全责） */
  const portal = '{"screencap_method":4,"pipewire_source":"Portal"}'
  assert.equal(buildLinuxConfig(m, { target: portal }).json, portal)
})

test('缺省 Wlr/Wlr + 必填 wlr_socket_path', () => {
  const c = cfg({ linux: { wlrSocketPath: '/run/user/1000/wlr.sock' } })
  assert.equal(c.screencap_method, 1)
  assert.equal(c.input_method, 1)
  assert.equal(c.wlr_socket_path, '/run/user/1000/wlr.sock')
  assert.equal(c.use_win32_vk_code, false)
})

test('Wlr 缺 socket 报错（如实、不猜）', () => {
  const e = err({})
  assert.match(e, /wlr_socket_path/)
  /* 声明式也能给 socket：interface.json linux{} 用户配置都行 */
  const c = cfg({ linuxDecl: { screencap: 'Wlr', input: 'Wlr' }, linux: { wlr_socket_path: 'decl.sock' } })
  assert.equal(c.wlr_socket_path, 'decl.sock')
})

test('方法名→数值；用户字段优先于 linux{}', () => {
  const c = cfg({
    linuxDecl: { screencap: 'Wlr', input: 'Wlr' },
    linux: { screencap: 'PipeWire', input: 'UInput', pwSocketFd: 12, pwNodeId: 34 },
  })
  assert.equal(c.screencap_method, 4)
  assert.equal(c.input_method, 2)
  assert.equal(c.pipewire_source, 'Gamescope')
  assert.equal(c.pw_socket_fd, 12)
  assert.equal(c.pw_node_id, 34)
})

test('pipewire_source=Portal 明确拒（portal helper 未接）', () => {
  const e = err({ linux: { screencap: 'PipeWire', pipewireSource: 'Portal' } })
  assert.match(e, /Portal/)
  const c = cfg({ linux: { screencap: 'PipeWire', input: 'Libei', eisSocketPath: '/run/eis.sock' } })
  assert.equal(c.pipewire_source, 'Gamescope')
  assert.equal(c.eis_socket_path, '/run/eis.sock')
})

test('坏方法名报错带可选项清单', () => {
  const e = err({ linux: { screencap: 'Wayland' } })
  assert.match(e, /screencap=Wayland/)
  assert.match(e, /Wlr\/ExtImage\/PipeWire/)
})

test('UInput 屏幕尺寸 + display_no + use_win32_vk_code', () => {
  const c = cfg({
    linuxDecl: { useWin32VkCode: true },
    linux: {
      screencap: 'ExtImage', input: 'UInput',
      uinputScreenWidth: 1920, uinputScreenHeight: 1080, displayNo: ':1',
    },
  })
  assert.equal(c.screencap_method, 2)
  assert.equal(c.input_method, 2)
  assert.equal(c.uinput_screen_width, 1920)
  assert.equal(c.uinput_screen_height, 1080)
  assert.equal(c.display_no, ':1')
  assert.equal(c.use_win32_vk_code, true)
})

test('数字名也接受（数值枚举直给）', () => {
  const c = cfg({ linux: { screencap: '4', input: '2', pipewireSource: 'Gamescope' } })
  assert.equal(c.screencap_method, 4)
  assert.equal(c.input_method, 2)
})
