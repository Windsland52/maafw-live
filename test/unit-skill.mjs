/**
 * skill 漂移比对单测（headless，纯文件操作）。
 *
 * 判据只有一条：**比字节**。这里覆盖四种状态与一条易误报的情形——
 *  - same / different / missing / extra 各自可诊断；
 *  - extra 不算漂移（skills CLI 会往 skill 目录里放 agent 元数据）；
 *  - 仅行尾不同（CRLF ↔ LF）仍算 different，但要给出成因提示，否则跨平台排查会误判成内容分叉。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compareSkillTrees, skillPayloadDir } from '../lib/commands/skill.js'

function tmpTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-skill-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return dir
}

const payloadFiles = {
  'SKILL.md': '---\nname: maafw-live\n---\n\n正文\n',
  'references/a.md': 'A\n',
  'references/deep/b.md': 'B\n',
}

test('完全一致：全部 same，无漂移', () => {
  const p = tmpTree(payloadFiles)
  const t = tmpTree(payloadFiles)
  try {
    const rows = compareSkillTrees(p, t)
    assert.deepEqual(rows.map((r) => [r.path, r.status]), [
      ['SKILL.md', 'same'], ['references/a.md', 'same'], ['references/deep/b.md', 'same'],
    ])
    assert.ok(rows.every((r) => r.sha256 && r.bytes > 0), 'same 也带指纹，便于人工核对')
  } finally { fs.rmSync(p, { recursive: true, force: true }); fs.rmSync(t, { recursive: true, force: true }) }
})

test('内容不同 / 缺失 / 目标多出文件：三种状态各自可分', () => {
  const p = tmpTree(payloadFiles)
  const t = tmpTree({ 'SKILL.md': '被改过的正文\n', 'references/deep/b.md': 'B\n', 'agents/openai.yaml': 'x\n' })
  try {
    const byPath = Object.fromEntries(compareSkillTrees(p, t).map((r) => [r.path, r]))
    assert.equal(byPath['SKILL.md'].status, 'different')
    assert.equal(byPath['references/a.md'].status, 'missing')
    assert.equal(byPath['references/deep/b.md'].status, 'same', '子目录结构按相对路径对齐')
    assert.equal(byPath['agents/openai.yaml'].status, 'extra')
  } finally { fs.rmSync(p, { recursive: true, force: true }); fs.rmSync(t, { recursive: true, force: true }) }
})

test('仅行尾不同：仍算 different，但给出成因提示', () => {
  const p = tmpTree({ 'SKILL.md': 'a\nb\n' })
  const t = tmpTree({ 'SKILL.md': 'a\r\nb\r\n' })
  try {
    const [row] = compareSkillTrees(p, t)
    assert.equal(row.status, 'different')
    assert.match(String(row.note), /行尾/)
  } finally { fs.rmSync(p, { recursive: true, force: true }); fs.rmSync(t, { recursive: true, force: true }) }
})

test('真身自检：包内 skill 目录可枚举且含 SKILL.md 与三份参考', () => {
  const dir = skillPayloadDir()
  assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')), '包内 skill 缺 SKILL.md：' + dir)
  const rows = compareSkillTrees(dir, dir)
  assert.ok(rows.length >= 4, '至少 SKILL.md + 3 份 references：' + JSON.stringify(rows.map((r) => r.path)))
  assert.ok(rows.every((r) => r.status === 'same'), '自己比自己必须全 same')
  assert.ok(rows.some((r) => r.path === 'references/examples.md'))
})
