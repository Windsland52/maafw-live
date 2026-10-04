/**
 * FrameDaemon —— 设备 daemon，独立子进程运行（maa-node 的 .wait() 可能同步阻塞，
 * 绝不允许进入宿主进程）。
 *
 * 职责（分层消费模型的生产端）：
 *  - 持有 maa-node 的 Controller / Resource / Tasker（连接能力全部来自 maafw 本体）
 *  - 抓帧循环 → 降采样 → 块亮度哈希 → 变化/稳定事件（合并）→ 环形缓冲
 *  - 像素默认不出 daemon：仅发元数据；面板实时预览走落盘的预览帧；精查走 ROI 裁剪
 *  - Tasker 运行：节点事件流按帧序对齐，内置超时 + post_stop（防 JumpBack 死循环）
 *  - 识别单测：在环形缓冲历史帧上跑 post_recognition（支持阈值扫描）
 *
 * 协议（--child 模式：stdin/stdout JSON 行协议，一行一条消息）：
 *   host → daemon: { id, cmd, ...args }
 *   daemon → host: { kind:'reply', id, ok, data|error }   （请求应答）
 *                  { kind:'frame', meta, preview }         （每接受帧的元数据与预览帧路径）
 *                  { kind:'event', ev }                    （变化/稳定/节点事件）
 *                  { kind:'stream_error', error }
 */
import { createRequire } from 'node:module'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import readline from 'node:readline'
import zlib from 'node:zlib'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
/* 子进程模式（host 经 spawn 启动带 --child）：stdin/stdout 走 JSON 行协议；
 * 无 --child 时（headless 单测 import）模块无副作用。原生崩溃只杀子进程，不陪葬 host。 */
const CHILD = process.argv.includes('--child')
const send = (m) => {
  if (CHILD) process.stdout.write(JSON.stringify(m) + '\n')
}

let maa = null
function loadMaa() {
  if (!maa) maa = require('@maaxyz/maa-node')
  return maa
}

/* ────────────────────────── 最小 PNG 解码（8bit RGB/RGBA，非隔行） ────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}
function pngDecode(buf) {
  if (buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error('not a png')
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]
      if (data[12] !== 0) throw new Error('interlaced png unsupported')
    } else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error('unsupported png: depth=' + bitDepth + ' color=' + colorType)
  }
  const ch = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(w * h * ch)
  let pos = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride); pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= ch ? prev[x - ch] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      cur[x] = v & 255
    }
  }
  return { w, h, ch, data: out }
}
/** 归一化为 RGB（丢弃 alpha），返回新 Buffer */
function toRgb(dec) {
  if (dec.ch === 3) return dec.data
  const out = Buffer.alloc(dec.w * dec.h * 3)
  for (let i = 0, o = 0; i < dec.data.length; i += 4, o += 3) {
    out[o] = dec.data[i]; out[o + 1] = dec.data[i + 1]; out[o + 2] = dec.data[i + 2]
  }
  return out
}
function pngEncodeRGB(rgb, w, h) {
  const stride = w * 3
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/* ────────────────────────── 图像降采样 / 感知哈希 ────────────────────────── */
function downscale(rgb, sw, sh, maxSide) {
  const sc = Math.min(1, maxSide / Math.max(sw, sh))
  const w = Math.max(8, Math.round(sw * sc))
  const h = Math.max(8, Math.round(sh * sc))
  if (w === sw && h === sh) return { w, h, data: rgb }
  const out = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * sh / h)
    const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * sh / h))
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * sw / w)
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * sw / w))
      let r = 0, g = 0, b = 0
      const n = (sx1 - sx0) * (sy1 - sy0)
      for (let sy = sy0; sy < sy1; sy++) {
        let i = (sy * sw + sx0) * 3
        for (let sx = sx0; sx < sx1; sx++, i += 3) { r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2] }
      }
      const o = (y * w + x) * 3
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n
    }
  }
  return { w, h, data: out }
}
/** 8×8 分块亮度哈希（相对整体均值）+ 分块亮度均值（局部变化检测用） */
function blockAnalyze(rgb, w, h) {
  const cells = new Float64Array(64)
  const cnt = new Float64Array(64)
  let total = 0, n = 0
  for (let y = 0; y < h; y++) {
    const cy = Math.min(7, (y * 8 / h) | 0) * 8
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const l = (rgb[i] * 3 + rgb[i + 1] * 6 + rgb[i + 2]) * 0.1
      const ci = cy + Math.min(7, (x * 8 / w) | 0)
      cells[ci] += l; cnt[ci]++; total += l; n++
    }
  }
  const mean = total / Math.max(1, n)
  const hash = new Uint8Array(64)
  const means = new Float64Array(64)
  for (let k = 0; k < 64; k++) {
    means[k] = cells[k] / Math.max(1, cnt[k])
    hash[k] = means[k] >= mean ? 1 : 0
  }
  return { hash, means }
}
/** 兼容导出：只要哈希位 */
function blockHash(rgb, w, h) {
  return blockAnalyze(rgb, w, h).hash
}
function hashDist(a, b) {
  let d = 0
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++
  return d / 64
}
const hashStr = (h) => Array.from(h, (v) => (v ? '1' : '0')).join('')

/* ────────────────────────── 状态 ────────────────────────── */
const S = {
  ctrl: null, res: null, tasker: null,
  session: null,                       // { kind, target, method }
  daemonId: randomUUID(),              // 本 daemon 实例身份（留存记录的 session.daemon）
  connGen: 0,                          // 连接代次：每次 connect 成功 +1（留存记录定位用）
  runDir: null,                        // host init 传入；关键帧库 = runDir/frames
  fullW: 0, fullH: 0,                  // 控制器分辨率（默认短边 720p，pipeline roi/模板同空间）
  previewPath: null,                   // 面板实时预览帧落盘路径（host 传 runDir 初始化）
  stream: false, streamTimer: null,
  streamFps: 8, streamScale: 480, maxFrames: 120,
  /* 变化检测双阈值：全局 blockHash 位差率（分布式变化）+ 分块亮度差（局部变化，任一块超限即变化）。
   * blockThresh 单位为亮度（0-255），默认 8 ≈ 3%；阈值需按真机噪声实测校准（roadmap 条目13）。 */
  changeGlobal: 0.06, blockThresh: 8,
  seq: 0,
  ring: [],                            // {seq,t,rgb,w,h,fw,fh,hash,diff}——fw/fh 为该帧捕获时控制器尺寸
  events: [],                          // {type:'change'|'stable', seq, t, diff, dur?}
  framesMeta: [],                      // {seq,t,hash,diff,w,h}（元数据）
  quietNow: false, stableCount: 0,
  lastPng: null,
  runActive: false,
  /* agent 桥接（PI agent 子进程 ↔ maa.Client）：绑定在某个 Resource 实例上，
   * 同资源 + 同声明集合复用，换资源 / disconnect / shutdown 时清理。 */
  agentBind: null,
  /* L0 原图有界缓存（关键帧留存契约 §1-2）：滚动区=最近 K 张原图（"刚看到就能留"）；
   * 锚区=change/stable 事件锚点、动作边界、run 起止（各自 FIFO，容量有界可配）。 */
  l0: {
    roll: [],                          // {seq,t,png,w,h}
    anchor: [],                        // {seq,t,png,w,h,source}
    rollCap: 16, anchorCap: 32,
  },
}
const STATUS = { pending: 1000, running: 2000, succeeded: 3000, failed: 4000 }

