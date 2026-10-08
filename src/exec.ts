/**
 * 外部命令执行封装。
 *
 * 约定：**永不抛异常**，一律返回结果对象。原因是环境探针的本质就是「探测可能不存在的东西」——
 * 缺 adb、缺 python、缺 git 都是正常结果，不是异常路径。
 */
import { execFile } from 'node:child_process'

export interface ExecResult {
  ok: boolean
  /** 进程退出码；被信号杀死或启动失败时为 null */
  code: number | null
  stdout: string
  stderr: string
  /** 启动失败的原因（ENOENT 等） */
  spawnError?: string
}

export interface ExecOptions {
  timeout?: number
  cwd?: string
  /** 传入 stdin 的内容 */
  input?: string
  /** 内部用：把参数按原样交给子进程（实现 cmd 的引号规则时需要，见 run()） */
  verbatim?: boolean
}

const DEFAULT_TIMEOUT = 8000

function once(bin: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    let child: ReturnType<typeof execFile>
    try {
      child = execFile(
        bin,
        args,
        {
          timeout: opts.timeout ?? DEFAULT_TIMEOUT,
          cwd: opts.cwd,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'utf8',
          windowsVerbatimArguments: opts.verbatim === true,
        },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
          if (!e) {
            resolve({ ok: true, code: 0, stdout: String(stdout), stderr: String(stderr) })
            return
          }
          // 启动失败（ENOENT/EACCES）与「跑起来但退出码非 0」要分开报
          const isSpawnFailure = typeof e.code === 'string'
          resolve({
            ok: false,
            code: isSpawnFailure ? null : typeof e.code === 'number' ? e.code : null,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            spawnError: isSpawnFailure ? e.code : undefined,
          })
        },
      )
    } catch (e) {
      /* execFile 在部分情况下是**同步**抛的（Windows 上直接跑 .cmd/.bat → EINVAL）。
       * 本模块的契约是「永不抛异常」：环境探针的本质就是探测可能不存在的东西，
       * 同步抛也必须收敛成结果对象，否则整个命令（如 env）会因为一个缺失的探测目标而失败。 */
      const err = e as NodeJS.ErrnoException
      resolve({
        ok: false, code: null, stdout: '', stderr: String(err?.message ?? e),
        spawnError: String(err?.code ?? 'EINVAL'),
      })
      return
    }
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input)
    }
  })
}

/** Windows：`where` 解析目标（含 PATHEXT），拿到可执行的绝对路径用于经 shell 执行。找不到返回 null。 */
async function wherePath(bin: string): Promise<string | null> {
  const r = await once('where', [bin], { timeout: 3000 })
  if (!r.ok) return null
  const all = String(r.stdout).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
  /* where 会同时列出无扩展名的 POSIX 壳（如 nodejs\npm，是给 sh 用的）与 npm.cmd；
   * cmd 只能跑后者，所以优先取可执行扩展名，避免拿到壳脚本后"跑不起来"。 */
  return all.find((p) => /\.(cmd|exe|bat)$/i.test(p)) ?? all[0] ?? null
}

/** 极简 cmd 引号：只在含空白/引号/元字符时加引号并转义内部引号。 */
function quoteForCmd(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? '"' + arg.replace(/"/g, '""') + '"' : arg
}

/**
 * 执行外部命令。
 *
 * Windows 上 `.cmd` / `.bat`（npm、npx、pnpm）不是可执行文件：execFile 直接跑会**同步抛 EINVAL**
 * （Node 对 CVE-2024-27980 的修复，本模块曾因此让 `env` 在只缺 adb 的机器上整条失败），
 * 所以先 `where` 解析出可执行路径，再经 `ComSpec` 执行。而 cmd 的引号规则有讲究：`/s` 会剥掉最外层
 * 引号，所以命令串要**整体再包一层引号**并配 `windowsVerbatimArguments`——实测
 * `cmd /d /s /c ""C:\Program Files\nodejs\npm.cmd" --version"` 是唯一能跑通的拼法。
 * 不直接用 `shell: true`：给 shell 传参会触发 `DEP0190` 弃用警告，且"命令不存在"会退化成
 * "cmd 跑起来了但退出 1"（本地化报错，判不准）。
 */
export async function run(bin: string, args: string[] = [], opts: ExecOptions = {}): Promise<ExecResult> {
  const first = await once(bin, args, opts)
  if (first.spawnError === 'ENOENT' && process.platform === 'win32' && !/\.(exe|cmd|bat|ps1)$/i.test(bin)) {
    const resolved = await wherePath(bin)
    if (resolved) {
      const comspec = process.env.ComSpec ?? 'cmd.exe'
      const line = [resolved, ...args].map(quoteForCmd).join(' ')
      const retry = await once(comspec, ['/d', '/s', '/c', '"' + line + '"'], { ...opts, verbatim: true })
      if (retry.ok || retry.code !== null) return retry
    }
  }
  return first
}

/** 取首行有效输出，供「版本号探测」这类场景用 */
export function firstLine(s: string): string {
  return s.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? ''
}
