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
 * 项目对 maa-node 的 pin 声明。
 *
 * 只认两处「项目自己写的声明」：package.json 的依赖声明、requirements.txt 的 MaaFW/maa 行。
 * uv.lock 是求解结果而非声明，只在两者都没有时记一笔来源，不解析、不对账。
 */
interface MaaNodePin {
  source: 'package.json' | 'requirements.txt' | 'uv.lock'
  declared: string
  /** 精确版本；范围声明与 uv.lock 辅证都是 null——不自己造 semver 解析 */
  exact: string | null
}

/**
 * 精确版本判定：`5.14.2` / `=5.14.2` / `==5.14.2` / `v5.14.2`，以及 PEP 440 的
 * 预发布/后发布后缀（`5.15.0a1`、`5.15.0b1`、`5.15.0rc1`、`5.15.0.dev1`、`5.15.0.post1`）
 * 才算「就是这个版本」。
 *
 * 后缀不改变「唯一确定」这一点：Python 绑定发布的正是 `MaaFW==5.15.0b1` 这种写法，
 * 判成范围就等于对真正要防的那个不一致视而不见。
 *
 * `^5.14.2`、`>=5.14` 这类范围要 semver 解析才能判等，本工具不替 npm/pip 做这件事：
 * 判错了比不判更坏，调用方会据此去改依赖。
 */
function exactVersion(spec: string): string | null {
  const m = /^(?:==|=)?\s*v?(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+|(?:a|b|c|rc|alpha|beta|pre|preview|post|dev)\d*)?)$/i.exec(
    spec.trim(),
  )
  return m ? m[1]! : null
}

/**
 * 把精确版本拆成 release 线与 qualifier：`5.15.0b1` → `5.15.0` + `b1`。
 *
 * 对账要分别看两段：release 线不同是换了个版本，qualifier 不同是同一条线上另一份构建。
 * 只比字符串会把 `5.15.0` 与 `5.15.0b1` 当成无关，只比 release 又会把预发布报成一致。
 */
function splitRelease(version: string): { release: string; qualifier: string } | null {
  const m = /^(\d+\.\d+\.\d+)(.*)$/.exec(version.trim())
  return m ? { release: m[1]!, qualifier: m[2] ?? '' } : null
}

function pinFromPackageJson(root: string): MaaNodePin | null {
  const file = join(root, 'package.json')
  if (!existsSync(file)) return null
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    for (const field of ['dependencies', 'devDependencies']) {
      const group = j[field]
      if (!group || typeof group !== 'object') continue
      const v = (group as Record<string, unknown>)['@maaxyz/maa-node']
      if (typeof v === 'string' && v.trim()) {
        return { source: 'package.json', declared: v.trim(), exact: exactVersion(v) }
      }
    }
  } catch {
    /* package.json 坏了就当这个源没有 pin：探针不因环境残缺而失败 */
  }
  return null
}

