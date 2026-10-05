/**
 * interface 四级 override 链 + import 合并单测。
 *
 * computePipelineOverride 是 run --project 的取值解析地基：四级顺序（global → resource
 * → controller → task，后者覆盖先者）、适用性过滤、checkbox 多选序、嵌套 option、
 * preset 覆盖 default_case——错一级就是管线静默跑错参数。import 合并（loadInterface）
 * 决定 option 字典最终长什么样：后导入覆盖同名。
 *
 * 注意：TS 模块经 lib/ 构建产物导入（node 不直接跑 .ts）——先 npm run build。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { computePipelineOverride } from '../lib/interface/override.js'
import { loadInterface } from '../lib/interface/load.js'

/** 最小 LoadedInterface 字面量；over 覆盖需要变化的段 */
const mkLoaded = (over = {}) => ({
  file: '/x/interface.json', dir: '/x', version: 2, name: 'ut',
  controllers: [{ name: 'CA', option: ['ctlOpt'] }],
  resources: [{ name: 'RA', option: ['resOpt'] }],
  tasks: [{ name: 'TK', entry: 'e', option: ['taskOpt'] }],
  options: {
    gOpt: { name: 'gOpt', type: 'select', cases: [{ name: 'on', pipelineOverride: { N: { timeout: 100, from: 'g' } } }], defaultCase: 'on' },
    resOpt: { name: 'resOpt', type: 'select', cases: [{ name: 'on', pipelineOverride: { N: { timeout: 200 } } }], defaultCase: 'on' },
    ctlOpt: { name: 'ctlOpt', type: 'select', cases: [{ name: 'on', pipelineOverride: { N: { timeout: 300 } } }], defaultCase: 'on' },
    taskOpt: { name: 'taskOpt', type: 'select', cases: [{ name: 'on', pipelineOverride: { N: { timeout: 400 } } }], defaultCase: 'on' },
  },
  presets: [],
  globalOption: ['gOpt'],
  pretask: [], agents: [], problems: [],
  ...over,
})

test('四级链：task > controller > resource > global，逐级覆盖同字段', () => {
  const r = computePipelineOverride({ loaded: mkLoaded(), controllerName: 'CA', resourceName: 'RA', taskName: 'TK' })
  assert.deepEqual(r.override, { N: { timeout: 400, from: 'g' } })
  // from 只在 global 声明 → 未被覆盖的字段保留；timeout 被 task 级覆盖
  assert.equal(r.override.N.timeout, 400)
  assert.equal(r.override.N.from, 'g')
  assert.equal(r.applied.length, 4)
})

test('高级存在、低级缺位：不被 undefined 级覆盖', () => {
  const r = computePipelineOverride({ loaded: mkLoaded(), controllerName: 'CA', resourceName: null, taskName: null })
  assert.equal(r.override.N.timeout, 300)
  const r2 = computePipelineOverride({ loaded: mkLoaded(), controllerName: null, resourceName: null, taskName: null })
  assert.equal(r2.override.N.timeout, 100)
})

test('适用性过滤：option 声明的 controller 不含当前 → 全级别跳过', () => {
  const loaded = mkLoaded()
  loaded.options.taskOpt.controller = ['OTHER']
  const r = computePipelineOverride({ loaded, controllerName: 'CA', resourceName: 'RA', taskName: 'TK' })
  assert.equal(r.override.N.timeout, 300, 'taskOpt 被过滤，controller 级生效')
  // 未声明的控制器：controller 级不进链（不猜），只剩 global 级
  const undeclared = computePipelineOverride({ loaded: mkLoaded(), controllerName: 'CB', resourceName: null, taskName: null })
  assert.equal(undeclared.override.N.timeout, 100)
})

test('preset 覆盖 default_case；preset 缺失告警', () => {
  /* 隔离 fixture：四级链上不挂任何 option，只测 sw 一个 */
  const loaded = mkLoaded({
    controllers: [{ name: 'CA' }], resources: [{ name: 'RA' }], tasks: [{ name: 'TK', entry: 'e', option: ['sw'] }],
    options: {
      sw: {
        name: 'sw', type: 'select',
        cases: [
          { name: 'off', pipelineOverride: {} },
          { name: 'on', pipelineOverride: { X: { enabled: true } } },
        ],
        defaultCase: 'off',
      },
    },
    globalOption: [],
    presets: [{ name: 'P1', task: [{ name: 'TK', option: { sw: 'on' } }] }],
  })
  const viaDefault = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: 'TK' })
  assert.equal(viaDefault.override.X, undefined, 'default=off 无 override')
  const viaPreset = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: 'TK', presetName: 'P1' })
  assert.deepEqual(viaPreset.override, { X: { enabled: true } })
  assert.ok(viaPreset.applied.some((a) => a.includes('via preset')))
  const missing = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: 'TK', presetName: 'NOPE' })
  assert.ok(missing.warns.some((w) => w.includes('NOPE') && w.includes('不存在')))
})

test('checkbox 多选按 cases 声明序合并，后 case 覆盖前 case 同字段', () => {
  const loaded = mkLoaded({
    options: {
      multi: {
        name: 'multi', type: 'checkbox',
        cases: [
          { name: 'a', pipelineOverride: { M: { speed: 1, tag: 'a' } } },
          { name: 'b', pipelineOverride: { M: { speed: 2 } } },
        ],
        defaultCase: ['a', 'b'],
      },
    },
    globalOption: ['multi'],
  })
  const r = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: null })
  assert.deepEqual(r.override, { M: { speed: 2, tag: 'a' } })
})

