/**
 * reco_child —— 识别单测的一次性子进程（崩溃隔离）。
 * 用法：node reco_child.mjs --cfg <json> --out <result.json>
 * cfg = { resourceDir, type, image, param?, sweep?, templateImage? }
 *
 * 为什么要造一个"图像假控制器"：裸 post_recognition 不产出 RecoId，于是 recognition_detail 拿不到
 * 详情（也就是命中框）。上游 maa-support 的做法是：用给定图像造一个 CustomController，让框架以为自己
 * 在截图，再在自定义 action 里调 context.run_recognition —— 详情直接由那次调用返回。这里沿用同一条路径。
 */
import { createRequire } from "node:module"
import fs from "node:fs"

const require = createRequire(import.meta.url)
const cfgArg = process.argv.indexOf("--cfg")
const outArg = process.argv.indexOf("--out")
if (cfgArg < 0 || outArg < 0) { console.error("usage: reco_child --cfg <json> --out <json>"); process.exit(2) }
const cfg = JSON.parse(fs.readFileSync(process.argv[cfgArg + 1], "utf8"))
const out = process.argv[outArg + 1]

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

/** 参数扫描折叠成用例列表（与 CLI 的 --sweep 语义一致）。 */
function casesOf(c) {
  const base = c.param && typeof c.param === "object" ? c.param : {}
  const sweep = c.sweep && typeof c.sweep === "object" ? c.sweep : null
  const cases = []
  if (sweep && typeof sweep.min === "number" && typeof sweep.max === "number") {
    for (let v = sweep.min; v <= sweep.max + 1e-9; v += Math.abs(sweep.step || 1)) {
      cases.push({ ...base, [String(sweep.key || "threshold")]: Math.round(v * 1000) / 1000 })
    }
  } else {
    cases.push(base)
  }
  return cases
}

/** 页面/工具只需要判定信息：像素类字段（draws / raw）一律不带出去。 */
function strip(detail) {
  if (!detail || typeof detail !== "object") return null
  const copy = { ...detail }
  delete copy.draws
  delete copy.raw
  return copy
}

async function main() {
  const maa = require("@maaxyz/maa-node")
  const image = toArrayBuffer(fs.readFileSync(cfg.image))

  const ctrl = new maa.CustomController({
    connect() { return true },
    request_uuid() { return "0" },
    screencap() { return image },
  })
  ctrl.screenshot_use_raw_size = true
  await ctrl.post_connection().wait()
  if (!ctrl.connected) throw new Error("假控制器连接失败")

  const res = new maa.Resource()
  await res.post_bundle(cfg.resourceDir).wait()
  /* 面板裁出来的模板走 override_image：不必把它塞进任何资源目录，也不写用户项目。 */
  if (cfg.templateImage) res.override_image("@reco_template", toArrayBuffer(fs.readFileSync(cfg.templateImage)))

  const tasker = new maa.Tasker()
  tasker.controller = ctrl
  tasker.resource = res

  const cases = casesOf(cfg)
  const results = []
  let slot = null
  let started = Date.now()

  res.register_custom_action("@reco/run", async self => {
    const param = { recognition: cfg.type, ...(slot || {}) }
    if (cfg.templateImage && param.template === undefined) param.template = "@reco_template"
    let detail = null
    try {
      detail = await self.context.run_recognition("@reco/node", image, { "@reco/node": param })
    } catch (e) {
      results.push({ param: slot || {}, ms: Date.now() - started, ok: false, error: String(e && e.message || e), detail: null })
      return true
    }
    results.push({ param: slot || {}, ms: Date.now() - started, ok: !!detail, detail: strip(detail) })
    return true
  })

  try {
    for (const param of cases) {
      slot = param
      started = Date.now()
      await tasker.post_task("@reco/entry", { "@reco/entry": { action: "Custom", custom_action: "@reco/run" } }).wait()
    }
  } finally {
    try { tasker.destroy() } catch (e) { /* ignore */ }
    try { res.destroy() } catch (e) { /* ignore */ }
    try { ctrl.destroy() } catch (e) { /* ignore */ }
  }

  fs.writeFileSync(out, JSON.stringify({ ok: true, type: cfg.type, results }), "utf8")
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    try { fs.writeFileSync(out, JSON.stringify({ ok: false, error: String(e && e.message || e) }), "utf8") } catch (e2) { /* ignore */ }
    process.exit(1)
  })
