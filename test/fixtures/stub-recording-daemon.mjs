#!/usr/bin/env node
/**
 * 记录型桩 daemon：把收到的每条请求逐行写进 `MAAFW_STUB_LOG`，再回一个最小形状。
 *
 * 用途：验证"CLI / REPL 到底往线上发了什么"——不碰设备、不需要 maa-node。
 * 与 `stub-daemon.mjs` 的区别：那个只管协议面（init / stream_stopped），这个**记账**。
 *
 * `MAAFW_STUB_REPLIES`（可选）＝ `{"<cmd>": {…}}`：给指定命令**叠一层**自造回执字段，
 * 用来把"daemon 报了什么"当成输入喂给上层的判据（例如 reco 的 meta.w/h 触发 roi 越界）。
 *
 * `MAAFW_STUB_RULES`（可选）＝ `[{ cmd, when, data }]`：按请求**内容**分支回执（先命中先用），
 * 用来把"同一个命令在不同参数下拿到不同分数"变成可造输入（roi-check 的三个结论靠它）。
 * `data.perCase`（可选）＝ `[{score, hit, box?}, …]`：**按位置**给逐例得分。请求带 `candidates`
 * （`reco_test` 的候选批量通道）时，桩把 perCase 逐例铺成 results[i] 并让 `param.roi` 回自己是
 * 那个候选 —— 于是"逐例换 roi"的顺序不变量可复现，不必真跑模板匹配。
 */
import readline from 'node:readline'
import { appendFileSync } from 'node:fs'

const LOG = process.env.MAAFW_STUB_LOG
if (!LOG) { console.error('需要 MAAFW_STUB_LOG'); process.exit(2) }
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')

let EXTRA = {}
try { EXTRA = JSON.parse(process.env.MAAFW_STUB_REPLIES ?? '{}') } catch { EXTRA = {} }
let RULES = []
try {
  const parsed = JSON.parse(process.env.MAAFW_STUB_RULES ?? '[]')
  if (Array.isArray(parsed)) RULES = parsed
} catch { RULES = [] }

/** when 的键按 `/` 路径下钻（`param.roi.0`、`candidates.0.0`），比较用 `===` 与 JSON 序列化两种口径。 */
function matches(req, when) {
  if (!when || typeof when !== 'object') return false
  for (const [path, want] of Object.entries(when)) {
    const got = path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), req)
    if (!(got === want) && JSON.stringify(got) !== JSON.stringify(want)) return false
  }
  return true
}

/**
 * `data.perCase` → results：**按位置**对应请求的 `candidates`（顺序即契约）。
 * 逐例回 `param.roi` 是自己那个候选 —— 这正是 roi-compare 要钉住的不变量
 * （sweep 是"同键换值"，候选是"逐例换 roi"，形状像而不变量不同）。
 */
function batchResults(req, extra) {
  const cands = Array.isArray(req.candidates) ? req.candidates : null
  if (!cands || !Array.isArray(extra.perCase)) return null
  const baseParam = req.param && typeof req.param === 'object' ? req.param : {}
  return cands.map((roi, i) => {
    const spec = extra.perCase[i] && typeof extra.perCase[i] === 'object' ? extra.perCase[i] : {}
    const score = spec.score === undefined || spec.score === null ? null : Number(spec.score)
    const hit = spec.hit === true
    const box = Array.isArray(spec.box) ? spec.box : (hit ? [10, 10, 20, 10] : [0, 0, 0, 0])
    return {
      param: { ...baseParam, roi },
      ms: 12,
      ok: hit,
      detail: {
        name: '@reco/node', algorithm: 'TemplateMatch', hit, box,
        detail: {
          all: score === null ? [] : [{ box, score }],
          best: hit && score !== null ? { box, score } : null,
          filtered: [],
        },
      },
    }
  })
}

/** 只给调用方真正会读字段的命令一个像样的回执，其余 `{ok:true}` 即可 */
const SHAPES = {
  init: { previewPath: null, daemonId: 'stub-recording', framesDir: '/tmp/stub/frames', kfQuota: 0 },
  connect: {
    ok: true,
    session: { kind: 'adb', target: 'stub-target', cls: null, method: 'adb', resolution: { w: 1280, h: 720 }, warns: [] },
  },
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let m = null
  try { m = JSON.parse(line) } catch { return }
  if (!m || typeof m.cmd !== 'string') return
  appendFileSync(LOG, JSON.stringify(m) + '\n')
  if (m.cmd === 'shutdown') process.exit(0)
  const base = SHAPES[m.cmd] ?? { ok: true }
  const rule = RULES.find((r) => r && r.cmd === m.cmd && matches(m, r.when))
  const extra = rule ? rule.data : EXTRA[m.cmd]
  const merged = extra && typeof extra === 'object' ? { ...base, ...extra } : base
  const batch = extra && typeof extra === 'object' ? batchResults(m, extra) : null
  if (batch) merged.results = batch
  delete merged.perCase
  send({ kind: 'reply', id: m.id, ok: true, data: merged })
})
