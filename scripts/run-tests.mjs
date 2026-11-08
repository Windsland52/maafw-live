#!/usr/bin/env node
/**
 * 单测入口：按**文件名前缀分组**枚举 test/*.mjs 后以显式文件表调 node --test。
 * 不用 glob（引号/展开行为随 shell 变，Windows 下会静默跑 0 条）也不用目录参数
 * （Git Bash 的 MSYS 路径转换会把它搅坏）——文件表由 fs 现场枚举，新增测试文件零维护。
 *
 * 分组（文件名前缀，自描述、不靠目录）：
 *   unit-      纯 headless：stub daemon / 假 maa / 解析与合成逻辑——任何平台任何机器能跑
 *   device-    要真环境：起真 daemon 连真控制器（内部有 t.skip 自守卫，环境不符就跳过）
 *   contract-  设计态契约：测的是自带参考实现的可执行验收（落地后改测真身）
 *   accept-    验收脚本不走这里（scripts/accept-*.mjs，npm script accept:* 直调）
 *
 * 用法：
 *   node scripts/run-tests.mjs            # 默认 = unit（最快的回归面）
 *   node scripts/run-tests.mjs --group device     # 只 device
 *   node scripts/run-tests.mjs --group contract   # 只 contract
 *   node scripts/run-tests.mjs --group all        # 三组全跑（CI 用这个，覆盖不缩水）
 * 没有该前缀的文件时退出 0（不是错——该组可能只是还没写）。
 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'test')
const all = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()

const argIdx = process.argv.indexOf('--group')
const group = argIdx >= 0 ? (process.argv[argIdx + 1] ?? 'unit') : 'unit'

const GROUPS = ['unit', 'device', 'contract', 'all']
if (!GROUPS.includes(group)) {
  console.error('未知 --group ' + JSON.stringify(group) + '（可选：' + GROUPS.join(' / ') + '）')
  process.exit(2)
}

const files = (group === 'all' ? all : all.filter((f) => f.startsWith(group + '-')))
  .map((f) => join('test', f))

if (!files.length) {
  if (group === 'unit') {
    /* unit 是默认回归面，空了说明测试目录被挪或前缀被改——宁可红也不静默跑 0 条 */
    console.error('test/ 下没有 unit-*.mjs 单测文件')
    process.exit(1)
  }
  console.error('（无 ' + group + '-*.mjs，跳过）')
  process.exit(0)
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root })
process.exit(r.status ?? 1)
