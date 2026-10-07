/**
 * `maafw-live skill` —— 随包发布的 agent skill 与"装在 agent 里的那一份"如何对齐。
 *
 * 为什么不写版本号：skill 讲的是本工具的命令与判据，跟包走才不会各说各话；但写进文件的版本号
 * 每次发版都要改，而且从仓库装的副本仍然对不上。所以对齐用**比字节**：逐文件 same / different /
 * missing / extra（extra 是目标目录多出来的文件，例如 skills CLI 放进来的 agent 元数据，不算漂移）。
 *
 * 与本仓 docs/ 的分工：docs/ 是字段与协议的唯一出处，skill 只写动线与判据——两者都随包发布，
 * 区别在消费者（人读 docs，agent 装 skill），因此这里只做"是不是同一份字节"，不解释内容。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'

const SKILL_NAME = 'maafw-live'

/** 包内 skill 目录：lib/commands/ → <包根>/skills/maafw-live（本地 checkout 同构） */
export function skillPayloadDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', SKILL_NAME)
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

/** 目录内全部文件的相对路径（'/' 分隔、排序稳定），供比对与安装共用。 */
function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (cur: string): void => {
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const abs = join(cur, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile()) out.push(relative(dir, abs).split(sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

export interface SkillFileStatus {
  path: string
  status: 'same' | 'different' | 'missing' | 'extra'
  /** different 时的成因提示；行尾差异常来自跨平台工具改写，值得单独指出 */
  note?: string
  bytes?: number
  sha256?: string
}

/**
 * 逐文件比对（纯函数，单测直接喂两个目录）。只比字节：任何不同都是 different，
 * 但在**仅行尾不同**（CRLF ↔ LF）时补一条 note——那不是内容分叉，是工具改写。
 */
export function compareSkillTrees(payload: string, target: string): SkillFileStatus[] {
  const files = listFiles(payload)
  const rows: SkillFileStatus[] = []
  for (const rel of files) {
    const pb = readFileSync(join(payload, ...rel.split('/')))
    const ta = join(target, ...rel.split('/'))
    const base = { path: rel, bytes: pb.length, sha256: sha256(pb) }
    if (!existsSync(ta)) {
      rows.push({ ...base, status: 'missing' })
      continue
    }
    const tb = readFileSync(ta)
    if (pb.equals(tb)) {
      rows.push({ ...base, status: 'same' })
      continue
    }
    const eolOnly = pb.toString('utf8').replace(/\r\n/g, '\n') === tb.toString('utf8').replace(/\r\n/g, '\n')
    rows.push({ ...base, status: 'different', ...(eolOnly ? { note: '仅行尾不同（CRLF/LF）' } : {}) })
  }
  for (const rel of listFiles(target)) {
    if (!files.includes(rel)) rows.push({ path: rel, status: 'extra' })
  }
  return rows
}

const driftOf = (rows: SkillFileStatus[]): boolean => rows.some((r) => r.status !== 'same' && r.status !== 'extra')

function readPayload(dir: string): { path: string; bytes: number; sha256: string; text: string }[] {
  return listFiles(dir).map((rel) => {
    const buf = readFileSync(join(dir, ...rel.split('/')))
    return { path: rel, bytes: buf.length, sha256: sha256(buf), text: buf.toString('utf8') }
  })
}

export const skillCommand: Command = {
  name: 'skill',
  summary: '随包 skill：看包内副本与文件指纹、比对已装副本（same/different/missing/extra）、字节精确安装',
  usage: 'maafw-live skill                                包内 skill 位置与文件指纹\n' +
    '       maafw-live skill --check <dir>                 比对 <dir>/maafw-live 与包内副本（有漂移退出 3）\n' +
    '       maafw-live skill --install <dir>               把包内副本逐字节写到 <dir>/maafw-live\n' +
    '       maafw-live skill --print [--format json]       输出包内副本内容（harness 自取）',
  options: {
    check: { type: 'string' },
    install: { type: 'string' },
    print: { type: 'boolean' },
    format: { type: 'string' },
  },

  async run(ctx): Promise<CommandResult> {
    const payload = skillPayloadDir()
    if (!existsSync(payload)) {
      return fail('SKILL_NOT_FOUND', '包内未找到 skill 目录：' + payload,
        '本版本应随包发布 skills/maafw-live；从仓库运行时确认 skills/ 没有被删', EXIT.ENV)
    }
    const files = listFiles(payload)

    const checkDir = typeof ctx.values.check === 'string' ? ctx.values.check : undefined
    if (checkDir !== undefined) {
      const target = join(checkDir, SKILL_NAME)
      if (!existsSync(target)) {
        return fail('SKILL_DIR_NOT_FOUND', '目标目录下没有 ' + SKILL_NAME + ' skill：' + target,
          '给的是**安装根目录**（里面应当有 ' + SKILL_NAME + '/SKILL.md），例如 --global 装的 ~/.claude/skills', EXIT.ENV)
      }
      const rows = compareSkillTrees(payload, target)
      const drifted = driftOf(rows)
      const extra = rows.filter((r) => r.status === 'extra')
      const mark = (s: SkillFileStatus['status']): string =>
        s === 'same' ? 'same     ' : (s === 'different' ? 'different' : (s === 'missing' ? 'missing  ' : 'extra    '))
      const human = [
        '包内副本 ' + payload,
        '已装副本 ' + target,
        ...rows.map((r) => '  ' + mark(r.status) + ' ' + r.path + (r.note ? '（' + r.note + '）' : '')),
        drifted
          ? '结论：有漂移——用 --install <dir> 覆盖，或用 skills CLI 重新安装'
          : '结论：逐字节一致' + (extra.length ? '（' + extra.length + ' 个多余文件不计漂移）' : ''),
      ]
      return {
        exitCode: drifted ? EXIT.FINDINGS : EXIT.OK,
        human,
        data: { payload, target, drift: drifted, files: rows },
        ...(drifted ? { warnings: ['skill 与包内副本不一致：已装副本可能对应旧版本 CLI'] } : {}),
      }
    }

    const installDir = typeof ctx.values.install === 'string' ? ctx.values.install : undefined
    if (installDir !== undefined) {
      const target = join(installDir, SKILL_NAME)
      const written: string[] = []
      for (const rel of files) {
        const dst = join(target, ...rel.split('/'))
        mkdirSync(dirname(dst), { recursive: true })
        writeFileSync(dst, readFileSync(join(payload, ...rel.split('/'))))
        written.push(dst)
      }
      return {
        exitCode: EXIT.OK,
        human: [
          '已写出 ' + files.length + ' 个文件 → ' + target,
          ...written.map((w) => '  ' + w),
          '注：本命令只做逐字节复制；要 agent 自动更新请用 skills CLI（npx skills add …）',
        ],
        data: { payload, target, files: written },
        written,
      }
    }

    if (ctx.values.print === true) {
      const rows = readPayload(payload)
      const asJson = ctx.values.format === 'json'
      if (asJson) {
        return {
          exitCode: EXIT.OK,
          data: { payload, files: rows },
        }
      }
      const human: string[] = []
      for (const f of rows) {
        human.push('===== ' + f.path + ' =====')
        human.push(...f.text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'))
        human.push('')
      }
      return { exitCode: EXIT.OK, human, data: { payload, files: rows.map(({ text, ...rest }) => rest) } }
    }

    const rows = readPayload(payload)
    const total = rows.reduce((a, f) => a + f.bytes, 0)
    return {
      exitCode: EXIT.OK,
      human: [
        '包内 skill：' + payload,
        '文件 ' + rows.length + ' 个，共 ' + total + ' 字节（skill 不写自己的版本号——对齐用比字节）',
        ...rows.map((f) => '  ' + f.sha256.slice(0, 12) + '  ' + String(f.bytes).padStart(6) + '  ' + f.path),
        '下一步：maafw-live skill --check <安装根目录> 比对已装副本；--install <目录> 逐字节写出',
      ],
      data: { payload, files: rows.map(({ text, ...rest }) => rest) },
    }
  },
}
