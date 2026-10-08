/**
 * 外部命令执行的单测（headless）。
 *
 * 这里钉的是**契约**而不是实现：`run()` 永不抛异常——缺 adb、缺 python、缺 git 都是探测结果，
 * 不是异常路径。回归背景：Windows 上 `.cmd` 被直接交给 execFile 时 Node 会**同步**抛 EINVAL
 * （CVE-2024-27980 的修复），当时那条 `.cmd` 重试没有兜住同步抛，导致 `env` 在只缺 adb 的
 * 机器/runner 上整条命令以 UNEXPECTED 失败（装配回归里表现为 [4] 三条 + [5] 一起红）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { run, firstLine } from '../lib/exec.js'

test('正常的命令：ok=true 且带 stdout', async () => {
  const r = await run(process.execPath, ['--version'], { timeout: 15000 })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.match(firstLine(r.stdout), /^v\d+\./)
})

test('不存在的命令：resolve 成失败结果，绝不 reject', async () => {
  const r = await run('maafw-live-definitely-not-a-command-xyz', ['--version'], { timeout: 5000 })
  assert.equal(r.ok, false)
  assert.equal(r.code, null, '启动失败没有退出码')
  assert.ok(r.spawnError, '要给出启动失败原因：' + JSON.stringify(r))
})

test('显式 .cmd：同样只报失败，不抛（这条曾让整条命令炸掉）', async () => {
  const r = await run('maafw-live-definitely-not-a-command-xyz.cmd', [], { timeout: 5000 })
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.ok(r.spawnError, '应给出 spawnError：' + JSON.stringify(r))
})

test('退出码非 0 与启动失败要分开报', async () => {
  const r = await run(process.execPath, ['-e', 'process.exit(7)'], { timeout: 15000 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 7, '跑起来了但退出 7 → code=7，spawnError 应为空：' + JSON.stringify(r))
  assert.equal(r.spawnError, undefined)
})

test('npm：Windows 上走 .cmd 重试且必须成功（run 的真实使用者）', async () => {
  const r = await run('npm', ['--version'], { timeout: 20000 })
  if (process.platform !== 'win32') {
    assert.equal(r.ok, true, JSON.stringify(r))
    return
  }
  /* Windows：npm 是 npm.cmd，重试路径经 shell 执行；拿不到就说明重试又坏了 */
  assert.equal(r.ok, true, 'npm 探测失败（.cmd 重试路径）: ' + JSON.stringify(r))
  assert.match(firstLine(r.stdout), /^\d+\.\d+\.\d+/)
})
