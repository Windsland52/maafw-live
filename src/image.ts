/**
 * 纯 JS 图像工具：复用 daemon 里那套无依赖 PNG 编解码（不做第二份实现）。
 *
 * daemon（daemon/framed.mjs）本来就带 PNG 解码 / 缩放 / 编码 —— 它要在没有 native 依赖的
 * 前提下处理帧 —— 但只在子进程里用。这里用非字面量说明符动态 import 取它的 __test 导出：
 * 避免为一个 .mjs 引入声明文件、把构建链复杂化，同时用下面的接口把契约钉死。
 *
 * 与 daemon 帧流共用同一条降采样路径，因此"面板预览看到的缩放"和"识别用的缩放"不会分叉。
 */

interface Decoded { w: number; h: number; ch: number; data: Buffer }

interface MaaImageHelpers {
  pngDecode(buf: Buffer): Decoded
  pngEncodeRGB(rgb: Buffer, w: number, h: number): Buffer
  downscale(rgb: Buffer, sw: number, sh: number, maxSide: number): { w: number; h: number; data: Buffer }
}

let cached: MaaImageHelpers | null = null

async function helpers(): Promise<MaaImageHelpers> {
  if (cached) return cached
  const spec = "./daemon/framed.mjs"
  const mod = (await import(spec)) as unknown as { __test: MaaImageHelpers }
  cached = mod.__test
  return cached
}

/** 解码结果 → 3 字节/像素的 RGB（daemon 的 toRgb 没导出，这里只补这一步）。 */
function toRgb(dec: Decoded): Buffer {
  if (dec.ch === 3) return dec.data
  if (dec.ch === 4) {
    const out = Buffer.alloc(dec.w * dec.h * 3)
    for (let i = 0, o = 0; i < dec.data.length; i += 4, o += 3) {
      out[o] = dec.data[i]!
      out[o + 1] = dec.data[i + 1]!
      out[o + 2] = dec.data[i + 2]!
    }
    return out
  }
  throw new Error("只支持 RGB/RGBA 的 PNG（该图为 " + dec.ch + " 通道）")
}

/** PNG Buffer 的尺寸。 */
export async function pngSize(buf: Buffer): Promise<{ w: number; h: number }> {
  const t = await helpers()
  const dec = t.pngDecode(buf)
  return { w: dec.w, h: dec.h }
}

/** 按"长边不超过 maxSide"缩放 PNG（只缩不放，原图更小时原样返回）。 */
export async function scalePngLongSide(buf: Buffer, maxSide: number): Promise<Buffer> {
  const t = await helpers()
  const dec = t.pngDecode(buf)
  const target = Math.max(16, Math.floor(maxSide))
  if (dec.w <= target && dec.h <= target) return buf
  const scaled = t.downscale(toRgb(dec), dec.w, dec.h, target)
  return t.pngEncodeRGB(scaled.data, scaled.w, scaled.h)
}

/**
 * 按矩形裁一块出来（控制器分辨率坐标系，越界自动夹紧）。
 *
 * 面板的"模板匹配即时校验"用它：把人框的这块裁成模板图，再交给识别去比对 —— 因此这一步
 * 必须与帧流/识别走同一条解码路径，不能各自实现（否则裁出来的像素与识别看到的不是同一份）。
 */
export async function cropPng(buf: Buffer, rect: [number, number, number, number]): Promise<Buffer> {
  const t = await helpers()
  const dec = t.pngDecode(buf)
  const [rx, ry, rw, rh] = rect.map((n) => Math.round(Number(n) || 0)) as [number, number, number, number]
  const x = Math.max(0, Math.min(dec.w - 1, rx))
  const y = Math.max(0, Math.min(dec.h - 1, ry))
  const w = Math.max(1, Math.min(dec.w - x, rw))
  const h = Math.max(1, Math.min(dec.h - y, rh))
  const rgb = toRgb(dec)
  const out = Buffer.alloc(w * h * 3)
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * dec.w + x) * 3
    rgb.copy(out, row * w * 3, from, from + w * 3)
  }
  return t.pngEncodeRGB(out, w, h)
}

/** data URL → PNG Buffer；非图片 data URL 返回 null。 */
export function dataUrlToPng(dataUrl: string): Buffer | null {
  if (!dataUrl.startsWith("data:image/")) return null
  const comma = dataUrl.indexOf(",")
  if (comma < 0) return null
  try { return Buffer.from(dataUrl.slice(comma + 1), "base64") } catch { return null }
}

/** PNG Buffer → data URL（面板侧统一 data:image/png）。 */
export function pngToDataUrl(buf: Buffer): string {
  return "data:image/png;base64," + buf.toString("base64")
}
