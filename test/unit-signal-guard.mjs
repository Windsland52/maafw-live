/**
 * run 信号守卫（审计 #6）：Windows 没法跨进程投 Ctrl-C，所以守卫被抽成
 * installRunSignalGuard——process.emit('SIGINT') 同步触发监听，单测只验
 * 「旗标立了、run_stop 发了、钩子摘了」，真机路径靠 daemon 的 onHostGone
 * 与 run_stop → stopped:true 各管一段。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { installRunSignalGuard } from '../lib/runtime/signal-guard.js'

test('SIGINT：立旗 130 且向 daemon 发 run_stop', async () => {
  let stopCalls = 0
  const g = installRunSignalGuard(async () => { stopCalls++ })
  try {
    assert.equal(g.code, 0, '装钩子前无中断')
    process.emit('SIGINT')
    assert.equal(g.code, 130)
    await new Promise((r) => setImmediate(r))   // runStop 是 fire-and-forget，让一拍
    assert.equal(stopCalls, 1, '只发一次 run_stop')
  } finally { g.restore() }
})

test('SIGTERM：立旗 143（128+signo）', () => {
  const g = installRunSignalGuard(async () => {})
  try {
    process.emit('SIGTERM')
    assert.equal(g.code, 143)
  } finally { g.restore() }
})

test('run_stop 失败不炸：旗标仍立（daemon 已死的现场不再等）', async () => {
  const g = installRunSignalGuard(async () => { throw new Error('daemon gone') })
  try {
    process.emit('SIGINT')
    assert.equal(g.code, 130)
    await new Promise((r) => setImmediate(r))
  } finally { g.restore() }
})

test('restore 摘钩：之后再 emit 不再触发 run_stop', async () => {
  let stopCalls = 0
  const g = installRunSignalGuard(async () => { stopCalls++ })
  const code = g.restore()
  assert.equal(code, 0)
  process.emit('SIGINT')          // 监听已摘，进程默认行为不存在（测试上下文不退出）
  await new Promise((r) => setImmediate(r))
  assert.equal(stopCalls, 0)
})
