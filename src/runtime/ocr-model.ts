/**
 * OCR 模型是否在资源链里：只回答"链上有没有框架会去读的那三个文件"。
 *
 * 为什么需要它：OCR 的 miss 与模板匹配不同——**模型没加载时框架不报错**，只回一个空结果
 * （`detail.all: []`、`hit:false`、约 200ms），与"roi 里真的没有字"完全同形（实测：一个不带
 * `model/` 的资源目录跑 `--type OCR` 就是这个签名）。不做这条判断，`describeMisses` 会把
 * "没加载 OCR 模型"报成"roi 内无文字"——正是本提案要清掉的那类误诊。
 *
 * 依据（MaaFramework 5.11.2 pinned source；本机运行时 5.14.2，相差一个小版本，
 * 相关实现见 `Resource/ResourceMgr.cpp::load_bundle` 与 `Resource/OCRResMgr.cpp`
 * 的 `lazy_load` / `load_deter` / `load_recer`）：
 *  - bundle 的 `model/ocr/` 存在时才尝试加载 OCR 模型，且在 `model/ocr/**` 里至少要见到
 *    `det.onnx` / `rec.onnx` / `keys.txt` 之一，否则 `lazy_load` 直接返回 false；
 *  - 真正要用时必须**同一目录**下三个文件齐全：`<model/ocr>/<model>/det.onnx`、
 *    `.../rec.onnx`、`.../keys.txt`；
 *  - `<model>` 来自节点参数 `model`，缺省空串 = 直接放在 `model/ocr/` 下；
 *  - 缺任一项 → 拿不到 ocrer，`OCRer::predict` 只是记日志并回空结果，**不抛错**。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const REQUIRED = ['det.onnx', 'rec.onnx', 'keys.txt'] as const

export type OcrModelStatus = 'present' | 'missing'

/**
 * 资源链上是否能找到 OCR 模型。`modelName` 是节点/参数里声明的模型名（缺省空串）。
 *
 * 只查文件存在性、不解析 onnx：判断的是"框架会不会找到它"，不是"模型能不能跑"。
 * 链上任何一段命中就算 present（后加载的段覆盖前一段，但检测只要有一份完整的就够）。
 */
export function ocrModelStatus(resourceDirs: string[], modelName?: string | null): OcrModelStatus {
  const name = typeof modelName === 'string' ? modelName.trim() : ''
  for (const dir of resourceDirs) {
    const folder = name === '' ? join(dir, 'model', 'ocr') : join(dir, 'model', 'ocr', name)
    if (REQUIRED.every((f) => existsSync(join(folder, f)))) return 'present'
  }
  return 'missing'
}
