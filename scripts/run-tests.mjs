#!/usr/bin/env node
/**
 * 单测入口：枚举 test/*.mjs 后以显式文件表调 node --test。
 * 不用 glob（引号/展开行为随 shell 变，Windows 下会静默跑 0 条）也不用目录参数
 * （Git Bash 的 MSYS 路径转换会把它搅坏）——文件表由 fs 现场枚举，新增测试文件零维护。
 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'test')
const files = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()
  .map((f) => join('test', f))
if (!files.length) {
  console.error('test/ 下没有 *.mjs 单测文件')
  process.exit(1)
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root })
process.exit(r.status ?? 1)
