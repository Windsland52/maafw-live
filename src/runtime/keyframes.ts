/**
 * 关键帧库的离线读侧：list / resolve 不依赖 daemon 存活（契约 §4.1）。
 *
 * manifest 格式与 daemon/framed.mjs 的写入侧一一对应：
 *   { schema:1, libraryId, next, frames:[{ id, file, sha256, session, capturedAt,
 *     captureSeq, ctrlW, ctrlH, smallW, smallH, scale, source, note }] }
 * 写侧（升格）在 daemon；本模块只读，两个消费方（CLI kf、REPL kf）共用，不出现第二份解析。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const KF_SCHEMA = 1

export interface KfRecord {
  id: string
  file: string
  sha256: string
  session: { daemon: string; gen: number; kind: string | null; target: string | null }
  capturedAt: string
  captureSeq: number
  ctrlW: number
  ctrlH: number
  smallW: number | null
  smallH: number | null
  scale: number | null
  source: string
  note: string | null
}

export interface KfManifest {
  schema: number
  libraryId: string
  next: number
  frames: KfRecord[]
}

export type KfResolveStatus = 'available' | 'missing' | 'corrupt' | 'unsupported'

export function defaultFramesDir(): string {
  return join(homedir(), '.maafw-live', 'frames')
}

/** 读 manifest。坏文件/未知 schema 明确报错，不默认为当前版。 */
export function loadManifest(dir: string): { manifest?: KfManifest; error?: string } {
  const file = join(dir, 'manifest.json')
  if (!existsSync(file)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return { error: 'manifest.json 损坏（非合法 JSON）：' + String((e as Error).message) }
  }
  const m = raw as KfManifest
  if (!m || typeof m !== 'object' || !Array.isArray(m.frames)) {
    return { error: 'manifest.json 结构不符（缺 frames 数组）' }
  }
  if (m.schema !== KF_SCHEMA) {
    return { error: 'manifest schema=' + String(m.schema) + ' 不被当前版本支持（认识：' + KF_SCHEMA + '）' }
  }
  return { manifest: m }
}

/** 按完整 ID 帧解析：available 时给出经过完整性校验的路径；missing/corrupt/unsupported 各自可诊断。 */
export function resolveFrame(
  dir: string,
  id: string,
): { status: KfResolveStatus; record?: KfRecord; path?: string; reason?: string } {
  /* 非字符串 id（缺字段、拼错的调用方）也走"不可复核"这条路，而不是抛 TypeError——
   * 解析函数的契约是**如实报状态**，不该给调用方一个异常。 */
  if (typeof id !== 'string' || !id.startsWith('kf:')) {
    return { status: 'missing', reason: '要完整 ID：kf:<库UUID>:<序号>（裸序号只可作展示简称，不能跨库引用）' }
  }
  const { manifest, error } = loadManifest(dir)
  if (error) return { status: 'unsupported', reason: error }
  if (!manifest) return { status: 'missing', reason: '库内无 manifest（本机不可复核，不代表历史从未观测）' }
  const rec = manifest.frames.find((f) => f.id === id)
  if (!rec) return { status: 'missing', reason: 'manifest 无此 ID 记录' }
  const abs = join(dir, ...rec.file.split('/'))
  if (!existsSync(abs)) return { status: 'missing', record: rec, reason: 'L0 文件丢失' }
  let sha = ''
  try {
    sha = createHash('sha256').update(readFileSync(abs)).digest('hex')
  } catch (e) {
    return { status: 'corrupt', record: rec, reason: '读取失败：' + String((e as Error).message) }
  }
  if (sha !== rec.sha256) return { status: 'corrupt', record: rec, reason: 'sha256 不匹配（文件损坏或被改）' }
  return { status: 'available', record: rec, path: abs }
}

/** list 用：一行人类可读摘要（与 --json 的 data 各自完整，不共用裁剪）。 */
export function describeRecord(r: KfRecord): string {
  const dt = r.capturedAt ? r.capturedAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '?'
  return r.id + '  seq=' + r.captureSeq + '  ' + r.ctrlW + 'x' + r.ctrlH + '  ' + dt + '  [' + r.source + ']' +
    (r.note ? '  ' + r.note : '')
}
