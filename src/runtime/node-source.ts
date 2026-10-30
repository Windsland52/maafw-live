/**
 * reco 的文件参数：`--node-file` / `--param-file`（`-` = stdin，两个 flag 对称支持）。
 *
 * 为什么要有文件通道：整节点 JSON 只能走 argv，而 Windows 上 bash → `cmd.exe`(npm shim) → node
 * 会把 `^` 当转义符吃掉——`expected: "^解锁"` 到进程时已变成 `"解锁"`，三种正则给出相同结果，
 * 一度被误判成"工具不应用 expected 过滤"。文件绕开的是**参数被 shell 改写**，不是 JSON 解析。
 *
 * 为什么按 JSONC 解析：pipeline 常带 `//` 注释，strict `JSON.parse` 会误伤真实文件；解析器复用
 * interface 那一份（`parseJsonc`），不在这里再写一遍脱敏逻辑。
 *
 * 为什么不用 `@a.json`：PowerShell 里 `@` 是 splat 前缀，会再踩一次"被 shell 破坏的参数"，
 * 与"不在工具里猜测/修复被破坏参数"的纪律冲突。
 */
import { readFileSync } from 'node:fs'
import { parseJsonc } from '../interface/jsonc.js'

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 读 `--xxx-file <path>`：`-` 读 stdin（一次性命令才有意义，REPL 里 stdin 是命令流） */
export function readJsoncArg(spec: string, flag: string): { value?: unknown; error?: string } {
  let text: string
  if (spec === '-') {
    try {
      text = readFileSync(0, 'utf8')
    } catch (e) {
      return { error: flag + ' - 从 stdin 读取失败：' + message(e) }
    }
  } else {
    try {
      text = readFileSync(spec, 'utf8')
    } catch (e) {
      return { error: flag + ' 读不到文件：' + spec + '（' + message(e) + '）' }
    }
  }
  try {
    return { value: parseJsonc(text) }
  } catch (e) {
    return { error: flag + ' 不是合法 JSON/JSONC：' + message(e) }
  }
}

/**
 * 节点表识别：文件里是 `{ "<节点名>": {…}, … }` 而不是一个节点。
 *
 * 判据：**单节点必有 `recognition`**（V1 字符串或 V2 对象），且节点表的每个值都是对象、
 * 至少有一个带 `recognition`。要求"至少一个带 recognition"是为了把 `{"action":{…}}` 这种
 * **缺 recognition 的单节点**留给"缺字段"的报错——它看起来也像"所有值都是对象"。
 * 这条只服务于报错文案（提示去用 `--node-name`），不构成"pipeline 文件"能力，也不改变执行路径。
 */
export function isNodeTable(value: Record<string, unknown>): boolean {
  if (value.recognition !== undefined) return false
  const keys = Object.keys(value)
  if (keys.length === 0) return false
  const allObjects = keys.every((k) => {
    const v = value[k]
    return v !== null && typeof v === 'object' && !Array.isArray(v)
  })
  if (!allObjects) return false
  return keys.some((k) => (value[k] as Record<string, unknown>).recognition !== undefined)
}

/** `--node-file` → 单个节点 */
export function readNodeFile(spec: string): { node?: Record<string, unknown>; error?: string; hint?: string } {
  const j = readJsoncArg(spec, '--node-file')
  if (j.error) return { error: j.error }
  const v = j.value
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { error: '--node-file 里必须是单个节点对象（pipeline 节点）' }
  }
  const node = v as Record<string, unknown>
  if (isNodeTable(node)) {
    return {
      error: '--node-file 拿到的是节点表（多节点），不是单个节点',
      hint: '这是 pipeline 文件的形状：按原名跑用 --node-name <节点名>（配 --project 或 --resource-dir），' +
        '只测其中一节就从文件里摘出那个节点',
    }
  }
  if (node.recognition === undefined) {
    return { error: '--node-file 的节点缺少 recognition 字段（V1 字符串或 V2 {type,param}）' }
  }
  return { node }
}

/** `--param-file` → recognition.param 那一层参数对象 */
export function readParamFile(spec: string): { param?: Record<string, unknown>; error?: string } {
  const j = readJsoncArg(spec, '--param-file')
  if (j.error) return { error: j.error }
  const v = j.value
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { error: '--param-file 里必须是参数对象（recognition.param 那一层，形如 {"template":"a.png"}）' }
  }
  return { param: v as Record<string, unknown> }
}
