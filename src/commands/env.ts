/**
 * `maafw-live env` —— 环境与能力探针。
 *
 * 这是整个 CLI 的前置命令：技能在动手前先问它「现在有什么」，而不是各自写一遍检测。
 * 因此它有一条硬要求：**它本身永远不能因为环境残缺而失败**。缺 adb、缺 python、
 * 缺框架源码都是「探测结果」，不是错误。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, type Command, type CommandResult } from '../protocol.js'
import { firstLine, run } from '../exec.js'
import { loadInterface, resolveResourcePaths } from '../interface/index.js'

type Status = 'ok' | 'warn' | 'missing'

interface Item {
  key: string
  status: Status
  detail: string
}

/** 向上找 Maa 项目根：interface.json / maa-project.json 是可靠边界 */
function findProjectRoot(start: string): string | null {
  let dir = resolve(start)
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'interface.json')) || existsSync(join(dir, 'maa-project.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** 从 interface.json 的 resource 声明推导 pipeline 目录；找不到时退回常见目录 */
function pipelineDirs(root: string): string[] {
  const out = new Set<string>()
  for (const p of resolveResourcePaths(loadInterface(root)).paths) {
    const dir = join(p, 'pipeline')
    if (existsSync(dir)) out.add(dir)
  }
  for (const f of ['resource/base/pipeline', 'resource/pipeline', 'pipeline']) {
    const dir = join(root, f)
    if (existsSync(dir)) out.add(dir)
  }
  return [...out]
}

/** 解析 @maaxyz/maa-node。它可能没导出 package.json，故从入口向上找包根 */
function resolveMaaNode(from: string): { version: string; path: string } | null {
  try {
    const req = createRequire(join(from, '__maa_cli_probe__.js'))
    const entry = req.resolve('@maaxyz/maa-node')
    let dir = dirname(entry)
    for (let i = 0; i < 6; i++) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const j = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
        return { version: j.version ?? 'unknown', path: dir }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    /* 未安装 */
  }
  return null
}

/** 本包自身所在目录：把运行时绑定当依赖解析，而不是指望调用方目录里恰好有它 */
function selfDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/**
 * 取 checkout 的 schema 快照版本。
 *
 * checkout 的版本快照用 git describe 取；取不到就是空串——探针不因环境残缺而失败。
 */
async function checkoutVersion(checkout: string, gitBin: string): Promise<string> {
  const r = await run(gitBin, ['-C', checkout, 'describe', '--tags'], { timeout: 5000 })
  return r.ok ? firstLine(r.stdout) : ''
}

function mark(status: Status): string {
  return status === 'ok' ? '[ ok ]' : status === 'warn' ? '[warn]' : '[ -- ]'
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

export const envCommand: Command = {
  name: 'env',
  summary: '探测环境与能力：项目、运行时绑定、外部工具（框架源码对账见 --checkout）',
  usage: 'maafw-live env [--checkout <MaaFramework 源码目录>] [--git <bin>] [--deep]',
  options: {
    checkout: { type: 'string' },
    maafw: { type: 'string' },   // 兼容别名：等价于 --checkout
    git: { type: 'string' },
    deep: { type: 'boolean' },
  },

  async run(ctx): Promise<CommandResult> {
    const cwd = ctx.cwd
    /* 框架源码只服务于「版本对账」这一件事，只有框架开发与静态校验才需要它——写 Maa 应用的
       人不该被要求 clone MaaFramework，所以不传就完全不出现这一项。--maafw 保留为兼容别名。 */
    const maafw = String(
      ctx.values.checkout ?? ctx.values.maafw ?? process.env.MAAFW_CHECKOUT ?? process.env.MAAFW_DIR ?? '',
    )
    const gitBin = String(ctx.values.git ?? 'git')
    const deep = ctx.values.deep === true

    const projectRoot = findProjectRoot(cwd)
    const dirs = projectRoot ? pipelineDirs(projectRoot) : []

    /* 运行时绑定是本包自己的依赖：按包自身解析即可；项目目录里的副本优先（项目可能 pin 了别的版本） */
    const maaNode = resolveMaaNode(cwd) ?? resolveMaaNode(selfDir())

    const [checkoutVer, gitV, adbV, pyV] = await Promise.all([
      existsSync(maafw) ? checkoutVersion(maafw, gitBin) : Promise.resolve(''),
      run(gitBin, ['--version'], { timeout: 5000 }),
      run('adb', ['version'], { timeout: 5000 }),
      run('python', ['--version'], { timeout: 5000 }),
    ])

    const items: Item[] = []

    items.push({
      key: 'runtime',
      status: 'ok',
      detail: `node ${process.version} · ${process.platform} ${process.arch}`,
    })

    items.push({
      key: 'cwd',
      status: 'ok',
      detail: cwd,
    })

    items.push({
      key: 'project',
      status: projectRoot ? 'ok' : 'warn',
      detail: projectRoot
        ? `${projectRoot}${dirs.length ? '  (pipeline: ' + dirs.join(', ') + ')' : '  (未发现 pipeline 目录)'}`
        : '未找到 interface.json / maa-project.json（当前目录不在 Maa 项目内）',
    })

    items.push({
      key: 'maa-node',
      status: maaNode ? 'ok' : 'missing',
      detail: maaNode ? `${maaNode.version}  (${maaNode.path})` : '未安装（运行时命令不可用）',
    })

    /* 显式给了源码目录才出现：应用开发者的机器上不该看到一个「缺一项」 */
    if (maafw) items.push({
      key: 'framework',
      status: !existsSync(maafw) ? 'missing' : checkoutVer ? 'ok' : 'warn',
      /* 进到这里 maafw 必然非空，"未提供源码目录"那一支是死的（曾经留着） */
      detail: !existsSync(maafw)
        ? `checkout 不存在：${maafw}`
        : checkoutVer
          ? `${checkoutVer}  (${maafw})`
          : `存在但 git describe 失败：${maafw}`,
    })

    items.push({
      key: 'git',
      status: gitV.ok ? 'ok' : 'warn',
      detail: gitV.ok ? firstLine(gitV.stdout || gitV.stderr) : '不可用（仅版本对账与迁移脚本需要）',
    })

    // adb 与 python 是「按需」依赖：只有设备类命令和 v5 迁移脚本需要，
    // 缺失不影响其余功能，因此记 warn 而不是 missing（不拉高退出码）。
    items.push({
      key: 'adb',
      status: adbV.ok ? 'ok' : 'warn',
      detail: adbV.ok ? firstLine(adbV.stdout || adbV.stderr) : '不可用（设备类命令需要它）',
    })

    items.push({
      key: 'python',
      status: pyV.ok ? 'ok' : 'warn',
      detail: pyV.ok
        ? firstLine(pyV.stdout || pyV.stderr)
        : '不可用（migrate_pipeline_v5.py 需要它）',
    })

    if (deep) {
      const npm = await run('npm', ['--version'], { timeout: 8000 })
      items.push({
        key: 'npm',
        status: npm.ok ? 'ok' : 'missing',
        detail: npm.ok ? `npm ${firstLine(npm.stdout)}` : '不可用',
      })
      for (const pkg of ['maa-evidence-kit', 'create-maa-project']) {
        const r = await run('npm', ['ls', '-g', '--depth=0', pkg], { timeout: 15000 })
        const installed = r.ok && r.stdout.includes(pkg)
        items.push({
          key: pkg,
          status: installed ? 'ok' : 'warn',
          detail: installed ? '已全局安装' : '未全局安装',
        })
      }
    }

    const width = Math.max(...items.map((i) => i.key.length))
    const human = [
      'maafw-live env',
      ...items.map((i) => `  ${mark(i.status)} ${pad(i.key, width)}  ${i.detail}`),
    ]

    const missing = items.filter((i) => i.status === 'missing')
    const warnings = missing.map((i) => `${i.key}: ${i.detail}`)

    return {
      exitCode: missing.length > 0 ? EXIT.ENV : EXIT.OK,
      root: projectRoot,
      human,
      warnings,
      data: {
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        cwd,
        project: { root: projectRoot, pipelineDirs: dirs },
        maaNode,
        framework: maafw
          ? {
              checkout: { path: maafw, found: existsSync(maafw), version: checkoutVer },
              native: maaNode?.version ?? null,
            }
          : null,
        tools: {
          git: { available: gitV.ok, version: gitV.ok ? firstLine(gitV.stdout || gitV.stderr) : '' },
          adb: { available: adbV.ok, version: adbV.ok ? firstLine(adbV.stdout || adbV.stderr) : '' },
          python: { available: pyV.ok, version: pyV.ok ? firstLine(pyV.stdout || pyV.stderr) : '' },
        },
      },
    }
  },
}
