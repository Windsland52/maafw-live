/**
 * setupAgents 的 sink 注册（headless 单测，无 --child、无设备、无真 maa）。
 *
 * 回归的是 2026-11-07 M9A 8-bit 适配会话撞出的真 bug：桥接只 bind_resource，
 * agent 侧 context.tasker.controller 的 reverse request 带空 controller_id →
 * "controller not found"，custom action 的 post_click/post_screencap 静默失败。
 * 修复 = connect() 之前注册 resource/controller/tasker 三个 sink。
 *
 * 这里用假 Client 记录调用顺序，断言 sink 必须在 bind_resource 之后、connect 之前。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { __test } from '../src/daemon/framed.mjs'

const { setupAgents, S } = __test

/** 假 maa 模块：Client 记录调用序列，connect 前把已注册 sink 存进 calls */
function fakeMaa(calls) {
  class FakeClient {
    constructor() { this._calls = calls; this._ident = 'stub-ident' }
    get identifier() { return this._ident }
    bind_resource(res) { this._calls.push(['bind_resource', res]) }
    register_resource_sink(o) { this._calls.push(['register_resource_sink', o]) }
    register_controller_sink(o) { this._calls.push(['register_controller_sink', o]) }
    register_tasker_sink(o) { this._calls.push(['register_tasker_sink', o]) }
    connect() { this._calls.push(['connect']); return Promise.resolve() }
    disconnect() { this._calls.push(['disconnect']) }
    destroy() {}
    get connected() { return true }
    get alive() { return true }
    set timeout(ms) { this._calls.push(['timeout', ms]) }
    get custom_action_list() { return ['ActA'] }
    get custom_recognition_list() { return ['RecoB'] }
  }
  return { Client: FakeClient }
}

/** 假 spawn：回一个可 kill 的 EventEmitter 子进程 */
function fakeSpawnFactory(calls) {
  return (exec, argv, opts) => {
    calls.push(['spawn', exec, argv])
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => { calls.push(['kill', exec]) }
    return child
  }
}

async function reset() {
  /* S.agentBind 会跨用例留着上一次绑定的对象；每个用例开始前置空，避免 reuse 分支 */
  S.agentBind = null
}

test('agent 桥接：三个 sink 在 bind_resource 之后、connect 之前注册', async () => {
  await reset()
  const calls = []
  const fakeRes = { tag: 'res' }
  const fakeCtrl = { tag: 'ctrl' }
  const fakeTasker = { tag: 'tasker' }
  const r = await setupAgents(fakeRes, [{ exec: 'python', args: ['agent/main.py'] }], 'cwd', null,
    { resource: fakeRes, controller: fakeCtrl, tasker: fakeTasker },
    fakeMaa(calls), fakeSpawnFactory(calls))

  assert.equal(r.ok, true)
  const names = calls.map((c) => c[0])
  const iBind = names.indexOf('bind_resource')
  const iConnect = names.indexOf('connect')
  const iRes = names.indexOf('register_resource_sink')
  const iCtrl = names.indexOf('register_controller_sink')
  const iTask = names.indexOf('register_tasker_sink')
  assert.ok(iBind >= 0 && iConnect > iBind, 'connect 必须在 bind 之后')
  assert.ok(iRes > iBind && iRes < iConnect, 'resource sink 要在 connect 前')
  assert.ok(iCtrl > iBind && iCtrl < iConnect, 'controller sink 要在 connect 前')
  assert.ok(iTask > iBind && iTask < iConnect, 'tasker sink 要在 connect 前')
  /* identifier 要作为末位参数传给子进程（agent 侧 sys.argv[-1]） */
  const sp = calls.find((c) => c[0] === 'spawn')
  assert.deepEqual(sp[2].slice(-1), ['stub-ident'])
  /* 回执如实报告已注册 sink */
  assert.deepEqual(r.sinks.registered.sort(), ['controller', 'resource', 'tasker'])
  assert.equal(r.sinks.errors.length, 0)
  assert.deepEqual(r.actions, ['ActA'])
})

test('agent 桥接：某个 sink 注册抛错不阻断，但回执必须点名', async () => {
  await reset()
  const calls = []
  const m = fakeMaa(calls)
  const orig = m.Client.prototype
  /* 让 controller sink 抛错：模拟绑定不支持该 sink 的老版本 */
  class FlakyClient extends m.Client {
    register_controller_sink(o) { throw new Error('binding lacks register_controller_sink') }
  }
  const flaky = { Client: FlakyClient }
  const r = await setupAgents({ tag: 'res' }, [{ exec: 'python', args: ['a.py'] }], 'cwd', null,
    { resource: { tag: 'res' }, controller: { tag: 'c' }, tasker: { tag: 't' } },
    flaky, fakeSpawnFactory(calls))
  assert.equal(r.ok, true, 'sink 单点失败不该让桥接整体失败')
  assert.deepEqual(r.sinks.registered.sort(), ['resource', 'tasker'])
  assert.equal(r.sinks.errors.length, 1)
  assert.match(r.sinks.errors[0], /controller/)
})

test('agent 桥接：connect 后 connected/alive 为假按失败报（协议错配）', async () => {
  await reset()
  const calls = []
  class DeadClient extends fakeMaa(calls).Client {
    get connected() { return false }
    get alive() { return false }
  }
  const r = await setupAgents({ tag: 'res' }, [{ exec: 'python', args: ['a.py'] }], 'cwd', null,
    { resource: { tag: 'res' }, controller: { tag: 'c' }, tasker: { tag: 't' } },
    { Client: DeadClient }, fakeSpawnFactory(calls))
  assert.equal(r.ok, false)
  assert.match(r.error, /握手被拒|版本错配|连接失败/)
})