function reply(id, ok, data) {
  send({ kind: 'reply', id, ok, ...(ok ? { data } : { error: data }) })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ────────────────────────── 设备 / 连接 / 截图 ────────────────────────── */
async function cmdProbe() {
  const m = loadMaa()
  const out = { version: null, adb: null, win32: null, errors: [] }
  try { out.version = String(m.Global.version) } catch (e) { out.errors.push('version: ' + e.message) }
  try { const a = await m.AdbController.find(); out.adb = a ? a.length : 0 } catch (e) { out.errors.push('adb: ' + e.message) }
  try { const w = await m.Win32Controller.find(); out.win32 = w ? w.length : 0 } catch (e) { out.errors.push('win32: ' + e.message) }
  return out
}

async function cmdDeviceList(kind) {
  const m = loadMaa()
  const list = []
  if (kind !== 'win32') {
    try {
      const a = await m.AdbController.find()
      if (a) for (const d of a) list.push({ kind: 'adb', id: String(d[2] ?? d[0]), name: String(d[0]), adbPath: String(d[1] ?? 'adb') })
    } catch (e) { /* 无 adb 环境 */ }
  }
  if (kind !== 'adb') {
    try {
      const w = await m.Win32Controller.find()
      if (w) for (const d of w) list.push({ kind: 'win32', id: String(d[0]), cls: String(d[1]), name: String(d[2] ?? '') })
    } catch (e) { /* 无窗口 */ }
  }
  return list
}

function pickWin32(target, wins) {
  const named = wins.filter((d) => d.kind === 'win32')
  if (!named.length) return null
  if (target) {
    const t = String(target)
    /* hwnd 精确匹配优先：面板与控制器规划器传的就是 hwnd（id）。
       标题匹配放后面——窗口标题可能重复或互为子串。 */
    const exact = named.find((d) => d.id === t)
    if (exact) return exact
    const lower = t.toLowerCase()
    const hit = named.find((d) => d.name.toLowerCase().includes(lower) || d.cls.toLowerCase().includes(lower))
    /* 指定了 target 却没匹配上时**不**退化成"随便挑一个"：
       那是静默连错窗口，比连不上更难查（实测踩过）。 */
    return hit ?? null
  }
  return named.find((d) => d.name) || named[0]
}

/**
 * 枚举名 → 数值。interface.json 里 screencap/mouse/keyboard 写的是枚举名
 * （如 PrintWindow / SendMessageWithCursorPos），maa-node 要的是数值；
 * 名字大小写不敏感（与本体 string_to_enum 的 iequals 一致）。
 * 认不出的名字不硬塞给原生层，退回默认并把警告带回上层。
 */
function resolveEnum(table, value, fallback, label, warns) {
  if (value === undefined || value === null || value === '') return String(fallback)
  const s = String(value)
  if (/^\d+$/.test(s)) return s
  if (table && typeof table === 'object') {
    const key = Object.keys(table).find((k) => k.toLowerCase() === s.toLowerCase())
    if (key !== undefined) return String(table[key])
  }
  warns.push(label + '=' + s + ' 不是当前 maa-node 绑定认识的枚举名，已退回默认值 ' + fallback)
  return String(fallback)
}

async function cmdConnect(args) {
  const m = loadMaa()
  if (S.ctrl) { try { S.ctrl.destroy() } catch (e) { /* ignore */ } S.ctrl = null }
  S.session = null
  let ctrl = null
  let session = null
  const warns = []
  if (args.kind === 'adb') {
    const adbs = (await m.AdbController.find()) || []
    const addr = args.target || (adbs[0] ? String(adbs[0][2] ?? adbs[0][0]) : null)
    if (!addr) return { ok: false, error: '未发现 adb 设备，且未提供 address' }
    const dev = adbs.find((d) => String(d[2] ?? d[0]) === String(addr))
      ?? (args.target ? null : adbs[0])
    /* 指定了 address 却不在已发现列表里：明确报错，不静默连到别的设备上 */
    if (!dev) return { ok: false, error: 'adb 地址 ' + addr + ' 不在已发现设备中（共 ' + adbs.length + ' 台）' }
    const [name, adbPath, address, caps, inputs, config] = dev
    ctrl = new m.AdbController(adbPath || 'adb', String(address ?? addr),
      caps && caps.length ? caps : [1, 2], inputs && inputs.length ? inputs : [1, 2], config || '{}')
    session = { kind: 'adb', target: String(address ?? addr), name: String(name) }
  } else if (args.kind === 'win32' || args.kind === 'gamepad') {
    const wins = await cmdDeviceList('win32')
    const pick = pickWin32(args.target, wins)
    if (!pick) {
      return {
        ok: false,
        error: args.target
          ? 'win32 窗口未找到：' + args.target + '（当前 ' + wins.length + ' 个窗口；hwnd 变了或窗口已关闭）'
          : '未发现 win32 窗口',
      }
    }
    /* 截图/输入方法：优先用调用方给的（项目驱动路径 = interface.json 声明 + 官方缺省）。
       缺省值照 maa-support buildControllerRuntime（controller.ts:95-102）的官方解释：
       screencap=FramePool、mouse=SendMessageWithCursorPos、keyboard=SendMessage。
       （此前用的 Foreground/SendMessage 是 daemon 自己的历史缺省，项目没声明时会偏离官方行为。） */
    const cap = resolveEnum(m.Win32ScreencapMethod, args.screencap, m.Win32ScreencapMethod?.FramePool ?? 2, 'screencap', warns)
    if (args.kind === 'gamepad') {
      /* GamepadController 构造器签名（maa-node .d.ts）：(hwnd, gamepad_type, screencap_method)。
         gamepad_type 枚举名→值照 m.GamepadType（Xbox360/DualShock4，缺省 Xbox360）。
         输入走虚拟手柄，需宿主装 ViGEm Bus Driver，否则 connect 会在原生层失败。 */
      const padType = resolveEnum(m.GamepadType, args.gamepadType, m.GamepadType?.Xbox360 ?? 0, 'gamepadType', warns)
      ctrl = new m.GamepadController(pick.id, padType, cap)
      session = { kind: 'gamepad', target: pick.id, name: pick.name || pick.cls, cls: pick.cls, method: { screencap: cap, gamepadType: padType } }
    } else {
      const mouse = resolveEnum(m.Win32InputMethod, args.mouse, m.Win32InputMethod?.SendMessageWithCursorPos ?? 32, 'mouse', warns)
      const key = resolveEnum(m.Win32InputMethod, args.keyboard, m.Win32InputMethod?.SendMessage ?? 2, 'keyboard', warns)
      ctrl = new m.Win32Controller(pick.id, cap, mouse, key)
      session = { kind: 'win32', target: pick.id, name: pick.name || pick.cls, cls: pick.cls, method: { screencap: cap, mouse, keyboard: key } }
    }
  } else if (args.kind === 'playcover' || args.kind === 'macos') {
    /* PlayCover / MacOS 控制器仅 macOS 可用（maa-node 本体在其它平台编译即排除）。
       非 macOS 宿主不给"也许能连"的尝试，直接说明。 */
    if (process.platform !== 'darwin') {
      return { ok: false, error: '控制器类型 ' + args.kind + ' 仅支持在 macOS 上使用；当前宿主是 ' + process.platform }
    }
    if (args.kind === 'playcover') {
      /* PlayCoverController(address, uuid)：address 是 PlayCover 设备侧服务地址（如 127.0.0.1:port），
         uuid 是 PlayCover 显示的设备 UUID；两个都必须显式给，猜不了。 */
      const parts = String(args.target ?? '').split('/')
      const address = parts[0] || ''
      const uuid = args.uuid ? String(args.uuid) : (parts[1] || '')
      if (!address || !uuid) {
        return { ok: false, error: 'playcover 需要 target=<address>/<uuid>（PlayCover 设置里可见，两者都必填）' }
      }
      ctrl = new m.PlayCoverController(address, uuid)
      session = { kind: 'playcover', target: address + '/' + uuid }
    } else {
      /* MacOSController(window_id, screencap_method, input_method)：窗口用 MacOSController.find() 枚举。 */
      const wins = (await m.MacOSController.find()) || []
      const pick = args.target
        ? (wins.find((d) => String(d[0]) === String(args.target)) ??
           wins.find((d) => String(d[2] ?? '').includes(String(args.target))))
        : (wins[0] ?? null)
      if (!pick) {
        return { ok: false, error: args.target ? 'macOS 窗口未找到：' + args.target : '未发现 macOS 窗口' }
      }
      const cap = resolveEnum(m.MacOSScreencapMethod, args.screencap, m.MacOSScreencapMethod?.ScreenCaptureKit ?? 2, 'screencap', warns)
      const input = resolveEnum(m.MacOSScreencapMethod, args.keyboard, m.MacOSScreencapMethod?.ScreenCaptureKit ?? 2, 'keyboard', warns)
      ctrl = new m.MacOSController(pick.id ?? pick[0], cap, input)
      session = { kind: 'macos', target: String(pick[0]), name: String(pick[2] ?? ''), method: { screencap: cap, input } }
    }
  } else if (args.kind === 'linux') {
    /* LinuxController(config JSON)：wlroots / PipeWire / uinput / Libei 会话按配置串交给本体。
       config 必须显式给（含 screencap_method / input_method 等必填字段），工具不猜会话形态。 */
    if (process.platform !== 'linux') {
      return { ok: false, error: '控制器类型 linux 仅支持在 Linux 上使用；当前宿主是 ' + process.platform }
    }
    const cfg = String(args.config ?? args.target ?? '')
    if (!cfg.trim().startsWith('{')) {
      return { ok: false, error: 'linux 控制器需要 config=<JSON>（screencap_method/input_method 必填；wlroots 要 wlr_socket_path，PipeWire 要 pw_socket_fd+pw_node_id 等）' }
    }
    ctrl = new m.LinuxController(cfg)
    session = { kind: 'linux', target: '(config)' }
  } else {
    return { ok: false, error: '未知控制器类型：' + args.kind + '（支持 win32/adb/gamepad/playcover/macos/linux）' }
  }
  /* 截图缩放目标：默认不干预 —— maafw 本体按 interface.json 的 short_side（缺省最短边 720p）缩放。
   * 只有用户显式传参才覆盖；注意这会改变 Tasker 识别图像的尺寸（模板/ROI 坐标系随之变化）。 */
  try {
    if (args.shortSide) ctrl.screenshot_target_short_side = Number(args.shortSide)
    if (args.longSide) ctrl.screenshot_target_long_side = Number(args.longSide)
    if (args.rawSize) ctrl.screenshot_use_raw_size = true
  } catch (e) { /* 绑定版本不支持 setter 时忽略 */ }
  S.ctrl = ctrl
  await ctrl.post_connection().wait()
  S.session = session
  S.connGen++
  /* 预热一次截图，取控制器分辨率（默认短边 720 的坐标系，pipeline 的 roi/模板即此空间） */
  let res = null
  try {
    const j = ctrl.post_screencap(); await j.wait()
    const buf = j.get()
    if (buf && buf.byteLength > 8) {
      const dec = pngDecode(Buffer.from(buf))
      S.fullW = dec.w; S.fullH = dec.h
      res = { w: dec.w, h: dec.h, bytes: buf.byteLength }
    }
  } catch (e) { res = { error: String(e.message) } }
  return { ok: true, session: { ...session, resolution: res, ...(warns.length ? { warns } : {}) } }
}

async function cmdDisconnect() {
  if (S.stream) await cmdStreamStop()
  await cleanupAgents()
  if (S.tasker) { try { S.tasker.destroy() } catch (e) { /* ignore */ } S.tasker = null }
  if (S.ctrl) { try { S.ctrl.destroy() } catch (e) { /* ignore */ } S.ctrl = null }
  S.session = null
  return { ok: true }
}

async function cmdScreencap(outFile) {
  if (!S.ctrl) return { ok: false, error: '未连接设备（先 maa_connect）' }
  const j = S.ctrl.post_screencap()
  await j.wait()
  const buf = j.get()
  if (!buf || buf.byteLength < 8) return { ok: false, error: '截图为空' }
  const b = Buffer.from(buf)
  const dec = pngDecode(b)
  /* 截图也是一次观测：进环、进 L0（有捕获身份，可被 kf promote --seq 指定升格） */
  pushFrame(dec, b)
  const file = outFile || path.join(process.cwd(), 'maa_screencap_' + Date.now() + '.png')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, b)
  return { ok: true, path: file, bytes: b.length, w: dec.w, h: dec.h, seq: S.seq }
}

/* ────────────────────────── 帧流（自适应节奏 + 事件合并） ────────────────────────── */
/** 变化块的联合 bbox：小图坐标 + 控制器坐标（8×8 网格，块边界按小图像素取整，外扩不收缩） */
function regionOfBlocks(blocks, w, h, fw, fh) {
  let bx0 = 8, by0 = 8, bx1 = -1, by1 = -1
  for (const k of blocks) {
    const bx = k % 8, by = (k / 8) | 0
    if (bx < bx0) bx0 = bx
    if (by < by0) by0 = by
    if (bx > bx1) bx1 = bx
    if (by > by1) by1 = by
  }
  const x0 = Math.round(bx0 * w / 8), y0 = Math.round(by0 * h / 8)
  const x1 = Math.round((bx1 + 1) * w / 8), y1 = Math.round((by1 + 1) * h / 8)
  const sx = fw > 0 ? fw / w : 1, sy = fh > 0 ? fh / h : 1
  return {
    small: [x0, y0, x1 - x0, y1 - y0],
    ctrl: [Math.round(x0 * sx), Math.round(y0 * sy), Math.round((x1 - x0) * sx), Math.round((y1 - y0) * sy)],
  }
}

/** L0 锚区入队（按 seq 去重：同一捕获可能既是滚动帧又是事件锚点，字节共用同一 Buffer）。 */
function l0AnchorAdd(entry) {
  if (S.l0.anchor.some((x) => x.seq === entry.seq)) return
  S.l0.anchor.push(entry)
  if (S.l0.anchor.length > S.l0.anchorCap) S.l0.anchor.splice(0, S.l0.anchor.length - S.l0.anchorCap)
}

/**
 * 一次捕获的统一入口：原图字节先进 L0（先存后解，不解码即落袋），观测面再解码进环。
 * png 是控制器交付的原始 PNG 字节（不解码、不重编码）；dec 是它解码后的观测数据。
 */
