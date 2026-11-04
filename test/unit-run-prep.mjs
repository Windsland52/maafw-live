/**
 * prepareProjectRun：项目模式 run 的唯一装配点。
 *
 * 为什么要有这层单测：REPL 与一次性 CLI 曾经各拼一套 run 参数——REPL 只吃 `--override`，
 * interface 的 option / default_case / preset 在会话里静默不生效。口径收口后这里钉住
 * 入口解析、task 适用性、四级链 + 用户覆盖、preset 与警示。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadInterface } from '../lib/interface/load.js'
import { resolveResourcePaths } from '../lib/interface/plan.js'
import { prepareProjectRun } from '../lib/runtime/actions.js'

function writeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-run-prep-'))
  fs.writeFileSync(path.join(dir, 'interface.json'), JSON.stringify({
    interface_version: 2,
    name: 'run-prep',
    version: '1.2.3',
    controller: [{ name: 'C1', type: 'Adb', option: ['ctlOpt'] }],
    resource: [{ name: 'R1', path: ['res'], option: ['resOpt'] }],
    task: [{ name: '启动', entry: 'StartUp', option: ['taskOpt'] }],
    option: {
      gOpt: { type: 'select', cases: [{ name: 'on', pipeline_override: { Node: { g: 1 } } }], default_case: 'on' },
      resOpt: { type: 'select', cases: [{ name: 'on', pipeline_override: { Node: { res: 2 } } }], default_case: 'on' },
      ctlOpt: { type: 'select', cases: [{ name: 'on', pipeline_override: { Node: { ctl: 3 } } }], default_case: 'on' },
      taskOpt: {
        type: 'select',
        cases: [
          { name: 'a', pipeline_override: { Node: { task: 'a' } } },
          { name: 'b', pipeline_override: { Node: { task: 'b' } } },
        ],
        default_case: 'a',
      },
    },
    global_option: ['gOpt'],
    preset: [{ name: 'P1', task: [{ name: '启动', option: { taskOpt: 'b' } }] }],
  }, null, 2))
  return dir
}

function projectOf(dir, controller = 'C1', resourceName) {
  const loaded = loadInterface(dir)
  const resource = resolveResourcePaths(loaded, controller, resourceName)
  return { loaded, plan: null, controllerName: controller, resource }
}

test('入口解析 + 四级链 + preset + 用户 override 合成同一条链', (t) => {
  const dir = writeProject()
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const prep = prepareProjectRun({
    project: projectOf(dir),
    entry: '启动',
    presetName: 'P1',
    override: { Node: { user: 9 } },
  })
  assert.equal(prep.ok, true, JSON.stringify(prep))
  if (!prep.ok) return
  assert.equal(prep.entry, 'StartUp', 'task 名要解析成 pipeline 入口')
  assert.equal(prep.taskName, '启动')
  assert.deepEqual(prep.args.resourceDirs, [path.join(dir, 'res')])
  assert.deepEqual(prep.args.override, { Node: { g: 1, res: 2, ctl: 3, task: 'b', user: 9 } },
    'global→resource→controller→task，preset 覆盖 default_case，用户 --override 最后')
  assert.ok(prep.applied.some((l) => /taskOpt=b（task\.option，via preset）/.test(l)), JSON.stringify(prep.applied))
  assert.deepEqual(prep.args.agents, [], '没有 agent 声明时也要给 daemon 一个空数组（旧线形保持）')
})

test('task.controller 不匹配：拒绝装配，不发出带错控制器的 run', (t) => {
  const dir = writeProject()
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const project = projectOf(dir)
  project.loaded.tasks[0].controller = ['OTHER']
  const prep = prepareProjectRun({ project, entry: '启动' })
  assert.equal(prep.ok, false)
  if (prep.ok) return
  assert.equal(prep.code, 'TASK_NOT_APPLICABLE')
  assert.match(prep.error, /不支持当前控制器 C1/)
})

test('task.resource 不匹配：只告警，不阻断（适用性由调用方判断）', (t) => {
  const dir = writeProject()
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const project = projectOf(dir)
  project.loaded.tasks[0].resource = ['R9']
  const prep = prepareProjectRun({ project, entry: '启动' })
  assert.equal(prep.ok, true, JSON.stringify(prep))
  if (!prep.ok) return
  assert.ok(prep.warns.some((w) => w.includes('声明资源 R9，当前选中的是 R1')), JSON.stringify(prep.warns))
})

test('项目没有资源路径：RESOURCE_NOT_FOUND，不构造空 run', (t) => {
  const dir = writeProject()
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const project = projectOf(dir)
  project.resource = { paths: [], names: [], selected: null }
  const prep = prepareProjectRun({ project, entry: '启动' })
  assert.equal(prep.ok, false)
  if (prep.ok) return
  assert.equal(prep.code, 'RESOURCE_NOT_FOUND')
})

test('preset 不存在：告警继续，用 default_case 取值', (t) => {
  const dir = writeProject()
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const prep = prepareProjectRun({ project: projectOf(dir), entry: '启动', presetName: 'NOPE' })
  assert.equal(prep.ok, true)
  if (!prep.ok) return
  assert.ok(prep.warns.some((w) => /preset NOPE 不存在/.test(w)), JSON.stringify(prep.warns))
  assert.equal(prep.args.override.Node.task, 'a', 'preset 缺失时回到 default_case')
})

test('多个资源都适用：run 把"选了哪个、还有谁适用"升成 warning（--json 侧也看得到）', (t) => {
  const dir = writeProject()
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const loaded = loadInterface(dir)
  loaded.resources.push({ name: 'R2', paths: ['res2'], controllers: [] })
  const resource = resolveResourcePaths(loaded, 'C1')
  const prep = prepareProjectRun({ project: { loaded, plan: null, controllerName: 'C1', resource }, entry: '启动' })
  assert.equal(prep.ok, true, JSON.stringify(prep))
  if (!prep.ok) return
  assert.ok(
    prep.warns.some((w) => w.includes('R1') && w.includes('R2') && w.includes('--resource')),
    'note 行只到 human 输出，机器消费面要的是 warnings：' + JSON.stringify(prep.warns),
  )
})

test('--option 按次取值进链：CLI 值压过 default_case', (t) => {
  const dir = writeProject()
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const prep = prepareProjectRun({ project: projectOf(dir), entry: '启动', optionCases: { taskOpt: 'b' } })
  assert.equal(prep.ok, true, JSON.stringify(prep))
  if (!prep.ok) return
  assert.equal(prep.args.override.Node.task, 'b', 'default_case 是 a，CLI 给 b 应生效')
})

test('agent 子进程环境：PI_* 按当前选择生成，且不编 5.14.2 里没有的 PI_USER_DATA_DIR', (t) => {
  const dir = writeProject()
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const prep = prepareProjectRun({ project: projectOf(dir), entry: '启动' })
  assert.equal(prep.ok, true, JSON.stringify(prep))
  if (!prep.ok) return
  const env = prep.args.agentEnv
  assert.equal(env.PI_CLIENT_NAME, 'maafw-live')
  assert.equal(env.PI_INTERFACE_VERSION, 'v2.5.0', '兑现到哪一档就报哪一档，不谎报 v2.6/v2.7')
  assert.equal(env.PI_VERSION, '1.2.3', '顶层 version 是项目版本，不是 interface_version=2')
  assert.equal(JSON.parse(env.PI_CONTROLLER).name, 'C1', 'PI_CONTROLLER 是被选中那条的完整对象')
  assert.equal(JSON.parse(env.PI_RESOURCE).name, 'R1')
  assert.ok(!('PI_USER_DATA_DIR' in env), 'PI_USER_DATA_DIR 要 MaaFW 5.15.0+，本仓锁 5.14.2')
  assert.match(env.PI_CLIENT_MAAFW_VERSION, /^5\./, 'PI_CLIENT_MAAFW_VERSION 报实际加载的 maa-node 版本')
  assert.ok(!JSON.stringify(env).includes('\n'), 'PI_CONTROLLER / PI_RESOURCE 必须是单行紧凑 JSON')
})
