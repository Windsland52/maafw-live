/**
 * reco_child —— 识别单测的一次性子进程（崩溃隔离）。
 * 用法：node reco_child.mjs --cfg <json> --out <result.json>
 * cfg = { resourceDirs? | resourceDir, type, image, cases?, node?, nodeName?, templateImage? }
 *   cases: 父进程（framed.mjs）已折叠好的参数用例列表，逐例执行
 *   node : 整节点 JSON 原样透传（V1 扁平 / V2 嵌套均支持，不转换）
 *   nodeName: 按资源里的原名跑（不 dump 注入——dump 是缺省填满的 V2，与手写稀疏 V1 不是同一份）
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

function writeOut(payload) {
  fs.writeFileSync(out, JSON.stringify(payload), "utf8")
}

/** dump 里的识别类型：V2 是 `recognition.type`，个别版本/形态可能还是 V1 的字符串。 */
function recoTypeOf(dump) {
  const rec = dump && dump.recognition
  if (typeof rec === "string") return rec
  if (rec && typeof rec === "object") return String(rec.type ?? "")
  return ""
}

function editDistance(a, b) {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/**
 * 近邻节点名：命令拼错会给建议，节点名拼错同样要给——否则 `--node-name` 写错一个字只会得到
 * "资源里没有这个节点"，而正确名字就在资源里。距离阈值随名字长度放宽（长名的单个字符笔误
 * 距离仍是 1；短名放宽到 2 就够，再宽会把无关节点列出来）。
 */
function nearestNames(names, target, limit) {
  const want = String(target)
  const cap = Math.max(2, Math.min(4, Math.floor(want.length / 3)))
  const scored = []
  for (const n of Array.isArray(names) ? names : []) {
    if (typeof n !== "string" || !n || n === want) continue
    const d = editDistance(n.toLowerCase(), want.toLowerCase())
    if (d <= cap) scored.push({ n, d })
  }
  return scored.sort((x, y) => x.d - y.d || x.n.localeCompare(y.n)).slice(0, limit).map((x) => x.n)
}

/**
 * dump 里的 Custom 识别：顶层 `type: "Custom"` / V1 的 `custom_recognition`，**以及 And / Or 里嵌的
 * 子识别**。只看顶层会让"And 里挂了一个 custom 子识别"落回 miss 或"识别调用报错"，看起来像没命中，
 * 而它其实和顶层 custom 是同一条能力边界（reco_test 不桥接 agent 子进程）。
 * 返回命中位置（便于在报错里说清是哪一层），深度与条数都封顶，避免异常 dump 撑爆回执。
 */
function customHits(dump) {
  const hits = []
  const walk = (v, path, depth) => {
    if (hits.length >= 8 || depth > 6 || v === null || v === undefined) return
    if (typeof v === "string") {
      /* V1 形态：dump 正常是 V2 对象，但 `recognition: "Custom"` 这种字符串形态不能漏 */
      if (v === "Custom") hits.push(path)
      return
    }
    if (typeof v !== "object") return
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, path + "[" + i + "]", depth + 1))
      return
    }
    if (typeof v.type === "string" && v.type === "Custom") { hits.push(path + ".type"); return }
    if (v.custom_recognition !== undefined) { hits.push(path + ".custom_recognition"); return }
    for (const [k, x] of Object.entries(v)) walk(x, path === "" ? k : path + "." + k, depth + 1)
  }
  walk(dump && dump.recognition, "recognition", 0)
  return hits
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

  /* 资源链：interface.json 的 resource.path[]（+ 控制器 attach_resource_path）按声明顺序叠加，
   * 后一段覆盖前一段——与 cmdRun 的 buildResource 同一语义。只加载单包时，overlay 包里的节点改写、
   * 只存在于 overlay 的模板、被 And/Or 按名引用的子节点全部缺失，测出来的就不是项目里那个节点。 */
  const dirs = Array.isArray(cfg.resourceDirs) && cfg.resourceDirs.length
    ? cfg.resourceDirs.map(String)
    : [String(cfg.resourceDir)]
  const res = new maa.Resource()
  for (const d of dirs) await res.post_bundle(d).wait()
  /* 面板裁出来的模板走 override_image：不必把它塞进任何资源目录，也不写用户项目。 */
  if (cfg.templateImage) res.override_image("@reco_template", toArrayBuffer(fs.readFileSync(cfg.templateImage)))

  const tasker = new maa.Tasker()
  tasker.controller = ctrl
  tasker.resource = res

  const nodeMode = cfg.node !== undefined
  const nodeNameMode = typeof cfg.nodeName === "string" && cfg.nodeName !== ""
  const node = nodeMode ? nodeEntry(cfg.node, cfg.templateImage) : null
  /* --node-name：dump 只进回执给人看，**不注入识别**。dump 是 DumpTask（V2 嵌套 + 缺省值全部
   * 填满），与手写稀疏 V1 JSON 不是同一份；dump 再注入会让"测的到底是不是真节点"多一层不确定性。 */
  let nodeDump = null
  if (nodeNameMode) {
    nodeDump = res.get_node_data_parsed(cfg.nodeName)
    if (!nodeDump) {
      const candidates = nearestNames(res.node_list, cfg.nodeName, 3)
      writeOut({
        ok: false, code: "NODE_MISSING", nodeName: cfg.nodeName, resourceDirs: dirs,
        ...(candidates.length ? { candidates } : {}),
        error: "资源里没有名为 " + cfg.nodeName + " 的节点（只查资源合并结果，不含 interface 的 pipeline_override）",
      })
      return
    }
    /* custom / agent 节点：reco_test 不桥接 agent 子进程（run 才桥接），明确报能力边界而不是让它看起来像 miss。
     * And / Or 里嵌的子识别同样算——它们会在 run_recognition 里被真的走到。 */
    const customs = customHits(nodeDump)
    if (customs.length > 0) {
      const onlyTop = customs.length === 1 && customs[0] === "recognition.type"
      writeOut({
        ok: false, code: "CUSTOM_NODE", nodeName: cfg.nodeName, nodeDump, resourceDirs: dirs, customPaths: customs,
        error: onlyTop
          ? "节点 " + cfg.nodeName + " 的识别是 Custom：reco_test 不桥接 custom/agent 识别（run --project 才桥接 agent 子进程）"
          : "节点 " + cfg.nodeName + " 的识别含 Custom 子识别（" + customs.length + " 处："
            + customs.slice(0, 3).join(" / ") + (customs.length > 3 ? " …" : "")
            + "）：reco_test 不桥接 custom/agent 识别（run --project 才桥接 agent 子进程）",
      })
      return
    }
  }
  const cases = nodeMode || nodeNameMode ? [node] : casesOf(cfg)
  const results = []
  let slot = null
  let started = Date.now()

  res.register_custom_action("@reco/run", async self => {
    /* 入口三形态：--node-name 用资源原名（无 override）；--node 原样透传；--type 用折叠好的一例参数。
     * param 只用于回执展示"测的是哪个/组参数"。 */
    let param = null
    let detail = null
    try {
      if (nodeNameMode) {
        param = { nodeName: cfg.nodeName }
        detail = await self.context.run_recognition(cfg.nodeName, image)
      } else {
        const entry = nodeMode ? node : { recognition: cfg.type, ...(slot || {}) }
        if (!nodeMode && cfg.templateImage && entry.template === undefined) entry.template = "@reco_template"
        param = entry
        detail = await self.context.run_recognition("@reco/node", image, { "@reco/node": entry })
      }
    } catch (e) {
      results.push({ param, ms: Date.now() - started, ok: false, error: String(e && e.message || e), detail: null })
      return true
    }
    /* ok 只认 hit===true：miss 时 run_recognition 仍返回 detail 对象（hit:false、box 全零），
     * 旧判 !!detail 恒真——识别未中会标成命中，制造假观测证据。 */
    results.push({ param, ms: Date.now() - started, ok: !!detail && detail.hit === true, detail: strip(detail) })
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

  writeOut({
    ok: true,
    ...(nodeNameMode ? { type: recoTypeOf(nodeDump), nodeName: cfg.nodeName, nodeDump } : { type: cfg.type }),
    results,
  })
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    try { fs.writeFileSync(out, JSON.stringify({ ok: false, error: String(e && e.message || e) }), "utf8") } catch (e2) { /* ignore */ }
    process.exit(1)
  })
