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
}

const DEFAULT_TIMEOUT = 8000

function once(bin: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const child = execFile(
      bin,
      args,
      {
        timeout: opts.timeout ?? DEFAULT_TIMEOUT,
        cwd: opts.cwd,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
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
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input)
    }
  })
}

/**
 * 执行外部命令。
 *
 * Windows 上 `.cmd` / `.bat`（npm、npx、pnpm）不是可执行文件，execFile 找不到，
 * 因此在 win32 遇到 ENOENT 时补一次 `.cmd` 重试——这是本工作区反复踩到的坑
 * （同类问题还包括 WSL 建的符号链接 node 跟不进去）。
 */
export async function run(bin: string, args: string[] = [], opts: ExecOptions = {}): Promise<ExecResult> {
  const first = await once(bin, args, opts)
  if (first.spawnError === 'ENOENT' && process.platform === 'win32' && !/\.(exe|cmd|bat|ps1)$/i.test(bin)) {
    const retry = await once(bin + '.cmd', args, opts)
    if (!retry.spawnError) return retry
  }
  return first
}

/** 取首行有效输出，供「版本号探测」这类场景用 */
export function firstLine(s: string): string {
  return s.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? ''
}
