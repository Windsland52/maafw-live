/**
 * interface 四级 override 链 + import 合并单测。
 *
 * computePipelineOverride 是 run --project 的取值解析地基：分层数组（task 基底 +
 * global → resource → controller → task 逐层，数组尾=最高优先级）、适用性过滤、
 * checkbox 多选序、嵌套 option、preset 覆盖 default_case——错一层就是管线静默跑错参数。
 * 层数组直接交给框架 override_pipeline：字段缺失继承前值、recognition/action 的 param
 * 同 type 按键继承（上游 @8061d5b 已核，别在客户端预合并）。import 合并（loadInterface）
 * 决定 option 字典最终长什么样：后导入覆盖同名。
 *
 * 注意：TS 模块经 lib/ 构建产物导入（node 不直接跑 .ts）——先 npm run build。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { computePipelineOverride, appendOverride } from '../lib/interface/override.js'
import { loadInterface } from '../lib/interface/load.js'
import { resolveResourcePaths } from '../lib/interface/plan.js'

/**
 * 把分层 override 摊平成"测试视角"的合并结果：**只作断言用**。
 * 模仿框架逐层继承的节点字段级合并（缺字段保留前值、字段整体替换）；
 * 真正的 param 深合并发生在框架 parse_node 里（同 type 按键继承），这里不模拟。
 */
const flat = (layers) => {
  const acc = {}
  for (const layer of layers) {
    for (const [node, fields] of Object.entries(layer)) {
      if (fields && typeof fields === 'object' && !Array.isArray(fields)) acc[node] = { ...(acc[node] ?? {}), ...fields }
      else acc[node] = fields
    }
  }
  return acc
}

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
  /* 输出是分层数组：每级 case 各占一层、按生效顺序排，框架逐层继承（上游已核）。
   * 不要把它摊平了断言——摊平会丢失层间 type 边界（这是被修掉的 bug）。 */
  assert.ok(Array.isArray(r.override), 'override 是分层数组')
  assert.deepEqual(r.override, [
    { N: { timeout: 100, from: 'g' } },  // gOpt.on
    { N: { timeout: 200 } },             // resOpt.on
    { N: { timeout: 300 } },             // ctlOpt.on
    { N: { timeout: 400 } },             // taskOpt.on（最高优先级）
  ])
  assert.deepEqual(flat(r.override), { N: { timeout: 400, from: 'g' } })
  assert.equal(r.applied.length, 4)
})

test('高级存在、低级缺位：不被 undefined 级覆盖', () => {
  const r = computePipelineOverride({ loaded: mkLoaded(), controllerName: 'CA', resourceName: null, taskName: null })
  assert.equal(flat(r.override).N.timeout, 300)
  const r2 = computePipelineOverride({ loaded: mkLoaded(), controllerName: null, resourceName: null, taskName: null })
  assert.equal(flat(r2.override).N.timeout, 100)
})

test('适用性过滤：option 声明的 controller 不含当前 → 全级别跳过', () => {
  const loaded = mkLoaded()
  loaded.options.taskOpt.controller = ['OTHER']
  const r = computePipelineOverride({ loaded, controllerName: 'CA', resourceName: 'RA', taskName: 'TK' })
  assert.equal(flat(r.override).N.timeout, 300, 'taskOpt 被过滤，controller 级生效')
  // 未声明的控制器：controller 级不进链（不猜），只剩 global 级
  const undeclared = computePipelineOverride({ loaded: mkLoaded(), controllerName: 'CB', resourceName: null, taskName: null })
  assert.equal(flat(undeclared.override).N.timeout, 100)
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
  assert.equal(flat(viaDefault.override).X, undefined, 'default=off 无 override')
  const viaPreset = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: 'TK', presetName: 'P1' })
  assert.deepEqual(flat(viaPreset.override), { X: { enabled: true } })
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
  /* checkbox：每个勾中 case 各占一层（上游 merge_option_overrides 逐 case emplace） */
  assert.deepEqual(r.override, [{ M: { speed: 1, tag: 'a' } }, { M: { speed: 2 } }])
  assert.deepEqual(flat(r.override), { M: { speed: 2, tag: 'a' } })
})

