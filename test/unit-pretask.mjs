/**
 * pretask：连 Controller 之前跑的子进程（PI v2.7.0+）。
 *
 * 参数形状错了就是"脚本收到了奇怪的参数但没人报错"，退出码处理错了就是"前置没做完照样启动"——
 * 两件事都必须离线钉住。执行部分用 node 自己当被调程序，不依赖 python。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadInterface } from '../lib/interface/load.js'
import { buildPretaskArgv, runPretasks } from '../lib/runtime/pretask.js'

const mkLoaded = (over = {}) => ({
  file: '/x/interface.json', dir: os.tmpdir(), version: 2, projectVersion: null, name: 'ut',
  controllers: [], resources: [], tasks: [], options: {}, presets: [], globalOption: [],
  pretask: [], agents: [], problems: [],
  ...over,
})

const mkVals = (over = {}) => ({ controllerName: 'C1', resourceName: 'R1', valueCtx: {}, ...over })

test('argv = exec + args + 单个末位 JSON（select→串、checkbox→数组、input→对象）', () => {
  const loaded = mkLoaded({
    options: {
      sel: { name: 'sel', type: 'select', cases: [{ name: '清理缓存' }], defaultCase: '清理缓存' },
      chk: { name: 'chk', type: 'checkbox', cases: [{ name: 'a' }, { name: 'b' }], defaultCase: ['a', 'b'] },
      inp: { name: 'inp', type: 'input', cases: [], inputs: [{ name: '章节号', default: '4' }] },
    },
  })
  const p = { exec: 'python', args: ['./scripts/prepare.py', '--before-controller'], option: ['sel', 'chk', 'inp'] }
  const { argv, warns } = buildPretaskArgv(p, loaded, mkVals())
  assert.deepEqual(warns, [])
  assert.deepEqual(argv.slice(0, 3), ['python', './scripts/prepare.py', '--before-controller'])
  assert.equal(argv.length, 4, '末位 JSON 必须是**单个** argv 元素')
  assert.deepEqual(JSON.parse(argv[3]), { sel: '清理缓存', chk: ['a', 'b'], inp: { 章节号: '4' } })
})

test('option 为空/缺省 → 不追加 JSON 参数', () => {
  const loaded = mkLoaded()
  assert.deepEqual(buildPretaskArgv({ exec: 'x', args: [], option: [] }, loaded, mkVals()).argv, ['x'])
  assert.deepEqual(buildPretaskArgv({ exec: 'x', args: ['a'], option: [] }, loaded, mkVals()).argv, ['x', 'a'])
})

test('CLI 按次取值进末位 JSON；未定义的 option 键告警而不是静默省略', () => {
  const loaded = mkLoaded({
    options: {
      sel: { name: 'sel', type: 'select', cases: [{ name: 'a' }, { name: 'b' }], defaultCase: 'a' },
      inp: { name: 'inp', type: 'input', cases: [], inputs: [{ name: 'n', default: '1' }] },
    },
  })
  const p = { exec: 'x', args: [], option: ['sel', 'inp', 'ghost'] }
  const { argv, warns } = buildPretaskArgv(p, loaded, mkVals({
    valueCtx: { optionCases: { sel: 'b' }, optionFields: { inp: { n: '7' } } },
  }))
  assert.deepEqual(JSON.parse(argv[1]), { sel: 'b', inp: { n: '7' } })
  assert.ok(warns.some((w) => w.includes('ghost')), JSON.stringify(warns))
})

test('取值不是已声明的 case → 告警且不写进 JSON（别让脚本按错配置跑）', () => {
  const loaded = mkLoaded({ options: { sel: { name: 'sel', type: 'select', cases: [{ name: 'a' }], defaultCase: 'a' } } })
  const { argv, warns } = buildPretaskArgv({ exec: 'x', args: [], option: ['sel'] }, loaded, mkVals({
    valueCtx: { optionCases: { sel: 'nope' } },
  }))
  assert.deepEqual(argv, ['x'], '没有可取的值就不追加 JSON')
  assert.ok(warns.some((w) => w.includes('nope') && w.includes('不是已声明的 case')), JSON.stringify(warns))
})

test('runPretasks：成功时按声明序执行，子进程真的收到参数', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-pretask-'))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const script = path.join(dir, 'dump.mjs')
  const out = path.join(dir, 'argv.json')
  fs.writeFileSync(script, "import fs from 'node:fs';fs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))")
  const loaded = mkLoaded({
    dir,
    pretask: [{ exec: process.execPath, args: [script, out], option: [] }],
  })
  const r = await runPretasks({ loaded, controllerName: 'C1', resourceName: null })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.ran.length, 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), [], 'exec 之后的 args 原样到达子进程')
})

test('runPretasks：非零退出 → 中止并如实报退出码与输出尾部', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-pretask-fail-'))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const script = path.join(dir, 'boom.mjs')
  fs.writeFileSync(script, "console.error('前置条件没满足');process.exit(3)")
  const loaded = mkLoaded({ dir, pretask: [{ exec: process.execPath, args: [script], option: [] }] })
  const r = await runPretasks({ loaded, controllerName: 'C1', resourceName: null })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'PRETASK_FAILED')
  assert.ok(r.error.message.includes('3'), r.error.message)
  assert.ok(r.error.hint.includes('前置条件没满足'), '要带上子进程输出尾部，不然只能猜')
})

test('runPretasks：exec 不存在 → PRETASK_SPAWN（不是静默跳过）', async () => {
  const loaded = mkLoaded({ pretask: [{ exec: 'definitely-not-a-command-xyz-1234', args: [], option: [] }] })
  const r = await runPretasks({ loaded, controllerName: 'C1', resourceName: null })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'PRETASK_SPAWN')
})

test('过滤：声明只适用于别的控制器 → 跳过并说明，不算失败', async () => {
  const loaded = mkLoaded({
    pretask: [
      { exec: 'should-not-run', args: [], option: [], controller: ['C2'] },
    ],
  })
  const r = await runPretasks({ loaded, controllerName: 'C1', resourceName: null })
  assert.equal(r.ok, true)
  assert.equal(r.ran.length, 0)
  assert.equal(r.skipped.length, 1)
  assert.ok(r.notes.some((n) => n.includes('C2')), JSON.stringify(r.notes))
})

test('loadInterface：pretask 的 args / option / 过滤字段都要读进来（原来只读了 name+exec）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-pretask-load-'))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  fs.writeFileSync(path.join(dir, 'interface.json'), JSON.stringify({
    interface_version: 2,
    name: 'ut',
    controller: [{ name: 'C1', type: 'Adb' }],
    resource: [{ name: 'R1', path: 'res' }],
    task: [{ name: 'T1', entry: 'StartUp' }],
    pretask: [{ name: 'prep', exec: 'python', args: ['./p.py'], option: ['sel'], controller: ['C1'], resource: ['R1'] }],
  }))
  const l = loadInterface(dir)
  assert.equal(l.pretask.length, 1)
  const p = l.pretask[0]
  assert.equal(p.exec, 'python')
  assert.deepEqual(p.args, ['./p.py'])
  assert.deepEqual(p.option, ['sel'])
  assert.deepEqual(p.controller, ['C1'])
  assert.deepEqual(p.resource, ['R1'])
})