function pushFrame(dec, png) {
  const rgb = toRgb(dec)
  const small = downscale(rgb, dec.w, dec.h, S.streamScale)
  const { hash, means } = blockAnalyze(small.data, small.w, small.h)
  const prev = S.ring.length ? S.ring[S.ring.length - 1] : null
  const diff = prev ? hashDist(prev.hash, hash) : 0
  S.seq++
  const fr = { seq: S.seq, t: Date.now(), rgb: small.data, w: small.w, h: small.h, fw: dec.w, fh: dec.h, hash, means, diff }
  S.ring.push(fr)
  if (S.ring.length > S.maxFrames) S.ring.shift()
  S.fullW = dec.w; S.fullH = dec.h
  const l0 = { seq: fr.seq, t: fr.t, png, w: dec.w, h: dec.h }
  S.l0.roll.push(l0)
  if (S.l0.roll.length > S.l0.rollCap) S.l0.roll.splice(0, S.l0.roll.length - S.l0.rollCap)
  const meta = { seq: fr.seq, t: fr.t, hash: hashStr(hash), diff: Math.round(diff * 1000) / 1000, w: fr.w, h: fr.h }
  S.framesMeta.push(meta)
  if (S.framesMeta.length > 2000) S.framesMeta.splice(0, S.framesMeta.length - 2000)
  /* 预览帧落盘（原子替换）：面板 HTTP 直读，避免二进制走 JSON 行协议 */
  const preview = pngEncodeRGB(small.data, small.w, small.h)
  if (S.previewPath) {
    const tmp = S.previewPath + '.tmp'
    try { fs.writeFileSync(tmp, preview); fs.renameSync(tmp, S.previewPath) } catch (e) { /* 落盘失败不致命 */ }
  }
  send({ kind: 'frame', meta, preview: S.previewPath })
  /* 变化 / 稳定事件（400ms 窗口合并）；锚区只收"新事件"的首帧，合并窗口内不重复入锚。
   * 双阈值：全局位差率管分布式小变化，分块亮度差管局部小区域变化（小区域位差占比低，
   * 单看全局阈值会漏检且漏检导致降频加剧漏检）。变化事件携带变化区域 bbox（小图与控制器两套坐标）。 */
  let changed = null
  if (prev && means) {
    const blocks = []
    for (let k = 0; k < 64; k++) {
      if (Math.abs(means[k] - prev.means[k]) > S.blockThresh) blocks.push(k)
    }
    if (blocks.length) changed = { blocks, region: regionOfBlocks(blocks, fr.w, fr.h, fr.fw, fr.fh) }
  }
  const isChange = diff > S.changeGlobal || changed !== null
  if (isChange) {
    S.quietNow = false
    const last = S.events.length ? S.events[S.events.length - 1] : null
    if (last && last.type === 'change' && fr.t - last.t < 400) {
      last.t = fr.t; last.seq = fr.seq; last.diff = Math.max(last.diff, diff)
    } else {
      pushEvent({
        type: 'change', seq: fr.seq, t: fr.t, diff: Math.round(diff * 1000) / 1000,
        ...(changed ? { blocks: changed.blocks.length, region: changed.region } : {}),
      })
      l0AnchorAdd({ ...l0, source: 'change' })
    }
  } else if (prev) {
    if (!S.quietNow) {
      S.quietNow = true
      pushEvent({ type: 'stable', seq: fr.seq, t: fr.t, diff: Math.round(diff * 1000) / 1000 })
      l0AnchorAdd({ ...l0, source: 'stable' })
    }
  }
}
/**
 * 主动抓一张原图并入观测流（seq 前进、进环、进 L0，可作动作/run 边界锚点）。
 * 采集失败如实上报，绝不阻断调用方的动作——动作结果与留存失败分别报告（契约 §9）。
 */
async function captureNow(source) {
  if (!S.ctrl) return { ok: false, error: '未连接设备' }
  try {
    const j = S.ctrl.post_screencap()
    await j.wait()
    const buf = j.get()
    if (!buf || buf.byteLength < 8) return { ok: false, error: '空截图' }
    const b = Buffer.from(buf)
    const dec = pngDecode(b)
    pushFrame(dec, b)
    const ent = S.l0.roll[S.l0.roll.length - 1]
    l0AnchorAdd({ ...ent, source })
    return { ok: true, seq: ent.seq, t: ent.t, w: ent.w, h: ent.h }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) }
  }
}
/** 事件入环 + 推送 host（cap 1200） */
function pushEvent(ev) {
  S.events.push(ev)
  if (S.events.length > 1200) S.events.splice(0, S.events.length - 1200)
  send({ kind: 'event', ev })
}

async function streamTick() {
  if (!S.stream || !S.ctrl) return
  const t0 = Date.now()
  try {
    const j = S.ctrl.post_screencap()
    await j.wait()
    const buf = j.get()
    if (buf && buf.byteLength > 8) pushFrame(pngDecode(Buffer.from(buf)), Buffer.from(buf))
  } catch (e) {
    send({ kind: 'stream_error', error: String(e && e.message || e) })
  }
  if (!S.stream) return
  const elapsed = Date.now() - t0
  const recent = S.ring.slice(-3)
  const quiet = S.quietNow || (recent.length >= 2 && recent.every((r) => r.diff <= S.changeGlobal))
  const wait = quiet ? 1000 : Math.max(60, Math.round(1000 / Math.max(1, S.streamFps)))
  S.streamTimer = setTimeout(streamTick, Math.max(0, wait - elapsed))
}

async function cmdStreamStart(args) {
  if (!S.ctrl) return { ok: false, error: '未连接设备（先 maa_connect）' }
  if (args.fps) S.streamFps = Math.min(30, Math.max(1, Number(args.fps)))
  if (args.scale) S.streamScale = Math.min(1280, Math.max(160, Number(args.scale)))
  if (args.maxFrames) S.maxFrames = Math.min(600, Math.max(20, Number(args.maxFrames)))
  if (args.l0Roll) S.l0.rollCap = Math.min(64, Math.max(1, Number(args.l0Roll)))
  if (args.l0Anchor) S.l0.anchorCap = Math.min(128, Math.max(1, Number(args.l0Anchor)))
  if (args.blockThresh !== undefined) S.blockThresh = Math.min(64, Math.max(1, Number(args.blockThresh)))
  if (args.changeGlobal !== undefined) S.changeGlobal = Math.min(1, Math.max(0.005, Number(args.changeGlobal)))
  if (!S.stream) {
    S.stream = true
    S.quietNow = false
    S.streamTimer = setTimeout(streamTick, 0)
  }
  return {
    ok: true, fps: S.streamFps, scale: S.streamScale, maxFrames: S.maxFrames,
    l0Roll: S.l0.rollCap, l0Anchor: S.l0.anchorCap,
    blockThresh: S.blockThresh, changeGlobal: S.changeGlobal,
  }
}
async function cmdStreamStop() {
  S.stream = false
  if (S.streamTimer) { clearTimeout(S.streamTimer); S.streamTimer = null }
  return { ok: true }
}
function cmdStreamStatus() {
  return {
    ok: true, running: S.stream, fps: S.streamFps, scale: S.streamScale,
    maxFrames: S.maxFrames, seq: S.seq, ring: S.ring.length,
    events: S.events.length, full: S.fullW ? [S.fullW, S.fullH] : null,
    session: S.session,
  }
}

/* ────────────────────────── 历史帧取用（ROI 裁剪，像素按需出 worker） ────────────────────────── */
function cmdFrameGet(args) {
  let fr = null
  if (args.seq === undefined || args.seq === null) fr = S.ring[S.ring.length - 1]
  else fr = S.ring.find((r) => r.seq === Number(args.seq))
  if (!fr) return { ok: false, error: '帧不在缓冲中（seq=' + args.seq + '，范围 ' + (S.ring[0] ? S.ring[0].seq : 0) + '..' + S.seq + '）' }
  const outFile = args.out || path.join(process.cwd(), 'maa_frame_' + fr.seq + '.png')
  if (args.roi && Array.isArray(args.roi) && args.roi.length === 4) {
    /* ROI 为控制器分辨率坐标（默认短边 720p，与 pipeline 里写的 roi 同空间）→ 映射到降采样缓冲。
     * 换算必须用该帧捕获时的尺寸（fr.fw/fr.fh），不能用当前全局尺寸——重连/改分辨率后旧帧会被错剪。 */
    const [x, y, w, h] = args.roi.map(Number)
    const sx = fr.fw > 0 ? fr.w / fr.fw : 1
    const sy = fr.fh > 0 ? fr.h / fr.fh : 1
    const rx = Math.max(0, Math.floor(x * sx))
    const ry = Math.max(0, Math.floor(y * sy))
    const rw = Math.min(fr.w - rx, Math.max(1, Math.round(w * sx)))
    const rh = Math.min(fr.h - ry, Math.max(1, Math.round(h * sy)))
    if (rx >= fr.w || ry >= fr.h || rw <= 0 || rh <= 0) {
      return { ok: false, error: 'ROI 完全越界（' + JSON.stringify(args.roi) + ' vs 捕获时 ' + fr.fw + 'x' + fr.fh + '）' }
    }
    const crop = Buffer.alloc(rw * rh * 3)
    for (let yy = 0; yy < rh; yy++) {
      fr.rgb.copy(crop, yy * rw * 3, ((ry + yy) * fr.w + rx) * 3, ((ry + yy) * fr.w + rx + rw) * 3)
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, pngEncodeRGB(crop, rw, rh))
    return { ok: true, path: outFile, bytes: fs.statSync(outFile).size, w: rw, h: rh, seq: fr.seq, t: fr.t, diff: fr.diff, ctrlW: fr.fw, ctrlH: fr.fh }
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, pngEncodeRGB(fr.rgb, fr.w, fr.h))
  return { ok: true, path: outFile, bytes: fs.statSync(outFile).size, w: fr.w, h: fr.h, seq: fr.seq, t: fr.t, diff: fr.diff, ctrlW: fr.fw, ctrlH: fr.fh }
}

/* ────────────────────────── 资源 / 运行 / 识别 ────────────────────────── */
async function ensureResource(dir) {
  if (!S.res) {
    const m = loadMaa()
    S.res = new m.Resource()
  }
  if (dir) await S.res.post_bundle(dir).wait()
  return S.res
}
/**
 * 项目驱动的多路径资源：interface.json 的 resource.path[] + attach_resource_path
 * 按顺序叠加、后者覆盖前者（MaaPiCli Configurator 的语义），对应逐个 post_bundle。
 * 每次运行都新建 Resource——复用旧实例会把上一次运行的 bundle 残留进来
 * （比如上次加载了皮肤包这次没选，残留会让 override 关系错乱）。
 */
async function buildResource(dirs) {
  const m = loadMaa()
  const res = new m.Resource()
  for (const d of dirs) await res.post_bundle(d).wait()
  return res
}
function ensureTasker() {
  if (!S.tasker) {
    const m = loadMaa()
    S.tasker = new m.Tasker()
  }
  return S.tasker
}

/* ────────────────────────── agent 桥接（PI agent 子进程） ──────────────────────────
 * 模式照 maa-support-extension 的 setupAgent：new Client() 自动生成 identifier，
 * 把 identifier 追加为子进程最后一个参数（agent 侧 sys.argv[-1] → AgentServer.start_up），
 * bind_resource 后 connect（与子进程退出/超时竞速）。custom action/recognition 经此
 * 注册进绑定的 Resource——依赖 agent 的节点（M9A DisableNode 等）由此可用。 */
async function cleanupAgents() {
  const bind = S.agentBind
  S.agentBind = null
  if (!bind) return
  for (const c of bind.clients) {
    try { c.client.disconnect() } catch (e) { /* ignore */ }
    try { c.client.destroy() } catch (e) { /* ignore */ }
    try { c.child.kill() } catch (e) { /* ignore */ }
  }
}