/**
 * `appendOverride` 是 `--override` 追加进链的**唯一一个口**（`run --override` / `timing --override`）。
 * 分层数组原样放行（框架逐层继承）；对象 = 一层；空对象/undefined 不入链——
 * 曾经这里各自展开，同一个 --override 在 run 与 timing 下得到不同结果。
 */
test('appendOverride：对象成一层、数组逐层、空值不入链', () => {
  const layers = [{ N: { timeout: 100 } }]
  appendOverride(layers, { N: { timeout: 200 }, S: 'enabled', Z: null, A: [1, 2] })
  appendOverride(layers, [{ X: 1 }, { Y: 2 }])
  appendOverride(layers, undefined)
  appendOverride(layers, {})
  assert.deepEqual(layers, [
    { N: { timeout: 100 } },
    { N: { timeout: 200 }, S: 'enabled', Z: null, A: [1, 2] },
    { X: 1 }, { Y: 2 },
  ])
})

test('嵌套 option 自引用：记警告并跳过，不让递归栈溢出', () => {
  const loaded = mkLoaded({
    options: {
      a: { name: 'a', type: 'select', cases: [{ name: 'go', pipelineOverride: { A: { v: 1 } }, option: ['b'] }], defaultCase: 'go' },
      b: { name: 'b', type: 'select', cases: [{ name: 'go', pipelineOverride: { B: { v: 2 } }, option: ['a'] }], defaultCase: 'go' },
    },
    globalOption: ['a'],
  })
  const r = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: null })
  assert.deepEqual(flat(r.override), { A: { v: 1 }, B: { v: 2 } }, '链上各方的有效覆盖都要保留，只跳过重复那一步')
  assert.ok(r.warns.some((w) => /嵌套链/.test(w)), '要留下可行动的警告：' + JSON.stringify(r.warns))
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
  /* 子 option 紧跟父 case 之后（更具体，晚生效） */
  assert.deepEqual(r.override, [{ P: { mode: 'parent' } }, { P: { mode: 'child', extra: 1 } }])
  assert.deepEqual(flat(r.override), { P: { mode: 'child', extra: 1 } })
})

test('无取值：select 无 default/preset → 告警；input 没有模板 → 不打扰', () => {
  const loaded = mkLoaded({
    options: {
      novalue: { name: 'novalue', type: 'select', cases: [{ name: 'x', pipelineOverride: { Q: 1 } }] },
      bare: { name: 'bare', type: 'input', inputs: [{ name: 'n' }] },
    },
    globalOption: ['novalue', 'bare'],
  })
  const r = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: null })
  assert.equal(flat(r.override).Q, undefined)
  assert.equal(r.warns.filter((w) => w.includes('novalue') && w.includes('无 preset')).length, 1)
  assert.ok(!r.warns.some((w) => w.includes('bare')), '没有模板 = 没有东西会丢，不打扰')
})

test('input：option 级模板 + 字段取值 → 整串按 pipeline_type 转型，片段用文本', () => {
  /* 模板在 option 级（`option.<键>.pipeline_override`），不在 cases 里——两处是不同字段 */
  const loaded = mkLoaded({
    options: {
      cnt: {
        name: 'cnt', type: 'input', cases: [],
        pipelineOverride: { Node: { timeout: '{超时时间}', next: 'MainChapter_{章节号}' } },
        inputs: [
          { name: '超时时间', pipelineType: 'int', default: '30' },
          { name: '章节号', pipelineType: 'string', default: '4' },
        ],
      },
    },
    globalOption: ['cnt'],
  })
  const r = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: null })
  assert.deepEqual(flat(r.override).Node, { timeout: 30, next: 'MainChapter_4' }, '整串转型成数字，片段拼接成字符串')
  assert.ok(r.applied.some((l) => l.includes('cnt') && l.includes('input')), JSON.stringify(r.applied))
})

