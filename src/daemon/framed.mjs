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
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
/** 8×8 分块亮度哈希（相对整体均值） */
function blockHash(rgb, w, h) {
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
  const out = new Uint8Array(64)
  for (let k = 0; k < 64; k++) out[k] = cells[k] / Math.max(1, cnt[k]) >= mean ? 1 : 0
  return out
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
  fullW: 0, fullH: 0,                  // 控制器分辨率（默认短边 720p，pipeline roi/模板同空间）
  previewPath: null,                   // 面板实时预览帧落盘路径（host 传 runDir 初始化）
  stream: false, streamTimer: null,
  streamFps: 8, streamScale: 480, maxFrames: 120,
  seq: 0,
  ring: [],                            // {seq,t,rgb,w,h,hash,diff}
  events: [],                          // {type:'change'|'stable', seq, t, diff, dur?}
  framesMeta: [],                      // {seq,t,hash,diff,w,h}（元数据）
  quietNow: false, stableCount: 0,
  lastPng: null,
  runActive: false,
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
       Windows/Linux 宿主上不给"也许能连"的尝试，直接说明。 */
    return { ok: false, error: '控制器类型 ' + args.kind + ' 仅支持在 macOS 上使用；当前宿主是 ' + process.platform }
  } else if (args.kind === 'linux') {
    /* LinuxController 需 wlroots/pipewire/uinput 会话；当前 daemon 未接入。 */
    return { ok: false, error: 'Linux 控制器尚未接入当前 daemon（需要 wlroots/pipewire/uinput 会话配置）' }
  } else {
    return { ok: false, error: '未知控制器类型：' + args.kind + '（支持 win32/adb/gamepad）' }
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
  S.fullW = dec.w; S.fullH = dec.h
  const file = outFile || path.join(process.cwd(), 'maa_screencap_' + Date.now() + '.png')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, b)
  return { ok: true, path: file, bytes: b.length, w: dec.w, h: dec.h }
}

/* ────────────────────────── 帧流（自适应节奏 + 事件合并） ────────────────────────── */
function pushFrame(dec) {
  const rgb = toRgb(dec)
  const small = downscale(rgb, dec.w, dec.h, S.streamScale)
  const hash = blockHash(small.data, small.w, small.h)
  const prev = S.ring.length ? S.ring[S.ring.length - 1] : null
  const diff = prev ? hashDist(prev.hash, hash) : 0
  S.seq++
  const fr = { seq: S.seq, t: Date.now(), rgb: small.data, w: small.w, h: small.h, hash, diff }
  S.ring.push(fr)
  if (S.ring.length > S.maxFrames) S.ring.shift()
  S.fullW = dec.w; S.fullH = dec.h
  const meta = { seq: fr.seq, t: fr.t, hash: hashStr(hash), diff: Math.round(diff * 1000) / 1000, w: fr.w, h: fr.h }
  S.framesMeta.push(meta)
  if (S.framesMeta.length > 2000) S.framesMeta.splice(0, S.framesMeta.length - 2000)
  /* 预览帧落盘（原子替换）：面板 HTTP 直读，避免二进制走 JSON 行协议 */
  const png = pngEncodeRGB(small.data, small.w, small.h)
  if (S.previewPath) {
    const tmp = S.previewPath + '.tmp'
    try { fs.writeFileSync(tmp, png); fs.renameSync(tmp, S.previewPath) } catch (e) { /* 落盘失败不致命 */ }
  }
  send({ kind: 'frame', meta, preview: S.previewPath })
  // 变化 / 稳定事件（400ms 窗口合并）
  if (diff > 0.06) {
    S.quietNow = false
    const last = S.events.length ? S.events[S.events.length - 1] : null
    if (last && last.type === 'change' && fr.t - last.t < 400) {
      last.t = fr.t; last.seq = fr.seq; last.diff = Math.max(last.diff, diff)
    } else {
      pushEvent({ type: 'change', seq: fr.seq, t: fr.t, diff: Math.round(diff * 1000) / 1000 })
    }
  } else if (prev && diff <= 0.06) {
    if (!S.quietNow) {
      S.quietNow = true
      pushEvent({ type: 'stable', seq: fr.seq, t: fr.t, diff: Math.round(diff * 1000) / 1000 })
    }
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
    if (buf && buf.byteLength > 8) pushFrame(pngDecode(Buffer.from(buf)))
  } catch (e) {
    send({ kind: 'stream_error', error: String(e && e.message || e) })
  }
  if (!S.stream) return
  const elapsed = Date.now() - t0
  const recent = S.ring.slice(-3)
  const quiet = S.quietNow || (recent.length >= 2 && recent.every((r) => r.diff <= 0.06))
  const wait = quiet ? 1000 : Math.max(60, Math.round(1000 / Math.max(1, S.streamFps)))
  S.streamTimer = setTimeout(streamTick, Math.max(0, wait - elapsed))
}