async function setupAgents(res, decls, cwd) {
  const key = JSON.stringify(decls)
  if (S.agentBind && S.agentBind.res === res && S.agentBind.key === key) {
    const alive = S.agentBind.clients.every((c) => {
      try { return c.client.connected && c.client.alive } catch (e) { return false }
    })
    if (alive) return { ok: true, reused: true, clients: S.agentBind }
  }
  await cleanupAgents()
  const m = loadMaa()
  const clients = []
  for (const d of decls) {
    const client = new m.Client()
    const ident = client.identifier
    let child = null
    try {
      child = spawn(d.exec, [...d.args, ident], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      try { client.destroy() } catch (e2) { /* ignore */ }
      return { ok: false, error: 'agent 子进程启动失败：' + d.exec + '（' + String(e && e.message || e) + '）' }
    }
    let out = ''
    const feed = (b) => { out = (out + String(b)).slice(-4000) }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    try { client.timeout = 60000 } catch (e) { /* 绑定不支持时用默认 */ }
    try { client.bind_resource(res) } catch (e) {
      try { child.kill() } catch (e2) { /* ignore */ }
      try { client.destroy() } catch (e2) { /* ignore */ }
      return { ok: false, error: 'agent 绑定资源失败：' + String(e && e.message || e) }
    }
    const exited = new Promise((r) => child.on('exit', () => r('exit')))
    const ok = await Promise.race([
      client.connect().then(() => 'ok', () => 'err'),
      exited,
      sleep(60000).then(() => 'timeout'),
    ])
    /* connect() resolve 不代表可用：协议版本错配（maa-node 与 agent 侧 maa 版本不一致）时
     * 通道建立但握手被拒——必须复核 connected && alive（maa-support 同款检查）。 */
    let usable = ok === 'ok'
    if (usable) {
      try { usable = client.connected === true && client.alive === true } catch (e) { usable = false }
    }
    if (!usable) {
      const why = ok === 'exit' ? '子进程提前退出' : (ok === 'timeout' ? '连接超时（60s）' : '连接失败/握手被拒（版本错配？maa-node 与 agent 侧 maa 库需同版本）')
      try { client.disconnect() } catch (e) { /* ignore */ }
      try { client.destroy() } catch (e) { /* ignore */ }
      try { child.kill() } catch (e) { /* ignore */ }
      return { ok: false, error: 'agent ' + why + '：' + [d.exec, ...d.args].join(' ') + '；输出尾部：' + out.slice(-300) }
    }
    clients.push({ client, child, name: [d.exec, ...d.args].join(' '), out })
  }
  S.agentBind = { res, key, clients }
  let actions = null
  let recos = null
  try { actions = clients[0].client.custom_action_list } catch (e) { /* ignore */ }
  try { recos = clients[0].client.custom_recognition_list } catch (e) { /* ignore */ }
  return { ok: true, clients: S.agentBind, actions, recos }
}

const sab = new Int32Array(new SharedArrayBuffer(4))
async function cmdRun(args) {
  if (!S.ctrl) return { ok: false, error: '未连接设备（先 maa_connect）' }
  if (S.runActive) return { ok: false, error: '已有任务在运行（先 maa_run_stop）' }
  let res
  if (Array.isArray(args.resourceDirs) && args.resourceDirs.length) {
    res = await buildResource(args.resourceDirs.map(String))
    S.res = res
  } else {
    if (!args.resourceDir) return { ok: false, error: '缺少 resourceDir（或 resourceDirs 数组）' }
    res = await ensureResource(args.resourceDir)
  }
  /* agent 桥接：项目声明了 agent（PI interface 的 child_exec/child_args）就先连上——
   * custom action 注册进本次运行的 Resource；失败不阻断（非 agent 节点照跑），结果如实报告 */
  let agentInfo = null
  if (Array.isArray(args.agents) && args.agents.length) {
    const ag = await setupAgents(res, args.agents, String(args.agentCwd || process.cwd()))
    agentInfo = ag.ok
      ? { ok: true, reused: !!ag.reused, actions: ag.actions ?? null, recognitions: ag.recos ?? null }
      : { ok: false, error: ag.error }
  }
  const tasker = ensureTasker()
  tasker.resource = res
  tasker.controller = S.ctrl
  /* timeoutMs=0：不自动 post_stop，停止权交调用方（LLM 看事件流自行判断 + run_stop）。
   * >0 时沿用超时保护（防 JumpBack 死循环）。300s 硬上限已移除——长任务用 0。 */
  const rawT = Number(args.timeoutMs)
  const timeoutMs = rawT === 0 ? 0 : (Number.isFinite(rawT) && rawT > 0 ? Math.max(500, rawT) : 30000)
  const t0 = Date.now()
  const retention = { start: await captureNow('run-start') }
  const nodes = new Map()   // node_id → {name, start, end, msg, success, seq}
  const order = []
  const onMsg = (m) => {
    const t = Date.now()
    const seq = S.seq
    if (!m || !m.msg) return
    if (m.node_id !== undefined && m.node_id !== null) {
      let n = nodes.get(String(m.node_id))
      if (!n) {
        n = { id: String(m.node_id), name: m.name || ('node#' + m.node_id), start: t, end: null, status: 'running', msgs: [], seq }
        nodes.set(String(m.node_id), n)
        order.push(n)
      }
      /* 注意：不要在节点回调里抓帧（node-ok/fail 锚点）——add_sink 回调中并发 post_screencap
       * 会与 Tasker 识别回路竞争控制器，实测触发原生崩溃 0xC0000005（maa-node 5.14.2 win32-x64，
       * 2026-10-05 真机：同任务 off 正常 / on 崩溃）。节点证据走 adjacent 语义（流帧与 change 锚点）。 */
      if (/Starting$/.test(m.msg)) { n.status = 'running'; n.start = t }
      else if (/Succeeded$/.test(m.msg)) { n.status = 'ok'; n.end = t }
      else if (/Failed$/.test(m.msg)) { n.status = 'fail'; n.end = t }
      else if (n.msgs.length < 6) n.msgs.push(m.msg)
      n.seq = seq
      /* 节点级消息进事件流：maa_frame_poll / maa_timing_measure 直接消费 */
      pushEvent({ type: 'run', seq, t, diff: 0, node: n.name, msg: m.msg, id: m.node_id ?? null })
    } else {
      const ev = { type: 'run', seq, t, diff: 0, node: m.name ?? null, msg: m.msg, id: m.reco_id ?? m.action_id ?? null }
      pushEvent(ev)
      if (order.length) order[order.length - 1].msgs.push(ev.msg + (ev.id ? '#' + ev.id : ''))
    }
  }
  const s1 = tasker.add_sink((_, m) => onMsg(m))
  const s2 = tasker.add_context_sink((_, m) => onMsg(m))
  S.runActive = true
  let status = null
  let stopped = false
  try {
    const job = tasker.post_task(String(args.entry), args.override || {})
    /* 超时保护：与 wait() 竞速。wait() 内部会泵事件循环（探针实测：节点回调在 wait 期间送达），
     * 因此 setTimeout 分支可在此期间触发并执行 post_stop —— JumpBack 死循环无法挂死 worker。 */
    let finished = false
    if (timeoutMs > 0) {
      await Promise.race([
        job.wait().then(() => { finished = true }),
        sleep(timeoutMs),
      ])
      if (!finished) {
        try { tasker.post_stop() } catch (e) { /* ignore */ }
        stopped = true
        await Promise.race([job.wait().catch(() => null), sleep(1500)])
      }
    } else {
      await job.wait()
    }
    status = job.status
  } catch (e) {
    status = -1
    order.push({ id: '-', name: 'exception', start: t0, end: Date.now(), status: 'fail', msgs: [String(e && e.message || e)], seq: S.seq })
  } finally {
    try { tasker.remove_sink(s1); tasker.remove_context_sink(s2) } catch (e) { /* ignore */ }
    S.runActive = false
  }
  let dump = null
  try { dump = S.ctrl.get_node_data_parsed('node') } catch (e) { /* ignore */ }
  retention.end = await captureNow('run-end')
  const rec = {
    ok: status === STATUS.succeeded,
    entry: String(args.entry),
    status,
    stopped,
    durationMs: Date.now() - t0,
    startSeq: nodes.size ? order[0].seq : null,
    endSeq: S.seq,
    framesCaptured: S.seq,
    retention,
    ...(agentInfo ? { agent: agentInfo } : {}),
    nodes: order.map((n) => ({
      id: n.id, name: n.name, status: n.status,
      ms: (n.end ?? Date.now()) - n.start, seq: n.seq, msgs: n.msgs.slice(-6),
    })),
    dump: dump ? { taskCount: dump.tasks ? dump.tasks.length : 0, nodes: Object.keys(dump.nodes || {}).length } : null,
  }
  return { ok: true, record: rec }
}

async function cmdRunStop() {
  if (S.tasker) {
    try { S.tasker.post_stop() } catch (e) { /* ignore */ }
  }
  S.runActive = false
  return { ok: true }
}

/* 输入注入：全部经 maafw 控制器（adb/win32 由 maafw 本体选择注入方法），不直接调 adb。
 * 动作边界（前/后）各抓一张原图进 L0 锚区（契约 §1"采得到"）：
 * 采集失败不阻断动作——动作结果与留存失败分别报告（契约 §9）。 */
async function cmdInput(args) {
  if (!S.ctrl) return { ok: false, error: '未连接设备（先 maa_connect）' }
  const t0 = Date.now()
  const k = String(args.kind || 'click')
  const retention = {}
  const done = (job) => ({ ok: true, kind: k, ms: Date.now() - t0, retention })
  retention.before = await captureNow('action-before')
  let job = null
  if (k === 'click') {
    job = S.ctrl.post_click(Number(args.x), Number(args.y), Number(args.contact ?? 0), Number(args.pressure ?? 1))
  } else if (k === 'dbclick') {
    /* 双击：两次 click 间隔一拍（控制器消息模型下无原子双击原语） */
    await S.ctrl.post_click(Number(args.x), Number(args.y)).wait()
    await sleep(Math.max(20, Number(args.gap ?? 60)))
    job = S.ctrl.post_click(Number(args.x), Number(args.y))
  } else if (k === 'press') {
    /* 长按：touch_down → 保持 → touch_up（保持期不占用事件循环之外的资源） */
    const contact = Number(args.contact ?? 0)
    await S.ctrl.post_touch_down(contact, Number(args.x), Number(args.y), Number(args.pressure ?? 1)).wait()
    await sleep(Math.max(50, Number(args.duration ?? 800)))
    job = S.ctrl.post_touch_up(contact)
  } else if (k === 'swipe') {
    job = S.ctrl.post_swipe(Number(args.x1), Number(args.y1), Number(args.x2), Number(args.y2),
      Number(args.duration ?? 300), Number(args.contact ?? 0), Number(args.pressure ?? 1))
  } else if (k === 'key') {
    job = S.ctrl.post_click_key(Number(args.code))
  } else if (k === 'keys') {
    /* 组合键：全按下再全抬起（按下顺序=给定顺序，抬起反序，模拟真实手型） */
    const codes = (Array.isArray(args.codes) ? args.codes : String(args.codes ?? '').split(/[+,]/))
      .map((c) => Number(String(c).trim())).filter((c) => Number.isFinite(c) && c > 0)
    if (!codes.length) return { ok: false, error: 'keys 需要至少一个键码（数组或逗号/加号分隔）' }
    const hold = Math.max(20, Number(args.hold ?? 60))
    for (const c of codes) await S.ctrl.post_key_down(c).wait()
    await sleep(hold)
    for (const c of codes.slice().reverse()) await S.ctrl.post_key_up(c).wait()
    retention.after = await captureNow('action-after')
    return done(null)
  } else if (k === 'scroll') {
    /* 滚轮：dx/dy 为格数，建议 120 的倍数（WHEEL_DELTA） */
    job = S.ctrl.post_scroll(Number(args.dx ?? 0), Number(args.dy ?? 0))
  } else if (k === 'move') {
    /* 相对移动（Win32/MacOS；FPS 锁鼠标场景配 mouse_lock_follow） */
    job = S.ctrl.post_relative_move(Number(args.dx ?? 0), Number(args.dy ?? 0))
  } else if (k === 'text') {
    job = S.ctrl.post_input_text(String(args.text ?? ''))
  } else if (k === 'app') {
    job = String(args.action) === 'stop'
      ? S.ctrl.post_stop_app(String(args.intent ?? ''))
      : S.ctrl.post_start_app(String(args.intent ?? ''))
  } else {
    return { ok: false, error: 'unknown input kind: ' + k + '（click|dbclick|press|swipe|key|keys|scroll|move|text|app）' }
  }
  await job.wait()
  retention.after = await captureNow('action-after')
  return done(job)
}

/* 识别单测：子进程隔离执行（beta 绑定的 post_recognition 在无效模板上会原生崩溃，
 * 子进程炸掉只损失一次测试，绝不让宿主陪葬）。 */
function spawnRecoChild(payload, timeoutMs) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reco_child.mjs')
  const file = path.join(os.tmpdir(), 'maa_reco_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.json')
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8')
  const out = file + '.out'
  return new Promise((resolve) => {
    execFile(process.execPath, [script, '--cfg', file, '--out', out],
      { timeout: Math.min(120000, Math.max(10000, timeoutMs)), windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        try { fs.rmSync(file, { force: true }) } catch (e) { /* ignore */ }
        try {
          if (fs.existsSync(out)) {
            const r = JSON.parse(fs.readFileSync(out, 'utf8'))
            fs.rmSync(out, { force: true })
            resolve(r)
            return
          }
        } catch (e) { /* 结果损坏则走失败分支 */ }
        resolve({ ok: false, error: '识别子进程失败：' + ((err && (err.message || String(err.code))) || '无结果') + ' ' + String(stdout || '').slice(0, 200) })
      })
  })
}