test('input：占位没有取值 → 整条模板放弃（不写半套）并说明怎么给值', () => {
  const loaded = mkLoaded({
    options: {
      cnt: {
        name: 'cnt', type: 'input', cases: [],
        pipelineOverride: { Node: { timeout: '{超时}' } },
        inputs: [{ name: '超时', pipelineType: 'int' }],
      },
    },
    globalOption: ['cnt'],
  })
  const r = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: null })
  assert.equal(flat(r.override).Node, undefined)
  assert.ok(r.warns.some((w) => w.includes('超时') && w.includes('没有取值')), JSON.stringify(r.warns))
})

test('input：取值优先级 CLI --option > preset > 字段 default', () => {
  const mk = () => mkLoaded({
    options: {
      cnt: {
        name: 'cnt', type: 'input', cases: [],
        pipelineOverride: { Node: { timeout: '{n}' } },
        inputs: [{ name: 'n', pipelineType: 'int', default: '1' }],
      },
    },
    globalOption: [],
    presets: [{ name: 'P', task: [{ name: 'TK', option: { cnt: { n: '5' } } }] }],
    tasks: [{ name: 'TK', entry: 'e', option: ['cnt'] }],
  })
  const base = { controllerName: null, resourceName: null, taskName: 'TK', presetName: 'P' }
  assert.equal(flat(computePipelineOverride({ loaded: mk(), ...base }).override).Node.timeout, 5, 'preset 压过字段 default')
  assert.equal(
    flat(computePipelineOverride({ loaded: mk(), ...base, optionFields: { cnt: { n: '9' } } }).override).Node.timeout,
    9,
    'CLI 按次取值压过 preset（本地约定：协议未规定优先级）',
  )
})

test('input password 字段：值进 tokens，applied 回显掩码（v2.10.0：不得把原文写进输出/日志）', () => {
  const loaded = mkLoaded({
    options: {
      auth: {
        name: 'auth', type: 'input', cases: [],
        pipelineOverride: { Node: { token: '{secret}' } },
        inputs: [{ name: 'secret', pipelineType: 'string', password: true }],
      },
    },
    globalOption: ['auth'],
  })
  const r = computePipelineOverride({
    loaded, controllerName: null, resourceName: null, taskName: null,
    optionFields: { auth: { secret: 's3cr3t-real' } },
  })
  assert.equal(flat(r.override).Node.token, 's3cr3t-real', '掩码只改回显，替换进 pipeline 的仍是原值')
  assert.ok(r.applied.every((l) => !l.includes('s3cr3t-real')), 'applied 不得带密码原文：' + JSON.stringify(r.applied))
  assert.ok(r.applied.some((l) => l.includes('secret=•••')), JSON.stringify(r.applied))
})

test('checkbox min_count / max_count：取值数量违反约束 → 告警（不阻断，声明的问题修在 interface.json）', () => {
  const loaded = mkLoaded({
    options: {
      multi: {
        name: 'multi', type: 'checkbox', minCount: 2, maxCount: 2,
        cases: [
          { name: 'a', pipelineOverride: { N: { a: 1 } } },
          { name: 'b', pipelineOverride: { N: { b: 1 } } },
          { name: 'c', pipelineOverride: { N: { c: 1 } } },
        ],
        defaultCase: ['a'],
      },
    },
    globalOption: ['multi'],
  })
  const r = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: null })
  assert.ok(r.warns.some((w) => w.includes('multi') && w.includes('min_count')), '1 < min_count=2 要报：' + JSON.stringify(r.warns))
  const r2 = computePipelineOverride({
    loaded, controllerName: null, resourceName: null, taskName: null,
    optionCases: { multi: ['a', 'b', 'c'] },
  })
  assert.ok(r2.warns.some((w) => w.includes('multi') && w.includes('max_count')), '3 > max_count=2 要报：' + JSON.stringify(r2.warns))
})

