/**
 * reco_child —— 识别单测的一次性子进程（崩溃隔离）。
 * 用法：node reco_child.mjs --cfg <json> --out <result.json>
 * cfg = { resourceDir, type, image, cases?, node?, templateImage? }
 *   cases: 父进程（framed.mjs）已折叠好的参数用例列表，逐例执行
 *   node : 整节点 JSON 原样透传（V1 扁平 / V2 嵌套均支持，不转换）
 *   param/sweep: 直接调用（调试）时的单例路径，与 cases 二选一
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

/** 参数扫描折叠成用例列表（与 CLI 的 --sweep 语义一致；step 带方向）。 */
function casesOf(c) {
  /* 父进程路径：cases 已折好，逐例透传——子进程不再自行折叠，避免两边语义分叉 */
  if (Array.isArray(c.cases) && c.cases.length) {
    return c.cases.filter((p) => p && typeof p === "object")
  }
  const base = c.param && typeof c.param === "object" ? c.param : {}
  const sweep = c.sweep && typeof c.sweep === "object" ? c.sweep : null
  const cases = []
  if (sweep && typeof sweep.min === "number" && typeof sweep.max === "number") {
    const step = sweep.step !== undefined && Number(sweep.step) !== 0 ? Number(sweep.step) : 1
    const up = step > 0
    for (let v = sweep.min; up ? v <= sweep.max + 1e-9 : v >= sweep.max - 1e-9; v += step) {
      cases.push({ ...base, [String(sweep.key || "threshold")]: Math.round(v * 1000) / 1000 })
    }
  } else {
    cases.push(base)
  }
  return cases
}

/**
 * --node 整节点透传的入口构造：不做 V1/V2 互转，框架的 pipeline 解析两种形态都认识。
 * 只在"模板由调用方图像提供"（override_image）且节点自己没写模板时补一个模板引用，
 * 补的位置按节点形态放（V1 顶层 / V2 recognition.param 内），其余字段一律原样。
 */
function nodeEntry(node, templateImage) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new Error("--node 必须是 JSON 对象（pipeline 节点）")
  }
  const rec = node.recognition
  const v2 = rec && typeof rec === "object" && !Array.isArray(rec)
  if (rec === undefined || (typeof rec !== "string" && !v2)) {
    throw new Error("--node 缺少可用的 recognition 字段（V1 字符串或 V2 {type,param}）")
  }
  if (!templateImage) return node
  if (v2) {
    const param = rec.param && typeof rec.param === "object" ? rec.param : {}
    if (param.template !== undefined) return node
    return { ...node, recognition: { ...rec, param: { ...param, template: "@reco_template" } } }
  }
  if (node.template !== undefined) return node
  return { ...node, template: "@reco_template" }
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

  const nodeMode = cfg.node !== undefined
  const node = nodeMode ? nodeEntry(cfg.node, cfg.templateImage) : null
  const cases = nodeMode ? [node] : casesOf(cfg)
  const results = []
  let slot = null
  let started = Date.now()

  res.register_custom_action("@reco/run", async self => {
    const entry = nodeMode ? node : { recognition: cfg.type, ...(slot || {}) }
    if (!nodeMode && cfg.templateImage && entry.template === undefined) entry.template = "@reco_template"
    let detail = null
    try {
      detail = await self.context.run_recognition("@reco/node", image, { "@reco/node": entry })
    } catch (e) {
      results.push({ param: entry, ms: Date.now() - started, ok: false, error: String(e && e.message || e), detail: null })
      return true
    }
    /* ok 只认 hit===true：miss 时 run_recognition 仍返回 detail 对象（hit:false、box 全零），
     * 旧判 !!detail 恒真——识别未中会标成命中，制造假观测证据。 */
    results.push({ param: entry, ms: Date.now() - started, ok: !!detail && detail.hit === true, detail: strip(detail) })
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