/* 识别详情瘦身：像素类字段（draws / raw）一律不带出去（与 reco_child 同一规则）。 */
function stripDetail(d) {
  if (!d || typeof d !== 'object') return null
  const copy = { ...d }
  delete copy.draws
  delete copy.raw
  return copy
}

/**
 * 节点级单测（--act）：识别拿框 → 用框 run_action，动作半在真机 daemon 侧执行。
 * 与 reco_child 的静态路径互补：那条只测识别（图像假控制器、无输入）；这条串起两半，
 * 专测 target 框语义（框中心/偏移）与组合动作。识别输入 = 抓帧时的当前画面原图
 * （也是 action-before 边界锚点），动作执行后的画面另抓 action-after——效果可复核。
 */
async function recoActTest(args, node) {
  const res = await ensureResource(String(args.resourceDir))
  const tasker = ensureTasker()
  tasker.resource = res
  tasker.controller = S.ctrl
  const before = await captureNow('action-before')
  if (!before.ok) return { ok: false, error: '识别输入抓帧失败：' + before.error }
  const imgBuf = S.l0.roll[S.l0.roll.length - 1].png
  const image = imgBuf.buffer.slice(imgBuf.byteOffset, imgBuf.byteOffset + imgBuf.byteLength)
  let out = null
  res.register_custom_action('@reco/act', async (self) => {
    let detail = null
    try {
      detail = await self.context.run_recognition('@reco/node', image, { '@reco/node': node })
    } catch (e) {
      out = { ok: false, stage: 'recognition', error: String(e && e.message || e) }
      return true
    }
    if (!detail || !detail.box) {
      out = { ok: false, stage: 'recognition', miss: true, ...(detail ? { reco: stripDetail(detail) } : {}) }
      return true
    }
    const rec = stripDetail(detail)
    try {
      const act = await self.context.run_action('@reco/node', detail.box, JSON.stringify(rec), { '@reco/node': node })
      out = { ok: !!act, stage: 'action', reco: rec, action: stripDetail(act) }
    } catch (e) {
      out = { ok: false, stage: 'action', error: String(e && e.message || e), reco: rec }
    }
    return true
  })
  try {
    await tasker.post_task('@reco/entry', { '@reco/entry': { action: 'Custom', custom_action: '@reco/act' } }).wait()
  } catch (e) {
    return { ok: false, error: '动作探针任务失败：' + String(e && e.message || e) }
  } finally {
    try { res.unregister_custom_action('@reco/act') } catch (e) { /* ignore */ }
  }
  const after = await captureNow('action-after')
  if (!out) return { ok: false, error: '动作探针未被执行（custom action 回调未触发）' }
  const rec = node && node.recognition
  const shownType = rec && typeof rec === 'object' ? String(rec.type ?? 'DirectHit') : String(rec ?? 'DirectHit')
  return {
    ok: out.ok,
    type: shownType,
    meta: { seq: before.seq, w: before.w, h: before.h, t: before.t },
    ...(out.error !== undefined ? { error: out.error } : {}),
    ...(out.stage ? { stage: out.stage } : {}),
    ...(out.miss !== undefined ? { miss: out.miss } : {}),
    ...(out.reco ? { reco: out.reco } : {}),
    ...(out.action ? { action: out.action } : {}),
    retention: { before, after },
  }
}

async function cmdRecoTest(args) {
  /* --act：节点级单测（识别拿框 → 真机执行动作半），在 daemon 进程内跑（要真控制器） */
  const actNode = args.act === true && args.node && typeof args.node === 'object' && !Array.isArray(args.node) ? args.node : null
  if (args.act === true) {
    if (!actNode) return { ok: false, error: '--act 需要同时给 --node（整节点 JSON，含 action）' }
    if (!S.ctrl) return { ok: false, error: '--act 要在真机上执行动作：需要已连接设备（REPL 或 --project/--kind）' }
    return await recoActTest(args, actNode)
  }
  await ensureResource(args.resourceDir)   // 校验资源可加载（子进程会重新加载）
  // 图像来源：缓冲帧 seq（降采样 PNG 重编码）或文件
  let imageFile = null
  let meta = {}
  if (args.image) {
    imageFile = String(args.image)
    meta = { source: args.image }
  } else {
    const fr = args.seq !== undefined && args.seq !== null
      ? S.ring.find((r) => r.seq === Number(args.seq))
      : S.ring[S.ring.length - 1]
    if (!fr) return { ok: false, error: '缓冲无可用帧（seq=' + args.seq + '）' }
    imageFile = path.join(os.tmpdir(), 'maa_reco_img_' + Date.now() + '.png')
    fs.writeFileSync(imageFile, pngEncodeRGB(fr.rgb, fr.w, fr.h))
    meta = { seq: fr.seq, w: fr.w, h: fr.h, t: fr.t }
  }
  /* --node：整节点 JSON 原样透传给子进程（V1 扁平 / V2 嵌套由框架解析，daemon 不转换） */
  const node = args.node && typeof args.node === 'object' && !Array.isArray(args.node) ? args.node : null
  if (node && (typeof node.recognition !== 'string') &&
      !(node.recognition && typeof node.recognition === 'object' && !Array.isArray(node.recognition))) {
    return { ok: false, error: '--node 缺少可用的 recognition 字段（V1 字符串或 V2 {type,param}）' }
  }
  const baseParam = args.param && typeof args.param === 'object' ? args.param : {}
  const sweep = args.sweep && typeof args.sweep === 'object' ? args.sweep : null
  const cases = []
  if (sweep && typeof sweep.min === 'number' && typeof sweep.max === 'number') {
    /* step 带方向：升序 0.5→0.9 / 降序 0.9→0.5 都合法；区间为空明确报错，不静默测个空 */
    const step = sweep.step !== undefined && Number(sweep.step) !== 0 ? Number(sweep.step) : 1
    const up = step > 0
    if ((up && sweep.min > sweep.max) || (!up && sweep.min < sweep.max)) {
      return { ok: false, error: 'sweep 区间为空：min=' + sweep.min + ' max=' + sweep.max + ' step=' + step + '（step 带方向）' }
    }
    for (let v = sweep.min; up ? v <= sweep.max + 1e-9 : v >= sweep.max - 1e-9; v += step) {
      cases.push({ ...baseParam, [String(sweep.key || 'threshold')]: Math.round(v * 1000) / 1000 })
    }
  } else cases.push(baseParam)
  const r = await spawnRecoChild({
    resourceDir: String(args.resourceDir),
    type: String(args.type || 'TemplateMatch'),
    image: imageFile,
    /* 面板场景：模板由调用方裁好落盘传进来（子进程走 override_image），不写进任何资源目录 */
    ...(args.templateImage ? { templateImage: String(args.templateImage) } : {}),
    ...(node ? { node } : { cases }),
  }, 90000)
  if (r && r.ok) {
    const rec = node && node.recognition
    const shownType = node
      ? (rec && typeof rec === 'object' ? String(rec.type ?? 'DirectHit') : String(rec))
      : args.type
    return { ok: true, type: shownType, meta, results: r.results }
  }
  return { ok: false, error: (r && r.error) || 'reco 失败', meta }
}

/* ────────────────────────── 关键帧库（L0 升格 + 登记，契约 §4） ──────────────────────────
 * 库根：runDir/frames（host init 传入 runDir，默认 ~/.maafw-live）。
 * manifest.json = { schema, libraryId, next, frames[] }；kf ID = kf:<库UUID>:<零填充序号>。
 * 写入次序是硬约束：先固定像素（tmp+rename 落 L0 文件），再发布 manifest 记录；
 * manifest 失败即回收文件，绝不返回半成品引用。库副本 v0 按单写者管理，不自动合并。 */
const KF_SCHEMA = 1
function kfRoot() { return path.join(S.runDir || path.join(os.homedir(), '.maafw-live'), 'frames') }
function kfAbsPath(fileRel) { return path.join(kfRoot(), String(fileRel).split('/').join(path.sep)) }
function kfLoad() {
  const file = path.join(kfRoot(), 'manifest.json')
  if (!fs.existsSync(file)) return null
  let m = null
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new Error('manifest.json 损坏（非合法 JSON）') }
  if (!m || typeof m !== 'object' || !Array.isArray(m.frames)) throw new Error('manifest.json 结构不符（缺 frames 数组）')
  /* 未知 schema 明确报错，不默认为当前版（契约 §4） */
  if (Number(m.schema) !== KF_SCHEMA) throw new Error('manifest schema=' + m.schema + ' 不被当前版本支持（认识：' + KF_SCHEMA + '）')
  return m
}
function kfOpen() {
  return kfLoad() ?? { schema: KF_SCHEMA, libraryId: randomUUID(), next: 1, frames: [] }
}
function kfSave(m) {
  const file = path.join(kfRoot(), 'manifest.json')
  fs.mkdirSync(kfRoot(), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2))
  fs.renameSync(tmp, file)
}

async function cmdKfPromote(args) {
  /* 固定捕获身份：latest 在接受请求时解析成具体 seq；已淘汰则失败，绝不改取更新帧冒充 */
  let seq = null
  if (args.seq !== undefined && args.seq !== null) {
    seq = Number(args.seq)
    if (!Number.isFinite(seq)) return { ok: false, error: 'seq 必须是数字' }
  } else if (args.latest === true) {
    seq = S.seq
  } else {
    return { ok: false, error: '给 seq（数字）或 latest:true 指定要升格的捕获' }
  }
  if (seq <= 0) return { ok: false, error: '本会话尚无捕获（seq=0），无可升格' }
  const ent = S.l0.anchor.find((x) => x.seq === seq) ?? S.l0.roll.find((x) => x.seq === seq)
  if (!ent) {
    const range = (l) => (l.length ? l[0].seq + '..' + l[l.length - 1].seq : '空')
    return {
      ok: false,
      error: 'L0 已淘汰：seq=' + seq + '（滚动区 ' + range(S.l0.roll) + '，锚区 ' + range(S.l0.anchor) + '）。' +
        'L1 参考帧可用 frame_get 导出，但按契约不作 state 证据本体',
    }
  }
  let m
  try { m = kfOpen() } catch (e) { return { ok: false, error: '关键帧库不可用：' + String(e && e.message || e) } }
  const sess = S.session || {}
  const sessionRef = { daemon: S.daemonId, gen: S.connGen, kind: sess.kind ?? null, target: sess.target ?? null }
  const sha = createHash('sha256').update(ent.png).digest('hex')
  /* 幂等：同一捕获（daemon + 代次 + seq）重试返回原对象；内容不符报冲突，不任选一份 */
  const dup = m.frames.find((f) => f.session && f.session.daemon === sessionRef.daemon &&
    Number(f.session.gen) === sessionRef.gen && Number(f.captureSeq) === seq)
  if (dup) {
    if (dup.sha256 === sha) return { ok: true, idempotent: true, record: dup, path: kfAbsPath(dup.file), sha256: sha }
    return { ok: false, error: '同一捕获已有内容不同的记录（' + dup.id + '）：冲突，拒绝改写旧 ID 的含义' }
  }
  const num = Number(m.next) || m.frames.length + 1
  const id = 'kf:' + m.libraryId + ':' + String(num).padStart(4, '0')
  const fileRel = 'l0/' + String(num).padStart(4, '0') + '.png'
  const abs = kfAbsPath(fileRel)
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const tmp = abs + '.tmp'
    fs.writeFileSync(tmp, ent.png)
    fs.renameSync(tmp, abs)
  } catch (e) {
    return { ok: false, error: 'L0 文件写入失败：' + String(e && e.message || e) }
  }
  /* 小图信息只取环内同 seq 帧；已淘汰则明确为空，不借用最新帧数据（契约 §4） */
  const small = S.ring.find((r) => r.seq === seq)
  const rec = {
    id, file: fileRel, sha256: sha,
    session: sessionRef,
    capturedAt: new Date(ent.t).toISOString(),
    captureSeq: seq,
    ctrlW: ent.w, ctrlH: ent.h,
    smallW: small ? small.w : null, smallH: small ? small.h : null,
    scale: small && ent.w ? Math.round((small.w / ent.w) * 1000) / 1000 : null,
    source: ent.source || 'explicit',
    note: args.note != null ? String(args.note) : null,
  }
  m.frames.push(rec)
  m.next = num + 1
  try { kfSave(m) } catch (e) {
    try { fs.rmSync(abs, { force: true }) } catch (e2) { /* ignore */ }
    return { ok: false, error: 'manifest 写入失败（L0 文件已回收，未发布引用）：' + String(e && e.message || e) }
  }
  return { ok: true, id, path: abs, sha256: sha, retained: 'promoted', record: rec }
}

