/**
 * reco_child —— 识别单测的一次性子进程（崩溃隔离）。
 * 用法：node reco_child.mjs --cfg <json> --out <result.json>
 * cfg = { resourceDir, type, image, cases: [param,...] }
 * 崩溃时结果文件缺失，父进程据此报告失败。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const cfgArg = process.argv.indexOf('--cfg')
const outArg = process.argv.indexOf('--out')
if (cfgArg < 0 || outArg < 0) { console.error('usage: reco_child --cfg <json> --out <json>'); process.exit(2) }
const cfg = JSON.parse(fs.readFileSync(process.argv[cfgArg + 1], 'utf8'))
const out = process.argv[outArg + 1]

async function main() {
  const maa = require('@maaxyz/maa-node')
  const res = new maa.Resource()
  await res.post_bundle(cfg.resourceDir).wait()
  const tasker = new maa.Tasker()
  tasker.resource = res
  const image = new Uint8Array(fs.readFileSync(cfg.image)).buffer
  const results = []
  for (const param of cfg.cases) {
    const t0 = Date.now()
    const job = tasker.post_recognition(cfg.type, param, image)
    await job.wait()
    const ok = job.status === 3000
    let detail = null
    try { detail = tasker.recognition_detail(Number(job.id)) } catch (e) { /* ignore */ }
    results.push({ param, ms: Date.now() - t0, ok, detail: detail || null })
  }
  fs.writeFileSync(out, JSON.stringify({ ok: true, type: cfg.type, results }), 'utf8')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    try { fs.writeFileSync(out, JSON.stringify({ ok: false, error: String(e && e.message || e) }), 'utf8') } catch (e2) { /* ignore */ }
    process.exit(1)
  })
