#!/usr/bin/env node
/**
 * 已装 skill 的漂移自检（发版前跑；`scripts/` 不进包，纯开发侧门禁）。
 *
 * 为什么需要它：`maafw-live skill --check <dir>` 早就存在且能报漂移，但**没有任何环节会自动跑**
 * ——skills CLI 装的是一次性快照，repo 改了 `skills/maafw-live/**` 之后没人喊它重装，下一个 agent
 * 照旧按旧副本干活（实测：repo 加了 RemoteController 句柄语义与进程树清理，装机副本还是 10-31 的，
 * 下一个会话把同一个 access violation 又踩了一遍）。
 *
 * 判据只有一条：已装副本与包内副本**逐字节一致**。不一致就退出 3 并打印可直接粘贴的修复命令，
 * 不自动覆盖——覆盖别人的 `~/.agents` 属于调用方的决定。
 *
 * 找不到任何安装根时退出 0（CI 里本来就没有，不是失败），但会把"跳过了"打在最后一行。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BIN = join(ROOT, 'bin', 'maafw-live.mjs')
const SKILL = 'maafw-live'

/** 常见安装根：skills CLI 的 `~/.agents/skills`，以及 DSH 自己的 skills 目录。 */
function defaultRoots() {
  const home = homedir()
  return [join(home, '.agents', 'skills'), join(home, '.dsh', 'skills')]
}

/** `MAAFW_LIVE_SKILL_ROOTS` 可覆盖（`;` 或 `:` 分隔，Windows 盘符里的冒号不算分隔符）。 */
function rootsFromEnv() {
  const raw = process.env.MAAFW_LIVE_SKILL_ROOTS
  if (raw === undefined || raw === '') return []
  return raw.split(/;|:(?!\\)/).map((s) => s.trim()).filter(Boolean)
}

const roots = [...rootsFromEnv(), ...defaultRoots()].filter((r) => existsSync(join(r, SKILL)))

if (!roots.length) {
  console.log('没有找到已装副本（' + defaultRoots().join(' / ') + '），跳过')
  process.exit(0)
}

let drifted = 0
for (const root of roots) {
  console.log('== ' + join(root, SKILL))
  const r = spawnSync(process.execPath, [BIN, 'skill', '--check', root], { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd()
  for (const line of out.split(/\r?\n/)) {
    if (line.includes('different ') || line.includes('missing ') || line.includes('extra ')) console.log('  ' + line.trim())
  }
  if (r.status === 0) {
    console.log('  一致')
    continue
  }
  drifted += 1
  console.log('  漂移 → 修：maafw-live skill --install ' + JSON.stringify(root))
}

if (drifted) {
  console.error('\n' + drifted + ' 个安装根的副本与包内不一致——发版前先 --install 同步，别让下一个 agent 读旧副本')
  process.exit(3)
}
console.log('\n所有已装副本与包内逐字节一致')
