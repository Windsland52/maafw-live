/**
 * OCR 模型是否在资源链里：只回答"链上有没有框架会去读的那几个文件"。
 *
 * 为什么需要它：OCR 的 miss 与模板匹配不同——**模型没加载时框架不报错**，只回一个空结果
 * （`detail.all: []`、`hit:false`、约 200ms），与"roi 里真的没有字"完全同形（实测：一个不带
 * `model/` 的资源目录跑 `--type OCR` 就是这个签名）。不做这条判断，`describeMisses` 会把
 * "没加载 OCR 模型"报成"roi 内无文字"——正是本提案要清掉的那类误诊。
 *
 * 依据（MaaFramework 5.11.2 pinned source；本机运行时 5.14.2，相差一个小版本，
 * 相关实现见 `Resource/ResourceMgr.cpp::load_bundle` 与 `Resource/OCRResMgr.cpp`
 * 的 `lazy_load` / `load_deter` / `load_recer`）：
 *  - `load_bundle` 对每个 bundle 调一次 `lazy_load(<bundle>/model/ocr)`，把该目录登记进
 *    roots 列表（后加载的在后），目录不存在就不登记；
 *  - `load_deter(name)` 遍历 roots，取第一个存在 `<root>/<name>/det.onnx` 的 root；
 *    `load_recer(name)` 遍历 roots，取第一个 `<root>/<name>/rec.onnx` 与
 *    `<root>/<name>/keys.txt` **同时**存在的 root；
 *  - `load_ocrer(name)` 要求 deter 与 recer 都拿到，所以判据是**合并**的：det 与 rec 允许
 *    来自不同 root（base 放 det、overlay 放 rec+keys 是齐的），但 rec 与 keys 必须同属一个
 *    root——它们是 load_recer 同一次调用里的两项，不会被拆开拼；
 *  - `<name>` 来自节点参数 `model`，缺省空串 = 直接放在 `model/ocr/` 下；
 *  - 缺任一项 → 拿不到 ocrer，`OCRer::predict` 只是记日志并回空结果，**不抛错**。
 *
 * 因此这里不能把"某一段目录三件套齐全"当判据：那会把"det 在 base、rec+keys 在 overlay"
 * 误报成 missing，而它其实完全可用——误报会把人引去补模型，真正该看的 roi 反而被略过。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const DET = 'det.onnx'
/** recer 的两项必须同目录同时存在：对应 `load_recer` 同一次调用里的两个文件。 */
const RECER = ['rec.onnx', 'keys.txt'] as const

export type OcrModelStatus = 'present' | 'missing'

/**
 * 资源链上是否能找到 OCR 模型。`modelName` 是节点/参数里声明的模型名（缺省空串）。
 *
 * 只查文件存在性、不解析 onnx：判断的是"框架会不会找到它"，不是"模型能不能跑"。
 * 按框架的合并规则判：det 与 rec 可以来自不同段，rec 与 keys 必须同段。
 */
export function ocrModelStatus(resourceDirs: string[], modelName?: string | null): OcrModelStatus {
  const name = typeof modelName === 'string' ? modelName.trim() : ''
  // 每段一个候选目录，顺序与框架扫 roots 的顺序一致（这里不需要顺序，只在同段内成组）。
  const folders = resourceDirs.map((dir) =>
    name === '' ? join(dir, 'model', 'ocr') : join(dir, 'model', 'ocr', name),
  )
  if (!folders.some((folder) => existsSync(join(folder, DET)))) return 'missing'
  return folders.some((folder) => RECER.every((f) => existsSync(join(folder, f)))) ? 'present' : 'missing'
}
