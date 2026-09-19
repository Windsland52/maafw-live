/** 读取 CLI 自身包信息。src 与 lib 都在包根下一层，故 `../package.json` 两种运行方式都成立。 */
import { readFileSync } from 'node:fs'
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
    cached = { name: j.name ?? 'maafw-run', version: j.version ?? '0.0.0', description: j.description }
  } catch {
    cached = { name: 'maafw-run', version: '0.0.0' }
  }
  return cached
}