function cmdL0Status() {
  const brief = (e) => ({ seq: e.seq, t: e.t, source: e.source ?? null, w: e.w, h: e.h, bytes: e.png ? e.png.length : 0 })
  const sum = (list, cap) => ({
    count: list.length, cap,
    bytes: list.reduce((a, e) => a + (e.png ? e.png.length : 0), 0),
    seqRange: list.length ? [list[0].seq, list[list.length - 1].seq] : null,
  })
  return {
    ok: true, seq: S.seq,
    roll: { ...sum(S.l0.roll, S.l0.rollCap), entries: S.l0.roll.map(brief) },
    anchor: { ...sum(S.l0.anchor, S.l0.anchorCap), entries: S.l0.anchor.map(brief) },
    framesDir: kfRoot(),
  }
}

/* ────────────────────────── 模板裁剪（snap 收紧 + 自匹配精修） ──────────────────────────
 * 输入：宽松框（或点+外扩）；源 = L0 原图（控制器分辨率——模板尺寸必须与识别空间一致，
 * 不能从降采样小图裁）。收紧 = 与边框背景差的行列占比；精修 = 逐边 ±2px 贪心重试，
 * 以"裁出的模板在同帧上的 TemplateMatch 得分"为目标函数（自匹配验证闭环）。 */
function tightenBounds(rgb, w, h) {
  const ring = Math.max(2, Math.round(Math.min(w, h) / 12))
  let br = 0, bg = 0, bb = 0, bn = 0
  for (let y = 0; y < h; y++) {
    const edgeRow = y < ring || y >= h - ring
    for (let x = 0; x < w; x++) {
      if (!edgeRow && !(x < ring || x >= w - ring)) continue
      const i = (y * w + x) * 3
      br += rgb[i]; bg += rgb[i + 1]; bb += rgb[i + 2]; bn++
    }
  }
  br /= bn; bg /= bn; bb /= bn
  const TOL = 90   // 通道差之和超过此值视为"非背景"
  const rowHit = new Array(h).fill(0)
  const colHit = new Array(w).fill(0)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      if (Math.abs(rgb[i] - br) + Math.abs(rgb[i + 1] - bg) + Math.abs(rgb[i + 2] - bb) > TOL) {
        rowHit[y]++; colHit[x]++
      }
    }
  }
  const FRAC = 0.12
  let y0 = 0, y1 = h - 1
  while (y0 < y1 && rowHit[y0] / w < FRAC) y0++
  while (y1 > y0 && rowHit[y1] / w < FRAC) y1--
  let x0 = 0, x1 = w - 1
  while (x0 < x1 && colHit[x0] / h < FRAC) x0++
  while (x1 > x0 && colHit[x1] / h < FRAC) x1--
  if (y1 - y0 < 3 || x1 - x0 < 3) return null   // 内容撑满或无内容：交回调用方处理
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

function cropRgb(rgb, sw, sh, box) {
  const w = Math.min(box.w, sw - box.x), h = Math.min(box.h, sh - box.y)
  const out = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    rgb.copy(out, y * w * 3, ((box.y + y) * sw + box.x) * 3, ((box.y + y) * sw + box.x + w) * 3)
  }
  return { w, h, data: out }
}

async function cmdTplCrop(args) {
  /* 源帧：L0 原图（控制器分辨率），seq 或最新 */
  const ent = args.seq !== undefined && args.seq !== null
    ? (S.l0.anchor.find((x) => x.seq === Number(args.seq)) ?? S.l0.roll.find((x) => x.seq === Number(args.seq)))
    : (S.l0.anchor[S.l0.anchor.length - 1] ?? S.l0.roll[S.l0.roll.length - 1] ?? null)
  if (!ent) {
    return { ok: false, error: 'L0 无可用原图：先 screencap / stream / 输入产生观测（seq=' + args.seq + '）' }
  }
  const dec = pngDecode(ent.png)
  /* 宽松框：显式 roi，或点 + 外扩（点→ROI 派生与裁剪共享同一条 snap 链） */
  let loose = null
  if (Array.isArray(args.roi) && args.roi.length === 4) {
    loose = args.roi.map(Number)
  } else if (Array.isArray(args.point) && args.point.length === 2) {
    const pad = Math.max(8, Number(args.pad ?? 24))
    const [px, py] = args.point.map(Number)
    loose = [px - pad, py - pad, pad * 2, pad * 2]
  } else {
    return { ok: false, error: '给 --roi x,y,w,h 或 --point x,y [--pad n]' }
  }
  const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)))
  const box0 = {
    x: cl(loose[0], 0, dec.w - 8),
    y: cl(loose[1], 0, dec.h - 8),
    w: 0, h: 0,
  }
  box0.w = cl(loose[2], 8, dec.w - box0.x)
  box0.h = cl(loose[3], 8, dec.h - box0.y)

  const region = cropRgb(dec.data, dec.w, dec.h, box0)
  const tight = tightenBounds(region.data, region.w, region.h)
  const snapped = !!tight

  /* 自匹配闭环：裁出的模板在同帧上匹配，逐边 ±2px 贪心取得分最高边界。
   * 判据两层：位置正确（best 落回裁剪处）优先于得分——大面积纯色的模板在
   * CCOEFF_NORMED 下得分为噪声（实测同帧自匹配 best 落到别处、0.736 高于真实位置），
   * "找不到自己"比"分数低"更能说明模板不独特。 */
  const resourceDir = String(args.resourceDir || '')
  const frameFile = path.join(os.tmpdir(), 'maa_tpl_frame_' + Date.now() + '.png')
  const candFile = path.join(os.tmpdir(), 'maa_tpl_cand_' + Date.now() + '.png')
  fs.writeFileSync(frameFile, ent.png)
  const writeCand = (b) => {
    const c = cropRgb(dec.data, dec.w, dec.h, b)
    fs.writeFileSync(candFile, pngEncodeRGB(c.data, c.w, c.h))
    return c
  }
  const overlapOk = (a, b) => {
    const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]))
    const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]))
    const inter = ix * iy
    const uni = a[2] * a[3] + b[2] * b[3] - inter
    return uni > 0 && inter / uni > 0.75
  }
  const score = async (b) => {
    if (b.w < 8 || b.h < 8) return { score: -1, posOk: false, at: null }
    writeCand(b)
    const r = await spawnRecoChild({
      resourceDir, type: 'TemplateMatch', image: frameFile, templateImage: candFile, cases: [{}],
    }, 60000)
    if (!r || !r.ok) return { score: -1, posOk: false, at: null }
    const det = r.results && r.results[0] ? r.results[0].detail : null
    const best = det && det.detail && det.detail.best
    if (!best || !Array.isArray(best.box)) return { score: 0, posOk: false, at: null }
    const at = best.box.map(Number)
    return { score: Number(best.score), posOk: overlapOk(at, [b.x, b.y, b.w, b.h]), at }
  }
  const obj = (s) => (s.posOk ? 1000 : 0) + s.score
  const clampBox = (b) => ({
    x: Math.max(0, b.x), y: Math.max(0, b.y),
    w: Math.min(b.w, dec.w - Math.max(0, b.x)), h: Math.min(b.h, dec.h - Math.max(0, b.y)),
  })
  /* 候选池：snap 可能塌成细条（背景差分在混合内容上会选中稀疏行带），单靠它起步会让
   * ±2px 精修困死在退化框里——收紧框、加边距、外扩档、原始宽松框都进池，位置正确者优先。 */
  const cands = []
  if (tight) {
    const t = { x: box0.x + tight.x, y: box0.y + tight.y, w: tight.w, h: tight.h }
    cands.push(t)
    cands.push(clampBox({ x: t.x - 4, y: t.y - 4, w: t.w + 8, h: t.h + 8 }))
    for (const f of [0.25, 0.5]) {
      cands.push(clampBox({
        x: Math.round(t.x - t.w * f / 2), y: Math.round(t.y - t.h * f / 2),
        w: Math.round(t.w * (1 + f)), h: Math.round(t.h * (1 + f)),
      }))
    }
  }
  cands.push({ ...box0 })
  let cand = cands[0]
  let best = { score: -1, posOk: false, at: null }
  let bestObj = -Infinity
  const tries = { n: 0 }
  for (const c of cands) {
    const s = await score(c)
    tries.n++
    if (obj(s) > bestObj) { cand = c; best = s; bestObj = obj(s) }
    if (best.posOk && best.score >= 0.99) break
  }
  /* 逐边移动（每边独立尝试内收/外扩 2px，取更优） */
  const moves = [
    { k: 'left', apply: (b) => clampBox({ x: b.x - 2, y: b.y, w: b.w + 2, h: b.h }) },
    { k: 'right', apply: (b) => clampBox({ x: b.x, y: b.y, w: b.w + 2, h: b.h }) },
    { k: 'top', apply: (b) => clampBox({ x: b.x, y: b.y - 2, w: b.w, h: b.h + 2 }) },
    { k: 'bottom', apply: (b) => clampBox({ x: b.x, y: b.y, w: b.w, h: b.h + 2 }) },
    { k: 'left-in', apply: (b) => clampBox({ x: b.x + 2, y: b.y, w: b.w - 2, h: b.h }) },
    { k: 'right-in', apply: (b) => clampBox({ x: b.x, y: b.y, w: b.w - 2, h: b.h }) },
    { k: 'top-in', apply: (b) => clampBox({ x: b.x, y: b.y + 2, w: b.w, h: b.h - 2 }) },
    { k: 'bottom-in', apply: (b) => clampBox({ x: b.x, y: b.y, w: b.w, h: b.h - 2 }) },
  ]
  for (let round = 0; round < 2; round++) {
    let improved = false
    for (const mv of moves) {
      const nb = mv.apply(cand)
      if (nb.w < 8 || nb.h < 8 || (nb.x + nb.w > dec.w) || (nb.y + nb.h > dec.h)) continue
      if (nb.x === cand.x && nb.y === cand.y && nb.w === cand.w && nb.h === cand.h) continue
      const s = await score(nb)
      tries.n++
      if (obj(s) > bestObj + 1e-3) { cand = nb; best = s; bestObj = obj(s); improved = true }
    }
    if (!improved) break
  }
  /* 跨帧验证：同帧自匹配 1.0 只证明模板与源帧一致；真正要的是在新帧上仍稳定。
   * 连接着真机就再抓一帧验证，得分大幅衰减或位置漂移 → 模板跨帧不稳，如实警告。 */
  let cross = null
  if (S.ctrl && args.cross !== false) {
    const fresh = await captureNow('tpl-verify')
    if (fresh.ok) {
      writeCand(cand)
      const frame2 = path.join(os.tmpdir(), 'maa_tpl_frame2_' + Date.now() + '.png')
      try {
        fs.writeFileSync(frame2, S.l0.roll[S.l0.roll.length - 1].png)
        const r2 = await spawnRecoChild({
          resourceDir, type: 'TemplateMatch', image: frame2, templateImage: candFile, cases: [{}],
        }, 60000)
        const det = r2 && r2.ok && r2.results && r2.results[0] ? r2.results[0].detail : null
        const b2 = det && det.detail && det.detail.best
        cross = {
          seq: fresh.seq,
          score: b2 ? Math.round(Number(b2.score) * 1000) / 1000 : 0,
          posOk: b2 && Array.isArray(b2.box) ? overlapOk(b2.box.map(Number), [cand.x, cand.y, cand.w, cand.h]) : false,
          ...(b2 && Array.isArray(b2.box) ? { box: b2.box.map(Number) } : {}),
        }
      } finally {
        try { fs.rmSync(frame2, { force: true }) } catch (e) { /* ignore */ }
      }
    }
  }
  try { fs.rmSync(frameFile, { force: true }); fs.rmSync(candFile, { force: true }) } catch (e) { /* ignore */ }

  const final = cropRgb(dec.data, dec.w, dec.h, cand)
  const out = args.out || path.join(process.cwd(), 'maa_tpl_' + Date.now() + '.png')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, pngEncodeRGB(final.data, final.w, final.h))
  const warn = !best.posOk
    ? '低纹理/不独特：模板在同帧上都定位不到自己（best 落在 ' + JSON.stringify(best.at) + '，得分 ' +
      best.score.toFixed(3) + '）——换更纹理化的框，或走点选路径'
    : (best.score < 0.7 ? '得分偏低（' + best.score.toFixed(3) + '）但位置正确：可用，注意跨帧稳定性' : null)
  const crossWarn = cross && best.posOk && (cross.score < best.score - 0.15 || !cross.posOk)
    ? '跨帧不稳：新帧（seq=' + cross.seq + '）上得分 ' + cross.score + (cross.posOk ? '' : '且位置漂移') +
      '，源帧 ' + best.score.toFixed(3) + '——模板对动态区域敏感，慎用于识别'
    : null
  return {
    ok: true, path: out, seq: ent.seq,
    box: [cand.x, cand.y, cand.w, cand.h],
    loose: [box0.x, box0.y, box0.w, box0.h],
    snapped, score: Math.round(best.score * 1000) / 1000,
    positionOk: best.posOk,
    ...(best.at ? { selfMatchBox: best.at } : {}),
    ...(cross ? { cross } : {}),
    tries: tries.n,
    w: final.w, h: final.h,
    ctrlW: dec.w, ctrlH: dec.h,
    ...(warn ? { warn } : {}),
    ...(crossWarn ? { warn: crossWarn } : {}),
  }
}

