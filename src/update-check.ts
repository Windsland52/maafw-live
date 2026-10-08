/**
 * 更新检查：本机版本 vs registry 上的 latest。
 *
 * 设计取舍（刻意做成"只报不换"）：
 *  - **不自动切换运行时**：agent 的长任务跑到一半换版本，比"晚一天升级"风险大得多。这里只提示。
 *  - **只在交互终端自动查**：管道/agent 调用不为它付代价（`version --check` 是显式请求，不受此限）。
 *  - **限频**：结果落盘缓存（默认 24h），不每次敲命令都打网络。
 *  - **可关**：`MAAFW_LIVE_NO_UPDATE_CHECK=1`。
 *  - **失败一律静默**：离线、代理、registry 抖动都不该影响 `version` 本身——它没有变得"失败"。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultRunDir } from './client/daemon.js'

export interface UpdateState {
  /** 上次成功查询的时间（epoch ms） */
  checkedAt: number
  /** 上次查到的 latest */
  latest: string
}

export const UPDATE_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 3000

/** registry 的 packument URL：scoped 名只编码斜杠（`@scope` 保持字面） */
export function packumentUrl(name: string): string {
  return 'https://registry.npmjs.org/' + name.replace('/', '%2F')
}

/** 语义化版本比较（只按 x.y.z 数值段；预发布标记按 semver 规则"有则更低"）。返回 a-b 的符号。 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string | null } => {
    const [core, ...rest] = String(v).trim().split('-')
    const nums = core.split('.').map((x) => {
      const n = Number(x)
      return Number.isFinite(n) ? n : 0
    })
    while (nums.length < 3) nums.push(0)
    return { nums: nums.slice(0, 3), pre: rest.length ? rest.join('-') : null }
  }
  const A = parse(a), B = parse(b)
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] > B.nums[i] ? 1 : -1
  }
  /* 主版本相同时：预发布低于正式版（1.0.0-rc < 1.0.0） */
  if (A.pre === B.pre) return 0
  if (A.pre === null) return 1
  if (B.pre === null) return -1
  return A.pre > B.pre ? 1 : -1
}

/** 缓存是否还新鲜（没有缓存、或时间戳比 TTL 旧 → 该查） */
export function shouldCheck(state: UpdateState | null, now: number, ttlMs = UPDATE_TTL_MS): boolean {
  if (!state || typeof state.checkedAt !== 'number' || !Number.isFinite(state.checkedAt)) return true
  if (typeof state.latest !== 'string' || state.latest === '') return true
  return now - state.checkedAt >= ttlMs
}

export function statePath(runDir = defaultRunDir()): string {
  return join(runDir, 'version-check.json')
}

export function readState(file = statePath()): UpdateState | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as UpdateState
    return j && typeof j.checkedAt === 'number' && typeof j.latest === 'string' ? j : null
  } catch {
    return null
  }
}

export function writeState(state: UpdateState, file = statePath()): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(state, null, 2) + '\n')
  } catch {
    /* 缓存写不进去不影响任何事 */
  }
}

/** 自动检查是否被环境变量关掉 */
export function updateCheckDisabled(env = process.env): boolean {
  const v = String(env.MAAFW_LIVE_NO_UPDATE_CHECK ?? '').trim()
  return v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

/** 查 registry 的 latest。任何失败都返回 null（静默）。 */
export async function fetchLatest(name: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  try {
    const res = await fetch(packumentUrl(name), {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const j = (await res.json()) as { 'dist-tags'?: Record<string, string> }
    const latest = j['dist-tags']?.latest
    return typeof latest === 'string' && latest !== '' ? latest : null
  } catch {
    return null
  }
}