test('嵌套 option：父 case 生效后按声明序合并子项（晚于父级生效）', () => {
  const loaded = mkLoaded({
    options: {
      parent: {
        name: 'parent', type: 'select',
        cases: [{ name: 'go', pipelineOverride: { P: { mode: 'parent' } }, option: ['child'] }],
        defaultCase: 'go',
      },
      child: {
        name: 'child', type: 'select',
        cases: [{ name: 'go', pipelineOverride: { P: { mode: 'child', extra: 1 } } }],
        defaultCase: 'go',
      },
    },
    globalOption: ['parent'],
  })
  const r = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: null })
  assert.deepEqual(r.override, { P: { mode: 'child', extra: 1 } })
})

test('无取值：select 无 default/preset → 告警跳过；input/hotkey 静默跳过', () => {
  const loaded = mkLoaded({
    options: {
      novalue: { name: 'novalue', type: 'select', cases: [{ name: 'x', pipelineOverride: { Q: 1 } }] },
      inp: { name: 'inp', type: 'input', cases: [{ name: 'x', pipelineOverride: { Q: 2 } }] },
      hotk: { name: 'hotk', type: 'hotkey', cases: [{ name: 'x', pipelineOverride: { Q: 3 } }] },
    },
    globalOption: ['novalue', 'inp', 'hotk'],
  })
  const r = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: null })
  assert.equal(r.override.Q, undefined)
  assert.equal(r.warns.filter((w) => w.includes('novalue') && w.includes('无 preset')).length, 1)
  assert.ok(!r.warns.some((w) => w.includes('inp') || w.includes('hotk')), '输入类不算异常')
})

test('取值指向未声明 case → 告警跳过该 case', () => {
  const loaded = mkLoaded({
    options: { ghost: { name: 'ghost', type: 'select', cases: [{ name: 'real', pipelineOverride: { G: 1 } }], defaultCase: 'phantom' } },
    globalOption: ['ghost'],
  })
  const r = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: null })
  assert.equal(r.override.G, undefined)
  assert.ok(r.warns.some((w) => w.includes('phantom') && w.includes('不是已声明的 case')))
})

test('节点级字段浅合并：同节点不同字段共存，同字段对象整体替换（不深度合并）', () => {
  const loaded = mkLoaded({
    options: {
      gOpt: { name: 'gOpt', type: 'select', cases: [{ name: 'on', pipelineOverride: { N: { deep: { a: 1 }, keep: 1 } } }], defaultCase: 'on' },
      taskOpt: { name: 'taskOpt', type: 'select', cases: [{ name: 'on', pipelineOverride: { N: { deep: { b: 2 } } } }], defaultCase: 'on' },
    },
  })
  const r = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: 'TK' })
  assert.deepEqual(r.override.N, { deep: { b: 2 }, keep: 1 }, 'deep 整体替换、keep 保留')
})

/* ────────────────────────── import 合并（loadInterface，走真实文件） ────────────────────────── */
function writeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-if-'))
  fs.writeFileSync(path.join(dir, 'interface.json'), JSON.stringify({
    version: 2,
    name: 'ut-project',
    controller: [{ name: 'C1', type: 'Adb' }],
    resource: [{ name: 'R1', path: 'res' }],
    task: [{ name: 'T1', entry: 'StartUp', option: ['taskOpt'] }],
    option: {
      shared: { type: 'select', cases: [{ name: 'main', pipeline_override: { N: { from: 'main' } } }], default_case: 'main' },
    },
    global_option: ['g1'],
    import: ['extra.json'],
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'extra.json'), JSON.stringify({
    option: {
      shared: { type: 'select', cases: [{ name: 'extra', pipeline_override: { N: { from: 'extra' } } }], default_case: 'extra' },
      extraOnly: { type: 'select', cases: [{ name: 'x', pipeline_override: { E: 1 } }], default_case: 'x' },
    },
    task: [{ name: 'T2', entry: 'Second' }],
    global_option: ['g1', 'g2'],
    controller: [{ name: 'ShouldBeIgnored' }],
  }, null, 2))
  return dir
}

test('import 合并：后导入覆盖同名 option；task/global_option 并入去重', () => {
  const dir = writeFixture()
  try {
    const l = loadInterface(dir)
    assert.deepEqual(l.options.shared.cases.map((c) => c.name), ['extra'], '同名 option 后导入覆盖')
    assert.equal(l.options.shared.defaultCase, 'extra')
    assert.ok(l.options.extraOnly, '新增 option 并入')
    assert.ok(l.tasks.some((t) => t.name === 'T2'), 'import 的 task 并入')
    assert.deepEqual(l.globalOption, ['g1', 'g2'], 'global_option 并集去重')
    assert.ok(l.problems.some((p) => p.message.includes('不可导入') && p.message.includes('controller')),
      'import 声明 controller 记 problem：' + JSON.stringify(l.problems))
    assert.ok(!l.controllers.some((c) => c.name === 'ShouldBeIgnored'), '被忽略的 controller 不进入列表')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('import 自引用（循环）记 problem 并跳过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-if-'))
  try {
    fs.writeFileSync(path.join(dir, 'interface.json'), JSON.stringify({
      version: 2,
      controller: [{ name: 'C1', type: 'Adb' }],
      option: { a: { type: 'select', cases: [{ name: 'x', pipeline_override: {} }], default_case: 'x' } },
      import: ['interface.json'],
    }))
    const l = loadInterface(dir)
    assert.ok(l.problems.some((p) => p.message.includes('循环引用')), JSON.stringify(l.problems))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('目录无 interface.json → file=null 且不抛异常', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-if-'))
  try {
    const l = loadInterface(dir)
    assert.equal(l.file, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