/* ────────────────────────── 探色（ROI 实测，模型只选色不报色值） ──────────────────────────
 * 在缓冲帧（小图）上实测 ROI 的均值/HSV/主色；坐标用控制器空间（与 frame_get --roi 同语义，
 * 按该帧捕获时尺寸换算）。选色后用 reco ColorMatch 出框（走已修好的参数透传链）。 */
function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  let h = 0
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d + 6) % 6
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  return { h: Math.round(h), s: Math.round(mx ? (d / mx) * 100 : 0), v: Math.round((mx / 255) * 100) }
}

function cmdColorProbe(args) {
  const fr = args.seq !== undefined && args.seq !== null
    ? S.ring.find((r) => r.seq === Number(args.seq))
    : S.ring[S.ring.length - 1]
  if (!fr) {
    return { ok: false, error: '缓冲无可用帧（seq=' + args.seq + '）：先 screencap 或 stream start 产生观测' }
  }
  let rx = 0, ry = 0, rw = fr.w, rh = fr.h
  let ctrlRoi = null
  if (args.roi && Array.isArray(args.roi) && args.roi.length === 4) {
    const [x, y, w, h] = args.roi.map(Number)
    const sx = fr.fw > 0 ? fr.w / fr.fw : 1
    const sy = fr.fh > 0 ? fr.h / fr.fh : 1
    rx = Math.max(0, Math.floor(x * sx))
    ry = Math.max(0, Math.floor(y * sy))
    rw = Math.min(fr.w - rx, Math.max(1, Math.round(w * sx)))
    rh = Math.min(fr.h - ry, Math.max(1, Math.round(h * sy)))
    if (rx >= fr.w || ry >= fr.h || rw <= 0 || rh <= 0) {
      return { ok: false, error: 'ROI 完全越界（' + JSON.stringify(args.roi) + ' vs 捕获时 ' + fr.fw + 'x' + fr.fh + '）' }
    }
    ctrlRoi = [x, y, w, h]
  }
  let r = 0, g = 0, b = 0, n = 0
  const buckets = new Map()
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      const i = (y * fr.w + x) * 3
      const R = fr.rgb[i], G = fr.rgb[i + 1], B = fr.rgb[i + 2]
      r += R; g += G; b += B; n++
      const key = ((R >> 4) << 8) | ((G >> 4) << 4) | (B >> 4)
      buckets.set(key, (buckets.get(key) || 0) + 1)
    }
  }
  r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n)
  let dKey = 0, dCnt = 0
  for (const [k, c] of buckets) if (c > dCnt) { dCnt = c; dKey = k }
  const dom = [((dKey >> 8) & 15) * 17, ((dKey >> 4) & 15) * 17, (dKey & 15) * 17]
  return {
    ok: true, seq: fr.seq,
    ...(ctrlRoi ? { roi: ctrlRoi } : {}),
    pixelRoi: [rx, ry, rw, rh], count: n,
    mean: { r, g, b, gray: Math.round(0.299 * r + 0.587 * g + 0.114 * b) },
    hsv: rgbToHsv(r, g, b),
    dominant: { rgb: dom, ratio: Math.round((dCnt / n) * 1000) / 1000 },
    space: { small: [fr.w, fr.h], ctrl: [fr.fw, fr.fh] },
  }
}

/* ────────────────────────── annotate（轻量 SoM：候选区域 + 编号回画） ──────────────────────────
 * 候选源：OCR 框（MaaFW OCR 管线，detail.all）+ 连通域（积分图背景差 + BFS）+ 边缘密度
 * （Sobel 块 z 值聚类）+ 变化 diff 区域（change 事件的 ctrl bbox）。回画编号图 + 候选表，
 * 模型看图选号 → 查 ctrl 坐标 → click/reco。半透明/粒子/渐变场景候选质量降级，走点选路径。 */
const FONT3X5 = {
  0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'], 3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'], 5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'], 7: ['111', '001', '001', '001', '001'],
  8: ['111', '101', '111', '101', '111'], 9: ['111', '101', '111', '001', '111'],
}
function drawLabel(buf, w, h, x, y, num, color) {
  const s = String(num)
  const lw = s.length * 4 + 1, lh = 7
  const px = Math.max(0, Math.min(w - lw, x)), py = Math.max(0, Math.min(h - lh, y))
  for (let yy = 0; yy < lh; yy++) for (let xx = 0; xx < lw; xx++) {
    const i = ((py + yy) * w + px + xx) * 3
    buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255
  }
  for (let k = 0; k < s.length; k++) {
    const glyph = FONT3X5[s[k]]
    for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) {
      if (glyph[gy][gx] !== '1') continue
      const i = ((py + 1 + gy) * w + px + 1 + k * 4 + gx) * 3
      buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2]
    }
  }
}
function drawRect(buf, w, h, box, color) {
  const [x, y, bw, bh] = box
  const x1 = Math.min(w - 1, x + bw - 1), y1 = Math.min(h - 1, y + bh - 1)
  for (let xx = Math.max(0, x); xx <= x1; xx++) {
    for (const yy of [Math.max(0, y), y1]) {
      const i = (yy * w + xx) * 3
      buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2]
    }
  }
  for (let yy = Math.max(0, y); yy <= y1; yy++) {
    for (const xx of [Math.max(0, x), x1]) {
      const i = (yy * w + xx) * 3
      buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2]
    }
  }
}

/** 灰度图积分图 → 均值背景 → 背景差二值 → BFS 连通域（面积过滤） */
function connComponents(rgb, w, h) {
  const gray = new Float64Array(w * h)
  for (let i = 0, p = 0; i < w * h; i++, p += 3) {
    gray[i] = (rgb[p] * 3 + rgb[p + 1] * 6 + rgb[p + 2]) * 0.1
  }
  const integ = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let rowSum = 0
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x]
      integ[(y + 1) * (w + 1) + (x + 1)] = integ[y * (w + 1) + (x + 1)] + rowSum
    }
  }
  const R = 12
  const dev = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(h, y + R + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - R), x1 = Math.min(w, x + R + 1)
      const area = (x1 - x0) * (y1 - y0)
      const sum = integ[y1 * (w + 1) + x1] - integ[y0 * (w + 1) + x1] - integ[y1 * (w + 1) + x0] + integ[y0 * (w + 1) + x0]
      if (Math.abs(gray[y * w + x] - sum / area) > 26) dev[y * w + x] = 1
    }
  }
  const seen = new Uint8Array(w * h)
  const boxes = []
  const queue = new Int32Array(w * h)
  for (let start = 0; start < w * h; start++) {
    if (!dev[start] || seen[start]) continue
    let qs = 0, qe = 0
    queue[qe++] = start
    seen[start] = 1
    let minX = w, minY = h, maxX = 0, maxY = 0, area = 0
    while (qs < qe) {
      const p = queue[qs++]
      const px = p % w, py = (p / w) | 0
      area++
      if (px < minX) minX = px; if (px > maxX) maxX = px
      if (py < minY) minY = py; if (py > maxY) maxY = py
      if (px > 0 && dev[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; queue[qe++] = p - 1 }
      if (px < w - 1 && dev[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; queue[qe++] = p + 1 }
      if (py > 0 && dev[p - w] && !seen[p - w]) { seen[p - w] = 1; queue[qe++] = p - w }
      if (py < h - 1 && dev[p + w] && !seen[p + w]) { seen[p + w] = 1; queue[qe++] = p + w }
    }
    if (area >= 120 && area <= 24000 && maxX - minX >= 10 && maxY - minY >= 10) {
      boxes.push([minX, minY, maxX - minX + 1, maxY - minY + 1])
    }
  }
  return boxes
}

/** Sobel 边缘密度的块级聚类（16px 块，z 值超限块 BFS 成框） */
function edgeDensityBoxes(rgb, w, h) {
  const BS = 16
  const bw = Math.ceil(w / BS), bh = Math.ceil(h / BS)
  const mag = new Float64Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 3
      const gx = (rgb[i + 3] * 2 + rgb[i - w * 3 + 3] + rgb[i + w * 3 + 3]) - (rgb[i - 3] * 2 + rgb[i - w * 3 - 3] + rgb[i + w * 3 - 3])
      const gy = (rgb[i + w * 3] * 2 + rgb[i + w * 3 + 1] + rgb[i + w * 3 - 1]) - (rgb[i - w * 3] * 2 + rgb[i - w * 3 + 1] + rgb[i - w * 3 - 1])
      mag[y * w + x] = Math.abs(gx) + Math.abs(gy)
    }
  }
  const blk = new Float64Array(bw * bh)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) blk[((y / BS) | 0) * bw + ((x / BS) | 0)] += mag[y * w + x]
  let mean = 0
  for (const v of blk) mean += v
  mean /= blk.length
  let sd = 0
  for (const v of blk) sd += (v - mean) * (v - mean)
  sd = Math.sqrt(sd / blk.length)
  const hot = new Uint8Array(bw * bh)
  for (let k = 0; k < blk.length; k++) if (blk[k] > mean + 1.2 * sd && blk[k] > 2000) hot[k] = 1
  const seen = new Uint8Array(bw * bh)
  const boxes = []
  const stack = []
  for (let k = 0; k < bw * bh; k++) {
    if (!hot[k] || seen[k]) continue
    stack.length = 0
    stack.push(k)
    seen[k] = 1
    let minX = bw, minY = bh, maxX = 0, maxY = 0, n = 0
    while (stack.length) {
      const p = stack.pop()
      const px = p % bw, py = (p / bw) | 0
      n++
      if (px < minX) minX = px; if (px > maxX) maxX = px
      if (py < minY) minY = py; if (py > maxY) maxY = py
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = px + dx, ny = py + dy
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue
        const q = ny * bw + nx
        if (hot[q] && !seen[q]) { seen[q] = 1; stack.push(q) }
      }
    }
    if (n >= 2) {
      const x = minX * BS, y = minY * BS
      boxes.push([x, y, Math.min(w - x, (maxX - minX + 1) * BS), Math.min(h - y, (maxY - minY + 1) * BS)])
    }
  }
  return boxes
}

