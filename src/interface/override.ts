/**
 * pipeline_override 四级合并链（PI v2 v2.3.x）：global_option → resource.option →
 * controller.option → task.option，后合并覆盖先合并；适用性过滤（option 自带的
 * controller/resource 条件不满足时不产生 override）；checkbox 多选按 cases 声明序合并；
 * 嵌套 option 在其父 case 之后合并。
 *
 * 取值解析顺序：preset 显式值 > default_case。两级都没有 → 警告并跳过（不猜）。
 * 本 CLI 是无人值守消费面：不做交互选择，preset 是把 MaaPiCli 用户选择带进来的唯一通道。
 */
import type { InterfaceOption, LoadedInterface, OptionCase } from './load.js'

export interface OverrideInput {
  loaded: LoadedInterface
  controllerName: string | null
  resourceName: string | null
  taskName: string | null
  presetName?: string | null
}

export interface OverrideResult {
  override: Record<string, unknown>
  /** 需要人工注意的事项（选项无取值、preset 未找到等） */
  warns: string[]
  /** 人类可读的生效记录：option=值（级别） */
  applied: string[]
}

/**
 * 把一份 pipeline_override 并入累计结果：同节点字段替换（与协议"不深度合并"一致）。
 *
 * **唯一一份实现**：四级链、`run --override`、`timing --override` 都走这里。这三处曾经各写一份，
 * 代价是同一个参数在不同命令里表现不同。非对象值必须**原样替换、不能展开**：字符串会被摊成
 * `{0:'a',1:'b'}`，`null` / 数字会静默变成空对象——等于把用户写的节点悄悄丢掉。
 */
export function mergeOverride(acc: Record<string, unknown>, po: Record<string, unknown>): void {
  for (const [node, fields] of Object.entries(po)) {
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      acc[node] = { ...((acc[node] as Record<string, unknown>) ?? {}), ...(fields as Record<string, unknown>) }
    } else {
      acc[node] = fields
    }
  }
}

export function computePipelineOverride(input: OverrideInput): OverrideResult {
  const { loaded, controllerName, resourceName, taskName, presetName } = input
  const warns: string[] = []
  const applied: string[] = []
  const acc: Record<string, unknown> = {}
  const preset = presetName ? loaded.presets.find((p) => p.name === presetName) : undefined
  if (presetName && !preset) warns.push('preset ' + presetName + ' 不存在（可用：' + loaded.presets.map((p) => p.name).join(' / ') + '或无）')
  const presetTask = preset && taskName ? preset.task.find((t) => t.name === taskName) : undefined

  const applicable = (o: InterfaceOption): boolean => {
    if (o.controller?.length && controllerName && !o.controller.includes(controllerName)) return false
    if (o.resource?.length && resourceName && !o.resource.includes(resourceName)) return false
    return true
  }

  /** 解析一个 option 的当前取值：preset > default_case；返回 case 名（单个或数组）。 */
  const valueOf = (name: string): { cases: string[]; via: string } | null => {
    const o = loaded.options[name]
    if (!o) {
      warns.push('option ' + name + ' 未在 interface 中定义，已跳过')
      return null
    }
    const pv = presetTask?.option?.[name]
    if (pv !== undefined) {
      return { cases: Array.isArray(pv) ? pv.map(String) : [String(pv)], via: 'preset' }
    }
    if (o.defaultCase !== undefined) {
      return { cases: Array.isArray(o.defaultCase) ? o.defaultCase.map(String) : [String(o.defaultCase)], via: 'default' }
    }
    return null
  }

  const mergeOption = (name: string, level: string, chain: string[] = []): void => {
    /* 嵌套 option 是"case 里再列 option"，A → B → A 这类自引用会让递归停不下来：
     * 记一条警告并跳过，而不是用栈溢出把整条 run 打断。 */
    if (chain.includes(name)) {
      warns.push('option ' + name + ' 出现在自己的嵌套链里（' + [...chain, name].join(' > ') + '），已跳过')
      return
    }
    const o = loaded.options[name]
    if (o && !applicable(o)) return
    const v = valueOf(name)
    if (!o) return
    if (!v) {
      if (o.type === 'input' || o.type === 'hotkey') return // 输入类不产生 pipeline_override，不算异常
      warns.push('option ' + name + '（' + level + '）无 preset/default_case 取值，跳过其 pipeline_override')
      return
    }
    for (const cname of v.cases) {
      const c = o.cases.find((x) => x.name === cname)
      if (!c) {
        warns.push('option ' + name + ' 的取值 ' + cname + ' 不是已声明的 case，已跳过')
        continue
      }
      if (c.pipelineOverride && Object.keys(c.pipelineOverride).length) {
        mergeOverride(acc, c.pipelineOverride)
        applied.push(name + '=' + cname + '（' + level + '，via ' + v.via + '）')
      }
      /* 嵌套子 option：父 case 生效后按声明顺序合并（更具体，晚于父级） */
      for (const child of c.option ?? []) mergeOption(child, level + ' > ' + name, [...chain, name])
    }
  }

  for (const name of loaded.globalOption) mergeOption(name, 'global_option')
  if (resourceName) {
    const r = loaded.resources.find((x) => x.name === resourceName)
    for (const name of r?.option ?? []) mergeOption(name, 'resource.option')
  }
  if (controllerName) {
    const c = loaded.controllers.find((x) => x.name === controllerName)
    for (const name of c?.option ?? []) mergeOption(name, 'controller.option')
  }
  if (taskName) {
    const t = loaded.tasks.find((x) => x.name === taskName)
    for (const name of t?.option ?? []) mergeOption(name, 'task.option')
  }

  return { override: acc, warns, applied }
}