function pinFromRequirements(root: string): MaaNodePin | null {
  const file = join(root, 'requirements.txt')
  if (!existsSync(file)) return null
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  for (const raw of text.split(/\r?\n/)) {
    /* 注释与 environment marker 都是环境噪音，只看「包名 + 版本声明」这一截。
       PyPI 上的绑定包名是 `MaaFW`，老项目写成 `maa`，两种都是同一个包，大小写不敏感；
       负向前瞻保证只认独立的包名：maa-evidence-kit、maa_x、maafw2 是别的包。 */
    const body = (raw.split('#')[0] ?? '').split(';')[0]!.trim()
    const m = /^(?:maafw|maa)(?![\w.-])(?:\[[^\]]*\])?\s*(===|==|>=|<=|~=|!=|>|<|=)?\s*([^\s;#]*)$/i.exec(body)
    if (!m) continue
    return { source: 'requirements.txt', declared: body, exact: exactVersion((m[1] ?? '') + (m[2] ?? '')) }
  }
  return null
}

function readMaaNodePin(root: string): MaaNodePin | null {
  const pkg = pinFromPackageJson(root)
  const req = pinFromRequirements(root)
  /* 两处都读：范围声明回答不了「跑的是不是同一版」这个等式，只能回答「落没落在区间里」，
     精确声明才能。所以按 package.json 精确 → requirements.txt 精确 → package.json 范围 →
     requirements.txt 范围取第一个；见到 package.json 的任何声明就收工，会把另一处的精确 pin
     顶掉，而不一致正是靠那个精确 pin 才发现的。 */
  for (const candidate of [pkg?.exact ? pkg : null, req?.exact ? req : null, pkg, req]) {
    if (candidate) return candidate
  }
  /* 两个声明源都拿不到才记 uv.lock：它只说明「求解过」，不产生 warning */
  return existsSync(join(root, 'uv.lock')) ? { source: 'uv.lock', declared: '', exact: null } : null
}

/** Windows 的路径大小写不敏感：同一份依赖不该因为盘符/目录大小写而被报成两份 */
function samePath(a: string, b: string): boolean {
  const na = resolve(a)
  const nb = resolve(b)
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb
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

    /* 运行时绑定是本包自己的依赖：self 才是 CLI 真正会 require 到的那份。
       cwd 的副本只用来对照「项目可能 pin 了别的版本」，它不决定本 CLI 加载什么。 */
    const self = resolveMaaNode(selfDir())
    const cwdCopy = resolveMaaNode(cwd)

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
      status: self ? 'ok' : 'missing',
      detail: self ? `${self.version}  (${self.path})` : '未安装（运行时命令不可用）',
    })

    /* 并列而不是覆盖：全局安装时 cwd 的那份不会被加载，报成同一个版本会误导排查 */
    if (cwdCopy && (!self || !samePath(self.path, cwdCopy.path))) {
      items.push({
        key: 'maa-node(cwd)',
        status: 'warn',
        detail: `${cwdCopy.version}  (${cwdCopy.path})  — 项目目录里的副本，本 CLI 不加载它`,
      })
    }

    /* 项目 pin 只与 self 对账：比的是「正在运行的那份」，不是项目里躺着的那份 */
    const pin = projectRoot ? readMaaNodePin(projectRoot) : null
    const pinWarnings: string[] = []
    if (pin && pin.source !== 'uv.lock') {
      if (pin.exact === null) {
        items.push({
          key: 'maa-node pin',
          status: 'ok',
          detail: `${pin.declared}（${pin.source}）—— 范围声明，不比对`,
        })
      } else if (!self) {
        items.push({
          key: 'maa-node pin',
          status: 'warn',
          detail: `${pin.declared}（${pin.source}）—— CLI 实际加载的 maa-node 未安装，无法比对`,
        })
      } else {
        /* 只按 release 线判：`5.15.0b1` 与 `5.15.0-beta.1` 是同一条线上的同一份构建，只差两个
           生态的写法；报成不一致，用户会去改一条本来正确的 pin。qualifier 的差别只在 detail
           里陈述，不升级成 warning。 */
        const pinV = splitRelease(pin.exact)
        const runV = splitRelease(self.version)
        const mismatch = (): void => {
          const detail = `项目 pin ${pin.declared}（${pin.source}），CLI 实际加载 ${self.version}`
          items.push({ key: 'maa-node pin', status: 'warn', detail })
          pinWarnings.push(`maa-node 版本不一致：${detail}`)
        }
        if (!pinV || !runV) {
          /* 有一边不是 x.y.z 形态（自定义构建号之类）：没有 release 线可比，只能退回整串 */
          if (pin.exact === self.version) {
            items.push({
              key: 'maa-node pin',
              status: 'ok',
              detail: `${pin.exact}（${pin.source}）与 CLI 实际加载一致`,
            })
          } else {
            mismatch()
          }
        } else if (pinV.release !== runV.release) {
          mismatch()
        } else if (pinV.qualifier === runV.qualifier) {
          items.push({
            key: 'maa-node pin',
            status: 'ok',
            detail: `${pin.exact}（${pin.source}）与 CLI 实际加载一致`,
          })
        } else {
          items.push({
            key: 'maa-node pin',
            status: 'ok',
            detail:
              `同 release 线 ${pinV.release}：声明 ${pin.exact} / 实际 ${self.version}` +
              `（拼写不同不算不一致）`,
          })
        }
      }
    }

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
    warnings.push(...pinWarnings)

    return {
      exitCode: missing.length > 0 ? EXIT.ENV : EXIT.OK,
      root: projectRoot,
      human,
      warnings,
      data: {
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        cwd,
        project: { root: projectRoot, pipelineDirs: dirs },
        maaNode: self,
        /** cwd 那份副本，仅作对照：它不是 CLI 实际加载的那份 */
        maaNodeCwd: cwdCopy,
        /** 项目声明的 pin：只用 package.json / requirements.txt 下结论，uv.lock 仅记来源 */
        maaNodePin: pin,
        framework: maafw
          ? {
              checkout: { path: maafw, found: existsSync(maafw), version: checkoutVer },
              native: self?.version ?? null,
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