const SOM_COLORS = { ocr: [0, 190, 255], conn: [60, 220, 60], edge: [255, 160, 0], diff: [255, 70, 70] }
const SOM_PRIORITY = { ocr: 0, diff: 1, conn: 2, edge: 3 }

async function cmdAnnotate(args) {
  const fr = args.seq !== undefined && args.seq !== null
    ? S.ring.find((r) => r.seq === Number(args.seq))
    : S.ring[S.ring.length - 1]
  if (!fr) return { ok: false, error: '缓冲无可用帧（seq=' + args.seq + '）：先 screencap / stream 产生观测' }
  const sx = fr.fw > 0 ? fr.fw / fr.w : 1
  const sy = fr.fh > 0 ? fr.fh / fr.h : 1
  const toCtrl = (b) => [Math.round(b[0] * sx), Math.round(b[1] * sy), Math.round(b[2] * sx), Math.round(b[3] * sy)]
  const raw = []

  /* 源 1：OCR 框（子进程跑 MaaFW OCR，detail.all 是全部文本框） */
  if (args.resourceDir) {
    const imgFile = path.join(os.tmpdir(), 'maa_som_' + Date.now() + '.png')
    try {
      fs.writeFileSync(imgFile, pngEncodeRGB(fr.rgb, fr.w, fr.h))
      const r = await spawnRecoChild({ resourceDir: String(args.resourceDir), type: 'OCR', image: imgFile, cases: [{}] }, 60000)
      if (r && r.ok) {
        const det = r.results && r.results[0] && r.results[0].detail
        const all = det && det.detail && Array.isArray(det.detail.all) ? det.detail.all : []
        for (const hit of all) {
          if (!Array.isArray(hit.box) || Number(hit.score) < 0.5) continue
          raw.push({ source: 'ocr', box: hit.box.map(Number), extra: { text: String(hit.text ?? ''), score: Number(hit.score) } })
        }
      }
    } finally {
      try { fs.rmSync(imgFile, { force: true }) } catch (e) { /* ignore */ }
    }
  }
  /* 源 2/3：连通域与边缘密度（纯 CPU，小图上毫秒级） */
  for (const b of connComponents(fr.rgb, fr.w, fr.h)) raw.push({ source: 'conn', box: b })
  for (const b of edgeDensityBoxes(fr.rgb, fr.w, fr.h)) raw.push({ source: 'edge', box: b })
  /* 源 4：最近 change 事件的 diff 区域（ctrl → 小图坐标） */
  const diffs = []
  for (let i = S.events.length - 1; i >= 0 && diffs.length < 3; i--) {
    const ev = S.events[i]
    if (ev.type === 'change' && ev.region && ev.region.ctrl) diffs.push(ev.region.ctrl)
  }
  for (const c of diffs) {
    raw.push({ source: 'diff', box: [Math.round(c[0] / sx), Math.round(c[1] / sy), Math.round(c[2] / sx), Math.round(c[3] / sy)] })
  }

  /* 去重合并：IoU>0.6 保留优先级高的源（ocr > diff > conn > edge）；上限 30 */
  raw.sort((a, b) => (SOM_PRIORITY[a.source] ?? 9) - (SOM_PRIORITY[b.source] ?? 9))
  const iou = (a, b) => {
    const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]))
    const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]))
    const inter = ix * iy
    const uni = a[2] * a[3] + b[2] * b[3] - inter
    return uni > 0 ? inter / uni : 0
  }
  const cands = []
  for (const c of raw) {
    if (c.box[2] < 8 || c.box[3] < 8) continue
    if (cands.some((x) => iou(x.box, c.box) > 0.6)) continue
    cands.push(c)
    if (cands.length >= 30) break
  }
  /* 回画：源配色边框 + 编号标签 */
  const buf = Buffer.from(fr.rgb)
  cands.forEach((c, i) => {
    const color = SOM_COLORS[c.source] ?? [200, 200, 200]
    drawRect(buf, fr.w, fr.h, c.box, color)
    drawLabel(buf, fr.w, fr.h, c.box[0], c.box[1] - 8, i + 1, [20, 20, 20])
  })
  const out = args.out || path.join(process.cwd(), 'maa_som_' + Date.now() + '.png')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, pngEncodeRGB(buf, fr.w, fr.h))
  return {
    ok: true, out, seq: fr.seq,
    small: [fr.w, fr.h], ctrl: [fr.fw, fr.fh],
    count: cands.length,
    sources: { ocr: cands.filter((c) => c.source === 'ocr').length, conn: cands.filter((c) => c.source === 'conn').length, edge: cands.filter((c) => c.source === 'edge').length, diff: cands.filter((c) => c.source === 'diff').length },
    candidates: cands.map((c, i) => ({ id: i + 1, source: c.source, box: c.box, ctrl: toCtrl(c.box), ...(c.extra ?? {}) })),
    ...(cands.length === 0 ? { warn: '无候选：画面可能静止且低对比；换帧或走点选路径' } : {}),
  }
}

/* ────────────────────────── 阈值校准（静止画面噪声定标） ──────────────────────────
 * 采集 N 帧（要求画面静止），统计相邻帧分块亮度差与全局位差率的分布，推荐
 * blockThresh / changeGlobal。噪声地板之上留裕量，让真变化必超、静止必不超。
 * 期间若有真实变化会抬高推荐值——max ≫ p99 时警告重跑。 */
async function cmdCalibrate(args) {
  if (!S.ctrl) return { ok: false, error: '未连接设备（先连接）' }
  const frames = Math.min(60, Math.max(6, Number(args.frames ?? 24)))
  const interval = Math.max(120, Number(args.interval ?? 300))
  const blockDiffs = []
  const globals = []
  let last = null
  for (let i = 0; i < frames; i++) {
    const j = S.ctrl.post_screencap()
    await j.wait()
    const buf = j.get()
    if (!buf || buf.byteLength < 8) return { ok: false, error: '第 ' + (i + 1) + ' 帧截图失败' }
    const b = Buffer.from(buf)
    const dec = pngDecode(b)
    pushFrame(dec, b)   // 校准采集也是观测（进环进 L0，可复核）
    const small = downscale(toRgb(dec), dec.w, dec.h, S.streamScale)
    const { hash, means } = blockAnalyze(small.data, small.w, small.h)
    if (last) {
      globals.push(hashDist(last.hash, hash))
      for (let k = 0; k < 64; k++) blockDiffs.push(Math.abs(means[k] - last.means[k]))
    }
    last = { hash, means }
    if (i < frames - 1) await sleep(interval)
  }
  blockDiffs.sort((a, b) => a - b)
  globals.sort((a, b) => a - b)
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]
  const stats = (arr) => ({
    p50: Math.round(pct(arr, 0.5) * 1000) / 1000,
    p99: Math.round(pct(arr, 0.99) * 1000) / 1000,
    max: Math.round(arr[arr.length - 1] * 1000) / 1000,
  })
  const bs = stats(blockDiffs)
  const gs = stats(globals)
  const blockThresh = Math.min(32, Math.max(2, Math.ceil(bs.max + 2)))
  const changeGlobal = Math.min(0.3, Math.max(0.02, Math.round((gs.max + 0.01) * 1000) / 1000))
  const moved = bs.max > bs.p99 * 2 + 1
  return {
    ok: true, frames,
    block: bs, global: gs,
    recommended: { blockThresh, changeGlobal },
    apply: 'stream start --block-thresh ' + blockThresh + ' --change-global ' + changeGlobal,
    ...(moved ? { warn: 'max 远超 p99（' + bs.max + ' vs ' + bs.p99 + '）：校准期间疑似有真实变化，建议静止画面重跑' } : {}),
  }
}

/* ────────────────────────── 消息分发 ────────────────────────── */
const handlers = {
  init: (a) => {
    if (a.runDir) {
      S.runDir = String(a.runDir)
      S.previewPath = path.join(S.runDir, 'preview.png')
      try { fs.mkdirSync(S.runDir, { recursive: true }) } catch (e) { /* ignore */ }
    }
    return { ok: true, previewPath: S.previewPath, daemonId: S.daemonId, framesDir: kfRoot() }
  },
  probe: cmdProbe,
  device_list: (a) => cmdDeviceList(a.kind),
  connect: cmdConnect,
  disconnect: cmdDisconnect,
  screencap: (a) => cmdScreencap(a.out),
  stream_start: cmdStreamStart,
  stream_stop: cmdStreamStop,
  stream_status: cmdStreamStatus,
  frame_get: cmdFrameGet,
  tpl_crop: cmdTplCrop,
  annotate: cmdAnnotate,
  calibrate: cmdCalibrate,
  color_probe: cmdColorProbe,
  l0_status: cmdL0Status,
  kf_promote: cmdKfPromote,
  run: cmdRun,
  run_stop: cmdRunStop,
  input: cmdInput,
  reco_test: cmdRecoTest,
  shutdown: async () => { await cmdStreamStop(); await cleanupAgents(); await cmdDisconnect(); process.exit(0) },
}

/* 子进程模式：stdin JSON 行协议（每行一条消息）。非 --child（headless 单测 import）不挂监听。 */
if (CHILD) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    let m = null
    try { m = JSON.parse(line) } catch (e) {
      send({ kind: 'reply', id: -1, ok: false, error: 'bad json line' })
      return
    }
    if (!m || typeof m.cmd !== 'string') return
    const h = handlers[m.cmd]
    if (!h) { reply(m.id, false, 'unknown cmd: ' + m.cmd); return }
    Promise.resolve()
      .then(() => h(m))
      .then((data) => reply(m.id, true, data))
      .catch((e) => reply(m.id, false, String(e && e.message || e)))
  })
}

/* 纯函数导出（供 headless 验证直接断言，子进程运行中不使用） */
export const __test = { pngDecode, pngEncodeRGB, downscale, blockHash, hashDist }