test('hotkey：没选中控制器 → 无法确定键码表，跳过并说清楚', () => {
  const loaded = mkLoaded({
    options: {
      hk: {
        name: 'hk', type: 'hotkey', cases: [],
        pipelineOverride: { KeyNode: { key: '{热键}' } },
        hotkeys: [{ name: '热键', default: 'E' }],
      },
    },
    globalOption: ['hk'],
  })
  const r = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: null })
  assert.equal(flat(r.override).KeyNode, undefined)
  assert.ok(r.warns.some((w) => w.includes('hotkey') && w.includes('未确定')), JSON.stringify(r.warns))
})

test('hotkey：按控制器 type 解析成整数键码，四个占位符都可用（Win32 Ctrl+A）', () => {
  const loaded = mkLoaded({
    controllers: [{ name: 'C1', type: 'Win32' }],
    options: {
      hk: {
        name: 'hk', type: 'hotkey', cases: [],
        pipelineOverride: {
          Node: { key: '{热键.primary}', modifier: '{热键.modifier1}', both: '{热键}' },
        },
        hotkeys: [{ name: '热键', default: 'Ctrl+A' }],
      },
    },
    globalOption: ['hk'],
  })
  const r = computePipelineOverride({ loaded, controllerName: 'C1', resourceName: null, taskName: null })
  assert.deepEqual(flat(r.override).Node, { key: 0x41, modifier: 0x11, both: 0x41 }, '"Ctrl+A"：末段主键，前段修饰键')
})

test('hotkey：控制器类型没有键码表（Gamepad）→ 跳过而不是按 Win32 猜', () => {
  const loaded = mkLoaded({
    controllers: [{ name: 'C1', type: 'Gamepad' }],
    options: {
      hk: {
        name: 'hk', type: 'hotkey', cases: [],
        pipelineOverride: { KeyNode: { key: '{热键}' } },
        hotkeys: [{ name: '热键', default: 'A' }],
      },
    },
    globalOption: ['hk'],
  })
  const r = computePipelineOverride({ loaded, controllerName: 'C1', resourceName: null, taskName: null })
  assert.equal(flat(r.override).KeyNode, undefined)
  assert.ok(r.warns.some((w) => w.includes('Gamepad')), JSON.stringify(r.warns))
})

test('task 级 pipeline_override 是基底，option 链在其上覆盖', () => {
  const loaded = mkLoaded({
    tasks: [{ name: 'TK', entry: 'e', option: ['taskOpt'], pipelineOverride: { N: { timeout: 1, keep: 'task' } } }],
  })
  const r = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: 'TK' })
  /* task 基底是 [0]，option 层在其后（上游：json::array{task.po} + 逐层 emplace） */
  assert.equal(r.override[0].N.timeout, 1, 'task 级 override 是数组首层')
  assert.equal(flat(r.override).N.timeout, 400, 'option 覆盖 task 级同字段')
  assert.equal(flat(r.override).N.keep, 'task', 'task 级独有的字段保留')
  assert.ok(r.applied[0].includes('task.pipeline_override'), '基底要在生效记录里可见')
})

test('--option 的键没被任何级别引用 → 告警（不是静默丢弃）', () => {
  const r = computePipelineOverride({
    loaded: mkLoaded(),
    controllerName: null, resourceName: null, taskName: null,
    optionCases: { ghost: 'on' },
  })
  assert.ok(r.warns.some((w) => w.includes('ghost') && w.includes('没有被任何级别引用')), JSON.stringify(r.warns))
})

test('取值指向未声明 case → 告警跳过该 case', () => {
  const loaded = mkLoaded({
    options: { ghost: { name: 'ghost', type: 'select', cases: [{ name: 'real', pipelineOverride: { G: 1 } }], defaultCase: 'phantom' } },
    globalOption: ['ghost'],
  })
  const r = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: null })
  assert.equal(flat(r.override).G, undefined)
  assert.ok(r.warns.some((w) => w.includes('phantom') && w.includes('不是已声明的 case')))
})