async function cmdStreamStart(args) {
  if (!S.ctrl) return { ok: false, error: '未连接设备（先 maa_connect）' }
  if (args.fps) S.streamFps = Math.min(30, Math.max(1, Number(args.fps)))
  if (args.scale) S.streamScale = Math.min(1280, Math.max(160, Number(args.scale)))
  if (args.maxFrames) S.maxFrames = Math.min(600, Math.max(20, Number(args.maxFrames)))
  if (!S.stream) {
    S.stream = true
    S.quietNow = false
    S.streamTimer = setTimeout(streamTick, 0)
  }
  return { ok: true, fps: S.streamFps, scale: S.streamScale, maxFrames: S.maxFrames }
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
    /* ROI 为控制器分辨率坐标（默认短边 720p，与 pipeline 里写的 roi 同空间）→ 映射到降采样缓冲 */
    const [x, y, w, h] = args.roi.map(Number)
    const sx = S.fullW > 0 ? fr.w / S.fullW : 1
    const sy = S.fullH > 0 ? fr.h / S.fullH : 1
    const rx = Math.max(0, Math.floor(x * sx))
    const ry = Math.max(0, Math.floor(y * sy))
    const rw = Math.min(fr.w - rx, Math.max(1, Math.round(w * sx)))
    const rh = Math.min(fr.h - ry, Math.max(1, Math.round(h * sy)))
    if (rx >= fr.w || ry >= fr.h || rw <= 0 || rh <= 0) {
      return { ok: false, error: 'ROI 完全越界（' + JSON.stringify(args.roi) + ' vs ' + S.fullW + 'x' + S.fullH + '）' }
    }
    const crop = Buffer.alloc(rw * rh * 3)
    for (let yy = 0; yy < rh; yy++) {
      fr.rgb.copy(crop, yy * rw * 3, ((ry + yy) * fr.w + rx) * 3, ((ry + yy) * fr.w + rx + rw) * 3)
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, pngEncodeRGB(crop, rw, rh))
    return { ok: true, path: outFile, bytes: fs.statSync(outFile).size, w: rw, h: rh, seq: fr.seq, t: fr.t, diff: fr.diff }
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, pngEncodeRGB(fr.rgb, fr.w, fr.h))
  return { ok: true, path: outFile, bytes: fs.statSync(outFile).size, w: fr.w, h: fr.h, seq: fr.seq, t: fr.t, diff: fr.diff }
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
  const tasker = ensureTasker()
  tasker.resource = res
  tasker.controller = S.ctrl
  const timeoutMs = Math.min(300000, Math.max(500, Number(args.timeoutMs || 30000)))
  const t0 = Date.now()
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
    await Promise.race([
      job.wait().then(() => { finished = true }),
      sleep(timeoutMs),
    ])
    if (!finished) {
      try { tasker.post_stop() } catch (e) { /* ignore */ }
      stopped = true
      await Promise.race([job.wait().catch(() => null), sleep(1500)])
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
  const rec = {
    ok: status === STATUS.succeeded,
    entry: String(args.entry),
    status,
    stopped,
    durationMs: Date.now() - t0,
    startSeq: nodes.size ? order[0].seq : null,
    endSeq: S.seq,
    framesCaptured: S.seq,
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

/* 输入注入：全部经 maafw 控制器（adb/win32 由 maafw 本体选择注入方法），不直接调 adb */
async function cmdInput(args) {
  if (!S.ctrl) return { ok: false, error: '未连接设备（先 maa_connect）' }
  const t0 = Date.now()
  const k = String(args.kind || 'click')
  let job = null
  if (k === 'click') {
    job = S.ctrl.post_click(Number(args.x), Number(args.y), Number(args.contact ?? 0), Number(args.pressure ?? 1))
  } else if (k === 'swipe') {
    job = S.ctrl.post_swipe(Number(args.x1), Number(args.y1), Number(args.x2), Number(args.y2),
      Number(args.duration ?? 300), Number(args.contact ?? 0), Number(args.pressure ?? 1))
  } else if (k === 'key') {
    job = S.ctrl.post_click_key(Number(args.code))
  } else if (k === 'text') {
    job = S.ctrl.post_input_text(String(args.text ?? ''))
  } else if (k === 'app') {
    job = String(args.action) === 'stop'
      ? S.ctrl.post_stop_app(String(args.intent ?? ''))
      : S.ctrl.post_start_app(String(args.intent ?? ''))
  } else {
    return { ok: false, error: 'unknown input kind: ' + k + '（click|swipe|key|text|app）' }
  }
  await job.wait()
  return { ok: true, kind: k, ms: Date.now() - t0 }
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

async function cmdRecoTest(args) {
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

/* ────────────────────────── 消息分发 ────────────────────────── */
const handlers = {
  init: (a) => {
    if (a.runDir) {
      S.previewPath = path.join(String(a.runDir), 'preview.png')
      try { fs.mkdirSync(String(a.runDir), { recursive: true }) } catch (e) { /* ignore */ }
    }
    return { ok: true, previewPath: S.previewPath }
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
  run: cmdRun,
  run_stop: cmdRunStop,
  input: cmdInput,
  reco_test: cmdRecoTest,
  shutdown: async () => { await cmdStreamStop(); await cmdDisconnect(); process.exit(0) },
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
