import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 从 CHANGELOG.md 提取一个已发布版本的段落，作为 GitHub Release notes。
 * 段落标题必须带日期（如 `## [0.1.0] - 2026-10-07`）——裸的 `## [Unreleased]`
 * 永远不会被误认成已发布版本。缺失或空段落以非零退出，空 notes 不许发。
 */
export function extractReleaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const heading = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\] - \\S+`)
  const start = lines.findIndex((line) => heading.test(line))
  if (start === -1) {
    throw new Error(`没有 "## [${version}] - <日期>" 段落`)
  }
  const body = []
  for (const line of lines.slice(start + 1)) {
    // 段落在下一个版本标题或文件底部的对比链接块处结束，最老的已发布段不会吞掉后面的链接定义
    if (line.startsWith('## [') || line.startsWith('[')) break
    body.push(line)
  }
  const notes = body.join('\n').trim()
  if (notes.length === 0) {
    throw new Error(`${version} 的段落是空的`)
  }
  return notes
}

async function main() {
  const [rawVersion, changelogPath] = process.argv.slice(2)
  if (rawVersion === undefined) {
    console.error('用法：node scripts/release-notes.mjs <version> [changelog]')
    process.exitCode = 1
    return
  }
  const version = rawVersion.replace(/^v/, '')
  const source = changelogPath ?? path.join(repositoryRoot, 'CHANGELOG.md')
  try {
    const notes = extractReleaseNotes(await readFile(source, 'utf8'), version)
    process.stdout.write(`${notes}\n`)
  } catch (error) {
    console.error(`${path.basename(source)}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  await main()
}