test('同节点跨层字段共存，同字段后者替换（框架逐层继承的等价断言）', () => {
  const loaded = mkLoaded({
    options: {
      gOpt: { name: 'gOpt', type: 'select', cases: [{ name: 'on', pipelineOverride: { N: { deep: { a: 1 }, keep: 1 } } }], defaultCase: 'on' },
      taskOpt: { name: 'taskOpt', type: 'select', cases: [{ name: 'on', pipelineOverride: { N: { deep: { b: 2 } } } }], defaultCase: 'on' },
    },
  })
  const r = computePipelineOverride({ loaded, controllerName: null, resourceName: null, taskName: 'TK' })
  /* 层保持分离：gOpt 与 taskOpt 各自的 N 各占一层，框架 parse_node 逐层继承字段。
   * recognition/action 的 param 深合并发生在框架侧（同 type 按键继承），flat() 只模拟顶层字段。 */
  assert.deepEqual(r.override, [{ N: { deep: { a: 1 }, keep: 1 } }, { N: { deep: { b: 2 } } }])
  assert.deepEqual(flat(r.override).N, { deep: { b: 2 }, keep: 1 }, 'deep 整体替换、keep 保留')
})

/* ────────────────────────── import 合并（loadInterface，走真实文件） ────────────────────────── */
function writeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-if-'))
  fs.writeFileSync(path.join(dir, 'interface.json'), JSON.stringify({
    interface_version: 2,
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
    assert.ok(!l.problems.some((p) => p.message.includes('interface_version')),
      '夹具本身必须是合法 PI 文件（字段名是 interface_version，不是 version）：' + JSON.stringify(l.problems))
    assert.ok(!l.controllers.some((c) => c.name === 'ShouldBeIgnored'), '被忽略的 controller 不进入列表')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('import 自引用（循环）记 problem 并跳过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-if-'))
  try {
    fs.writeFileSync(path.join(dir, 'interface.json'), JSON.stringify({
      interface_version: 2,
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

/**
 * `resolveResourcePaths` 的分支覆盖：resource[] 条目 + 控制器附加路径。
 * `controller.attach_resource_path` 是**控制器的属性**（v2.2.0："在 resource.path 加载完成后额外加载"），
 * 所以 `--resource <名>` / `--resource <路径>` 这两条分支也必须带上它——它们曾经提前 return 把它丢了。
 */
test('resolveResourcePaths：--resource 指定条目或路径时，仍追加 controller.attach_resource_path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-if-attach-'))
  try {
    fs.writeFileSync(path.join(dir, 'interface.json'), JSON.stringify({
      interface_version: 2,
      name: 'attach',
      controller: [{ name: 'C1', type: 'Adb', attach_resource_path: ['attachA'] }],
      resource: [
        { name: 'R1', path: ['res1'] },
        { name: 'R2', path: ['res2'] },
      ],
      task: [{ name: 'T1', entry: 'StartUp' }],
    }))
    const l = loadInterface(dir)
    const attach = path.join(dir, 'attachA')

    const byDefault = resolveResourcePaths(l, 'C1')
    assert.deepEqual(byDefault.paths, [path.join(dir, 'res1'), attach], '缺省：首个适用条目 + 附加路径')
    assert.equal(byDefault.selected, 'R1')

    const byName = resolveResourcePaths(l, 'C1', 'R2')
    assert.deepEqual(byName.paths, [path.join(dir, 'res2'), attach], '按名选中：也要带附加路径')
    assert.equal(byName.selected, 'R2')

    const loose = path.join(dir, 'loose')
    fs.mkdirSync(loose)   /* 存在的目录才按路径接受——不存在=打错字=拒绝 */
    const byPath = resolveResourcePaths(l, 'C1', loose)
    assert.deepEqual(byPath.paths, [loose, attach], '按路径选中：也要带附加路径')

    /* 名字没匹配上且目录不存在：拒绝启动（此前 silently 当路径，资源级过滤全跳） */
    const miss = resolveResourcePaths(l, 'C1', 'typo-name')
    assert.equal(miss.paths.length, 0)
    assert.ok(miss.error && miss.error.includes('typo-name'), '要报"不是资源名也不是目录"：' + miss.error)

    const noCtrl = resolveResourcePaths(l, undefined, 'R2')
    assert.deepEqual(noCtrl.paths, [path.join(dir, 'res2')], '没说控制器就没有附加路径')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveResourcePaths：多个资源都适用 → 取第一个但给 note（静默取首是最坏的失败模式）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-if-multi-'))
  try {
    fs.writeFileSync(path.join(dir, 'interface.json'), JSON.stringify({
      interface_version: 2,
      name: 'multi',
      controller: [{ name: 'C1', type: 'Adb' }],
      resource: [
        { name: 'ZH', path: ['zh'] },
        { name: 'EN', path: ['en'] },
        { name: 'ONLY_C2', path: ['c2'], controller: ['C2'] },
      ],
      task: [{ name: 'T1', entry: 'StartUp' }],
    }))
    const l = loadInterface(dir)
    const r = resolveResourcePaths(l, 'C1')
    assert.equal(r.selected, 'ZH', '互斥单选：按声明序取第一个仍是语义')
    assert.equal(r.notes?.length, 1, '但必须留下"还有别的可选"的痕迹')
    assert.ok(r.notes[0].includes('ZH') && r.notes[0].includes('EN'))
    assert.ok(!r.notes[0].includes('ONLY_C2'), '不适用的条目不进备选')

    const byName = resolveResourcePaths(l, 'C1', 'EN')
    assert.equal(byName.selected, 'EN')
    assert.equal(byName.notes, undefined, '用户已经显式选了：没有歧义就别啰嗦')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resource.hash：hashCheck 只圈 path[]，attach_resource_path 不计入被校验对象', () => {
  /* PI v2.6：校验时机是"加载完 path 后、加载 attach 之前"——把 attach 算进被校验
   * 对象会让 hash 与上游算的不一致（误报）。这里钉住两段的分界。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-if-hash-'))
  try {
    fs.writeFileSync(path.join(dir, 'interface.json'), JSON.stringify({
      interface_version: 2,
      name: 'hash',
      controller: [{ name: 'C1', type: 'Adb', attach_resource_path: ['attachA'] }],
      resource: [
        { name: 'R1', path: ['res1a', 'res1b'], hash: 'sha-expected-1' },
        { name: 'R2', path: ['res2'] /* 无 hash：不校验 */ },
      ],
      task: [{ name: 'T1', entry: 'StartUp' }],
    }))
    const l = loadInterface(dir)
    const res1a = path.join(dir, 'res1a'), res1b = path.join(dir, 'res1b'), attach = path.join(dir, 'attachA')

    const plan = resolveResourcePaths(l, 'C1')
    assert.equal(plan.hashCheck?.expected, 'sha-expected-1')
    assert.equal(plan.hashCheck?.resourceName, 'R1')
    assert.deepEqual(plan.hashCheck?.pathDirs, [res1a, res1b], '被校验的只有 path[]')
    assert.deepEqual(plan.hashCheck?.attachDirs, [attach], 'attach 单独一段，不算进被校验对象')
    assert.deepEqual(plan.paths, [res1a, res1b, attach], '加载全链仍是 path + attach')

    const noHash = resolveResourcePaths(l, 'C1', 'R2')
    assert.equal(noHash.hashCheck, undefined, '没声明 hash 就不校验')
    assert.deepEqual(noHash.paths, [path.join(dir, 'res2'), attach], 'attach 照常加载')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resource.hash：--resource 按名选中时校验跟着选中项走', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-if-hash-sel-'))
  try {
    fs.writeFileSync(path.join(dir, 'interface.json'), JSON.stringify({
      interface_version: 2,
      name: 'hash-sel',
      controller: [{ name: 'C1', type: 'Adb' }],
      resource: [
        { name: 'R1', path: ['res1'], hash: 'h1' },
        { name: 'R2', path: ['res2'], hash: 'h2' },
      ],
      task: [{ name: 'T1', entry: 'StartUp' }],
    }))
    const l = loadInterface(dir)
    assert.equal(resolveResourcePaths(l, 'C1', 'R2').hashCheck?.expected, 'h2')
    assert.equal(resolveResourcePaths(l, 'C1').hashCheck?.expected, 'h1')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('import 不可嵌套：被导入文件里的 import 记 problem 并忽略', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-if-nest-'))
  try {
    fs.writeFileSync(path.join(dir, 'interface.json'), JSON.stringify({
      interface_version: 2,
      controller: [{ name: 'C1', type: 'Adb' }],
      resource: [{ name: 'R1', path: 'res' }],
      task: [{ name: 'T1', entry: 'StartUp' }],
      import: ['mid.json'],
    }))
    fs.writeFileSync(path.join(dir, 'mid.json'), JSON.stringify({
      task: [{ name: 'T2', entry: 'Mid' }],
      import: ['leaf.json'],
    }))
    fs.writeFileSync(path.join(dir, 'leaf.json'), JSON.stringify({ task: [{ name: 'T3', entry: 'Leaf' }] }))
    const l = loadInterface(dir)
    assert.ok(l.tasks.some((t) => t.name === 'T2'), '一级导入照常合并')
    assert.ok(!l.tasks.some((t) => t.name === 'T3'), '二级文件不展开——嵌套不是协议的一部分')
    assert.ok(l.problems.some((p) => p.message.includes('不可嵌套')),
      '要留下可行动的 problem（静默吞掉会让整份二级文件消失）：' + JSON.stringify(l.problems))
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

test('loadInterface：v2.10 字段进模型——password 禁 default、checkbox min/max_count、agent.identifier、permission_required', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-if-'))
  try {
    fs.writeFileSync(path.join(dir, 'interface.json'), JSON.stringify({
      interface_version: 2,
      controller: [{ name: 'C1', type: 'Win32', permission_required: true }],
      resource: [{ name: 'R1', path: 'res' }],
      task: [{ name: 'T1', entry: 'E' }],
      option: {
        auth: {
          type: 'input',
          pipeline_override: { N: { token: '{secret}' } },
          inputs: [{ name: 'secret', password: true, default: 'oops', pipeline_type: 'string' }],
        },
        multi: { type: 'checkbox', min_count: 1, max_count: 2, cases: [{ name: 'a', pipeline_override: {} }] },
        bad: { type: 'checkbox', min_count: 5, max_count: 2, cases: [{ name: 'a', pipeline_override: {} }] },
      },
      agent: [{ child_exec: 'python', child_args: ['main.py'], identifier: 'fixed-1' }],
    }))
    const l = loadInterface(dir)
    const secret = l.options.auth.inputs.find((f) => f.name === 'secret')
    assert.equal(secret.password, true)
    assert.equal(secret.default, undefined, 'password=true 时 schema 禁 default，解析层就丢掉')
    assert.ok(l.problems.some((p) => p.message.includes('password=true') && p.message.includes('default')), JSON.stringify(l.problems))
    assert.equal(l.options.multi.minCount, 1)
    assert.equal(l.options.multi.maxCount, 2)
    assert.equal(l.options.bad.minCount, 5, '字段如实进模型……')
    assert.ok(l.problems.some((p) => p.message.includes('min_count') && p.message.includes('max_count')), '……自相矛盾的约束记 problem：' + JSON.stringify(l.problems))
    assert.equal(l.agents[0].identifier, 'fixed-1')
    assert.equal(l.controllers[0].permissionRequired, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
