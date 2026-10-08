/**
 * `@windsland52/maa-live/image` 的单测（公开导出，宿主面板直接用它裁模板 / 缩放预览）。
 *
 * 这层是**契约面**：面板"看到的缩放"与识别"用的缩放"必须同源，所以它复用 daemon 的
 * pngDecode / downscale / pngEncodeRGB（`lib/image.js` 动态 import 同一个 .mjs，不做第二份实现）。
 * 这里钉的就是这条同源性：尺寸、裁剪像素、只缩不放、RGBA 归一化、data URL 互转。
 *
 * 夹具用 `pngEncodeRGB` 造（它只出 RGB）；RGBA 分支由 test 内自造的 colorType 6 覆盖——
 * 该分支在生产里真会被走到（设备截图可能是 RGBA），只测 RGB 等于没测。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { pngSize, scalePngLongSide, cropPng, dataUrlToPng, pngToDataUrl } from '../lib/image.js'
import { __test } from '../src/daemon/framed.mjs'

const { pngDecode, pngEncodeRGB } = __test

/** 纯色图（RGB） */
function solid(w, h, [r, g, b]) {
  const buf = Buffer.alloc(w * h * 3)
  for (let i = 0; i < w * h; i++) { buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b }
  return buf
}

/** 在图上画实心矩形（不裁剪越界），用来断言"裁到的确实是那一块" */
function fillRect(buf, w, x0, y0, rw, rh, [r, g, b]) {
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) {
      if (x < 0 || y < 0 || x >= w) continue
      const i = (y * w + x) * 3
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b
    }
  }
  return buf
}

/** 取某像素（RGB Buffer） */
function px(rgb, w, x, y) {
  const i = (y * w + x) * 3
  return [rgb[i], rgb[i + 1], rgb[i + 2]]
}

/**
 * 自造 PNG：支持 colorType 2（RGB）与 6（RGBA），滤镜一律 0。
 * CRC 填 0：daemon 的最小解码器只按 chunk 长度切，不校 CRC（这一点另有单测覆盖长度断言）。
 */
function craftPng(w, h, ch, pixels) {
  const stride = w * ch
  const raw = Buffer.alloc(h * (stride + 1))
  for (let y = 0; y < h; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ch === 4 ? 6 : 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('pngSize：报真实尺寸（与编码侧一致）', async () => {
  assert.deepEqual(await pngSize(pngEncodeRGB(solid(37, 23, [1, 2, 3]), 37, 23)), { w: 37, h: 23 })
})

test('pngSize：非 PNG 直接抛（不返回假尺寸）', async () => {
  await assert.rejects(() => pngSize(Buffer.from('not a png at all....')), /not a png/)
})

test('scalePngLongSide：只缩不放——小图原样返回同一个 Buffer', async () => {
  const small = pngEncodeRGB(solid(20, 10, [9, 9, 9]), 20, 10)
  const out = await scalePngLongSide(small, 480)
  assert.equal(out, small, '没超上限就该原样返回（省一次重编码）')
})

test('scalePngLongSide：大图长边收到 maxSide，比例不变', async () => {
  const src = pngEncodeRGB(solid(1280, 720, [10, 20, 30]), 1280, 720)
  const out = await scalePngLongSide(src, 480)
  const { w, h } = await pngSize(out)
  assert.ok(Math.abs(w - 480) <= 1, '长边应落到 480 附近，实际 ' + w)
  assert.ok(Math.abs(h - 270) <= 1, '短边应按比例，实际 ' + h)
  assert.ok((await pngSize(out)).w < 1280, '确实缩小了')
})

test('scalePngLongSide：maxSide 有下限 16（不给出 0 边长）', async () => {
  const src = pngEncodeRGB(solid(64, 64, [1, 1, 1]), 64, 64)
  const { w, h } = await pngSize(await scalePngLongSide(src, 1))
  assert.ok(w >= 16 && h >= 16, `实际 ${w}x${h}`)
})

test('cropPng：内部矩形裁出的像素与源一致', async () => {
  const w = 40, h = 30
  let rgb = solid(w, h, [0, 0, 0])
  rgb = fillRect(rgb, w, 10, 8, 6, 4, [255, 128, 0])
  const { data, w: cw, h: chh } = pngDecode(await cropPng(pngEncodeRGB(rgb, w, h), [10, 8, 6, 4]))
  assert.equal(cw, 6); assert.equal(chh, 4)
  assert.deepEqual(px(data, cw, 0, 0), [255, 128, 0])
  assert.deepEqual(px(data, cw, 5, 3), [255, 128, 0])
})

test('cropPng：越界自动夹紧（原点夹进画布、尺寸再夹到边界），且至少 1 像素', async () => {
  const w = 20, h = 20
  let rgb = solid(w, h, [0, 0, 0])
  rgb = fillRect(rgb, w, 0, 0, w, h, [7, 7, 7])
  const png = pngEncodeRGB(rgb, w, h)
  /* 负原点：夹到 (0,0)，尺寸仍按请求（再夹到边界）——是"平移进画布"，不是求交集。
   * 与 daemon `frame_get` 的 roi 夹取同一套语义，两处都改了才算改（这里是同源的那一份）。 */
  const neg = pngDecode(await cropPng(png, [-5, -5, 10, 10]))
  assert.deepEqual([neg.w, neg.h], [10, 10])
  assert.deepEqual(px(neg.data, neg.w, 0, 0), [7, 7, 7], '夹紧后应落在画布左上角那块像素上')
  const over = pngDecode(await cropPng(png, [15, 15, 100, 100]))
  assert.deepEqual([over.w, over.h], [5, 5], '超出部分应夹到边界')
  const zero = pngDecode(await cropPng(png, [3, 3, 0, 0]))
  assert.deepEqual([zero.w, zero.h], [1, 1], '零尺寸给 1 像素，不给空图')
})

test('cropPng：RGBA 源按 RGB 输出（丢弃 alpha，不做第二份实现）', async () => {
  const w = 4, h = 2
  const rgba = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 200; rgba[i * 4 + 1] = 100; rgba[i * 4 + 2] = 50; rgba[i * 4 + 3] = 128
  }
  const out = pngDecode(await cropPng(craftPng(w, h, 4, rgba), [0, 0, w, h]))
  assert.equal(out.ch, 3, 'RGBA 源要归一化成 RGB（否则下游按 3 通道步进会错剪）')
  assert.deepEqual(px(out.data, out.w, 1, 1), [200, 100, 50])
})

test('dataUrl 互转往返一致；非图片或坏 data URL 返回 null', () => {
  const png = pngEncodeRGB(solid(5, 5, [3, 4, 5]), 5, 5)
  const url = pngToDataUrl(png)
  assert.match(url, /^data:image\/png;base64,/)
  assert.ok(dataUrlToPng(url)?.equals(png))
  assert.equal(dataUrlToPng('data:text/plain;base64,aGk='), null, '非图片 data URL 不是 PNG')
  assert.equal(dataUrlToPng('data:image/png;base64'), null, '缺逗号要如实返回 null')
})
