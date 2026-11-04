/** 读取 CLI 自身包信息。src 与 lib 都在包根下一层，故 `../package.json` 两种运行方式都成立。 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface PackageInfo {
  name: string
  version: string
  description?: string
}

let cached: PackageInfo | null = null

export function cliPackage(): PackageInfo {
  if (cached) return cached
  try {
    const p = fileURLToPath(new URL('../package.json', import.meta.url))
    const j = JSON.parse(readFileSync(p, 'utf8')) as Partial<PackageInfo>
    cached = { name: j.name ?? 'maafw-live', version: j.version ?? '0.0.0', description: j.description }
  } catch {
    cached = { name: 'maafw-live', version: '0.0.0' }
  }
  return cached
}

let maaNodeCached: string | null = null

/**
 * 运行中**实际加载**的 maa-node 版本（PI_CLIENT_MAAFW_VERSION）。
 *
 * 为什么不用 package.json 的声明值：那里写的是范围（^5.14.2），而 agent 侧拿这个变量是要判协议
 * 兼容的——报范围等于没报。maa-node 不导出 `version`，也不保证导出 package.json，
 * 所以从入口向上找包根。拿不到返回空串（调用方据此不注入，而不是编一个）。
 */
export function maaNodeVersion(): string {
  if (maaNodeCached !== null) return maaNodeCached
  maaNodeCached = ''
  try {
    const req = createRequire(import.meta.url)
    let dir = dirname(req.resolve('@maaxyz/maa-node'))
    for (let i = 0; i < 6; i++) {
      const p = join(dir, 'package.json')
      try {
        const j = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string }
        if (j.name === '@maaxyz/maa-node' && j.version) {
          maaNodeCached = j.version
          break
        }
      } catch { /* 继续向上找 */ }
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
  } catch { /* 解析不到就留空 */ }
  return maaNodeCached
}
