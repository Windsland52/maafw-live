/**
 * daemon 协议单一事实来源的一致性钉（P1-#5）：三份清单必须互相对得上——
 *   ① framed.mjs 的 `handlers` 表（协议真身，收到什么 cmd 就路由到哪）
 *   ② docs/daemon-protocol.md 的命令表（对外契约，复用宿主按它写）
 *   ③ actions.ts 的 `.call('name')` 封装（本仓消费端）
 *
 * 为什么钉代码不钉文档："新增命令记得更新文档"是口头约定，文档漂移的唯一拦截网是
 * 机械对账——命令加了没进文档、封装调了没注册 handler、文档写了没实现，都会在 CI 当场红。
 *
 * 规则：
 *   - 文档表是**全集**：handlers 与 doc 必须一一相等（含 `ping`/`shutdown`/`init`——
 *     复用宿主也需要这三条的生命周期语义）。
 *   - actions 封装是**子集**：每条 `.call` 目标必须有 handler；但 handlers 不必然有封装
 *     （`init`/`shutdown` 走客户端自己的握手/关闭通道，`ping` 是探活内部件）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DAEMON = join(ROOT, 'src', 'daemon', 'framed.mjs')
const DOC = join(ROOT, 'docs', 'daemon-protocol.md')
const ACTIONS = join(ROOT, 'src', 'runtime', 'actions.ts')

/** handlers 对象的键（两行缩进一层 `key:`；跳过注释行） */
function handlerKeys() {
  const src = readFileSync(DAEMON, 'utf8')
  const m = src.match(/const handlers = \{([\s\S]*?)\n\}/)
  assert.ok(m, 'framed.mjs 找不到 handlers 表')
  const keys = []
  for (const line of m[1].split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('/*') || t.startsWith('//') || t.startsWith('*')) continue
    const k = t.match(/^([A-Za-z_]\w*)\s*:/)
    if (k) keys.push(k[1])
  }
  return keys
}

/** 文档命令表的 cmd 列（第一个 `|` 后的反引号 token；跳过 `{...}` 消息形状行） */
function docCommands() {
  const src = readFileSync(DOC, 'utf8')
  const cmds = []
  for (const line of src.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.split('|').map((c) => c.trim()).filter(Boolean)
    if (!cells.length) continue
    const first = cells[0]
    if (first.startsWith('{')) continue           /* `{ id, cmd,... }` 是消息形状行，不是命令行 */
    if (first.startsWith('cmd') || first === '---') continue   /* 表头 */
    for (const mm of first.matchAll(/`([^`]+)`/g)) {
      const tok = mm[1].trim()
      /* `stream_stop / stream_status` 一行两命令：各自算数 */
      for (const name of tok.split(/\s*\/\s*/)) {
        if (/^[A-Za-z_]\w*$/.test(name)) cmds.push(name)
      }
    }
  }
  return cmds
}

/** actions.ts 里 `.call<...>('name'` 的目标命令名（泛型可嵌套，如 `Record<string, unknown>>`） */
function actionCalls() {
  const src = readFileSync(ACTIONS, 'utf8')
  const names = []
  for (const mm of src.matchAll(/\.call(<[^'(]*>)?\(\s*'([A-Za-z_]\w*)'/g)) names.push(mm[2])
  return [...new Set(names)]
}

const handlers = handlerKeys().sort()
const doc = [...new Set(docCommands())].sort()
const called = actionCalls().sort()

test('协议契约：framed.mjs 的 handlers 与 daemon-protocol.md 命令表一一相等', () => {
  assert.deepEqual(handlers, doc,
    'handlers 与文档命令表必须互相对得上。\n' +
    '只在 handlers：' + JSON.stringify(handlers.filter((h) => !doc.includes(h))) + '\n' +
    '只在文档：' + JSON.stringify(doc.filter((d) => !handlers.includes(d))) + '\n' +
    '新增命令记得同步 docs/daemon-protocol.md 的命令表。')
})

test('协议契约：actions.ts 每条 .call 都有 handlers 表里的真身', () => {
  const missing = called.filter((c) => !handlers.includes(c))
  assert.deepEqual(missing, [],
    'actions.ts 调了未注册的命令：' + JSON.stringify(missing))
})

test('协议契约：actions.ts 的封装覆盖了所有"业务命令"（除 init/shutdown/ping 这三条生命周期件）', () => {
  /* init 走客户端握手、shutdown 走 close、ping 是探活——这三条在客户端里不走 actions 封装。 */
  const lifecycle = new Set(['init', 'shutdown', 'ping'])
  const uncovered = handlers.filter((h) => !lifecycle.has(h) && !called.includes(h))
  assert.deepEqual(uncovered, [],
    '这些 daemon 命令没有 actions.ts 封装（新增命令记得补）：' + JSON.stringify(uncovered))
})
