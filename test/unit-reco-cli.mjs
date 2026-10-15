/**
 * 一次性 CLI `reco` 的判据面（桩 daemon，无设备）：
 *
 * 1. **roi 越界**要被拦成明确错误（FINDINGS=3），而不是把"未命中"当结论；
 * 2. 无置信度的回执里，提示语要把 **roi 空间**列为首要疑因（旧文案只说"模板/资源没读到"，
 *    实测因此去查了资源目录、浪费一轮 —— G16 的 B 组）。
 *
 * 用 `MAAFW_STUB_REPLIES` 给桩 daemon 指定 reco_test 的回执，把"daemon 会报什么"变成可造输入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'maafw-live.mjs')
const STUB = join(HERE, 'fixtures', 'stub-recording-daemon.mjs')

/** 跑一次一次性 CLI 命令（桩 daemon），返回 {code, out, err} */
function runCli(args, replies) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        MAA_DAEMON: STUB,
        MAAFW_STUB_LOG: join(tmpdir(), 'maafw-stub-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.jsonl'),
        ...(replies ? { MAAFW_STUB_REPLIES: JSON.stringify(replies) } : {}),
        MAAFW_LIVE_NO_UPDATE_CHECK: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } reject(new Error('30s 未退出')) }, 30000)
    child.on('exit', (c) => { clearTimeout(timer); resolve({ code: c, out, err }) })
  })
}

const IMAGE = join(HERE, 'fixtures', 'README.md')   // 只作存在性占位：桩 daemon 不读它

test('CLI reco：roi 越出图像尺寸 → FINDINGS(3) 且明确说"用错空间"', async () => {
  const { code, err } = await runCli(
    ['reco', '--type', 'TemplateMatch', '--resource-dir', HERE, '--image', IMAGE,
      '--param', '{"template":"x.png","roi":[558,68,140,43]}'],
    { reco_test: { meta: { source: IMAGE, w: 480, h: 270 }, results: [{ param: { roi: [558, 68, 140, 43] }, ms: 9, ok: false }] } },
  )
  assert.equal(code, 3, 'FINDINGS：跑成了但发现问题。stdout/stderr：' + err)
  assert.match(err, /roi 越出图像/, err)
  assert.match(err, /480x270/, err)
})

test('CLI reco：roi 在界内 → 不拦，照常给结果与阈值建议', async () => {
  const { code, out } = await runCli(
    ['reco', '--type', 'TemplateMatch', '--resource-dir', HERE, '--image', IMAGE,
      '--param', '{"template":"x.png","roi":[0,0,100,50]}'],
    {
      reco_test: {
        meta: { source: IMAGE, w: 480, h: 270 },
        results: [{
          param: { roi: [0, 0, 100, 50] }, ms: 9, ok: true,
          detail: { detail: { all: [{ box: [1, 2, 3, 4], score: 0.97 }], best: { box: [1, 2, 3, 4], score: 0.97 } } },
        }],
      },
    },
  )
  assert.equal(code, 0, out)
  assert.match(out, /\[命中\]/, out)
  assert.match(out, /threshold 起点建议 0\.87/, out)
})

test('CLI reco：零置信度回执 → 提示语把 roi 空间列为首要疑因', async () => {
  const { code, out } = await runCli(
    ['reco', '--type', 'TemplateMatch', '--resource-dir', HERE, '--image', IMAGE,
      '--param', '{"template":"x.png","roi":[0,0,100,50]}'],
    { reco_test: { meta: { source: IMAGE, w: 480, h: 270 }, results: [{ param: { roi: [0, 0, 100, 50] }, ms: 230, ok: false }] } },
  )
  /* 退出码仍 0：这是 daemon 回 `ok:true` 的既有口径（"跑了、每例未中"不算命令失败），
   * 本用例只钉提示语；识别类命令的退出码语义不在本次修复面内。 */
  assert.equal(code, 0, out)
  assert.match(out, /识别未返回任何置信度/, out)
  assert.ok(out.includes('roi 是否越出所用图的尺寸'), '首要疑因要是 roi 空间：' + out)
  assert.ok(out.indexOf('roi 是否越出') < out.indexOf('模板/资源'), 'roi 要先于"模板读不到"出现：' + out)
})
