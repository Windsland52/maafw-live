/**
 * 命名会话（`repl --session <name>`）的 IPC 面。
 *
 * 为什么需要它（本仓 G12）：daemon 连接是**进程态**——帧流、L0 热缓存、事件环都活在
 * repl 会话里，而一次性命令退出即销毁。此前想跨命令复用，只能自建常驻驱动
 * （`repl-driver.mjs` 那种：spawn 一个 repl、持续喂 stdin、把 stdout 落盘、再读文件）。
 * 每个使用者都重写一遍同一套东西，且各有各的坑（stdin 不是管道、shim 引号、EOF 即退出）。
 *
 * 这里把那条驱动收进工具本体：`--session <name>` 首次调用时**脱离父进程**起一个常驻
 * repl（daemon 随之长活），后续同 name 的调用把命令行经命名管道送进去、把回执读回来。
 *
 * 三个设计约束（都是踩过的坑，不是偏好）：
 *
 * ① **不能用 stdin 喂**：PowerShell 没法把命名管道当 stdin 递给子进程（本仓
 *    `.live/repl-driver.mjs` 头注释记的就是这条）。所以常驻进程走 `--session-serve`
 *    从**命名管道**读命令，而不是从 stdin。
 *
 * ② **必须脱离父进程**：常驻进程若挂在调用方的作业对象下，父命令一退就被一起收走，
 *    第二次调用就找不到会话了。Windows 上用 detached + unref。
 *
 * ③ **回执要有边界**：管道是字节流，多行回执之间必须能切分。用「一行一条 JSON 信封」，
 *    每条命令带 id，调用方读到自己的 id 为止——不靠 sleep 猜，也不靠读空判断。
 *
 * 命名空间按 **用户 + 会话名** 隔离，会话名做白名单清洗（它要进文件路径与管道名，
 * 不能让 `..` 或路径分隔符穿过去）。
 */
import { createServer, connect, type Server, type Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 会话名白名单：字母数字与 `-` `_`，1..48 字符。要进管道名与文件路径，必须收紧。 */
export function validSessionName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,48}$/.test(name)
}

/** 会话目录：`~/.maafw-live/sessions/<name>/`（与 frames 同级，都是本工具的本地状态）。 */
export function sessionDir(name: string): string {
  return join(homedir(), '.maafw-live', 'sessions', name)
}

/** Windows 命名管道名；其它平台退回 Unix domain socket 路径（同一份代码，两个平台都能跑）。 */
export function sessionPipePath(name: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\maafw-live-${name}`
  return join(sessionDir(name), 'sock')
}

export interface SessionMeta {
    name: string
    pid: number
    pipe: string
    startedAt: string
    /** 起会话时给的连接参数，便于诊断"为什么这条会话连的是别的设备" */
    connectArgs: Record<string, unknown>
}

export function sessionMetaPath(name: string): string {
    return join(sessionDir(name), 'meta.json')
}

export function readSessionMeta(name: string): SessionMeta | null {
    const p = sessionMetaPath(name)
    if (!existsSync(p)) return null
    try {
        return JSON.parse(readFileSync(p, 'utf8')) as SessionMeta
    } catch {
        return null
    }
}

/** 进程还活着吗（`process.kill(pid, 0)` 不真发信号，只做存在性检查）。 */
export function pidAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
        return true
    } catch (e) {
        /* EPERM = 进程存在但没权限发信号，仍算活着；ESRCH 才是没了 */
        return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
}

/** 一条命令的请求/回执信封。`lines` 是 repl 该命令打出的全部输出行（按序）。 */
export interface ServeRequest {
    id: number
    line: string
}
export interface ServeReply {
    id: number
    ok: boolean
    lines: string[]
    error?: string
    /** `quit`/`exit` 之后常驻进程会自行收尾 */
    closing?: boolean
}

/** 常驻侧回执的**调用方可见部分**：`lines` 由服务端从已收集的输出填，调用方不必传
 * （显式给 `lines: []` 也不报错——服务端一律以自己的缓冲为准，避免两处都以为自己说了算）。 */
export interface ServeReplyInput {
    ok: boolean
    lines?: string[]
    error?: string
    /** `quit`/`exit` 之后常驻进程会自行收尾 */
    closing?: boolean
}

/** 常驻侧：把 repl 的输出按"命令"切段回给调用方。 */
export class SessionServer {
    private server: Server | null = null
    private readonly sockets = new Set<Socket>()
    /** 串行队列：会话共用一条设备连接，命令必须一条条跑完再下一条 */
    private readonly pending: Array<() => void> = []
    private buffer: string[] = []
    private current: { id: number; socket: Socket } | null = null

    constructor(private readonly onLine: (line: string, reply: (r: ServeReplyInput) => void) => void) {}

    /** 供 repl 循环调用：把一行输出归到当前命令的回执里。
     *
     * **没有当前命令时不是丢弃，而是挂到"待认领"队列**：`run` 这类命令是异步收尾的
     * （提交后立刻返回，`run 完成…` 稍后才打），而回执在那之前就发出去了——丢掉的话
     * 调用方永远看不到任务结果。挂起来随下一条命令的回执一起给，轮询式用法正好能拿到。
     * 队列有上限：没人认领时不能无限涨（常驻会话可能几天没人问）。 */
    pushOutput(line: string): void {
        if (!this.current) {
            this.unclaimed.push(line)
            if (this.unclaimed.length > 200) this.unclaimed.splice(0, this.unclaimed.length - 200)
            return
        }
        this.buffer.push(line)
    }

    /** 连接横幅等：等价于"还没有命令时打的输出"，与异步收尾共用同一条待认领队列。 */
    pushStartup(line: string): void {
        this.pushOutput(line)
    }

    private readonly unclaimed: string[] = []

    private reply(r: ServeReplyInput): void {
        const cur = this.current
        if (!cur) return
        this.current = null
        /* 一律以服务端缓冲为准：调用方给的 lines 只是形状占位，不能覆盖实际输出 */
        const payload: ServeReply = { id: cur.id, ok: r.ok, ...(r.error ? { error: r.error } : {}), ...(r.closing ? { closing: true } : {}), lines: this.buffer }
        this.buffer = []
        try {
            cur.socket.write(JSON.stringify(payload) + '\n')
        } catch {
            /* 调用方可能已断开（超时先走），不影响会话继续 */
        }
    }

    listen(pipe: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = createServer((socket) => {
                this.sockets.add(socket)
                socket.setEncoding('utf8')
                let buf = ''
                socket.on('data', (chunk: string) => {
                    buf += chunk
                    let i
                    while ((i = buf.indexOf('\n')) >= 0) {
                        const raw = buf.slice(0, i)
                        buf = buf.slice(i + 1)
                        if (!raw.trim()) continue
                        let req: ServeRequest
                        try {
                            req = JSON.parse(raw) as ServeRequest
                        } catch {
                            socket.write(JSON.stringify({ id: -1, ok: false, lines: [], error: '请求不是合法 JSON' }) + '\n')
                            continue
                        }
                        /* 同一时刻只允许一条在跑：会话是**串行**的（共用一条设备连接，
                         * 并发会让两条命令交错读同一份状态）。后到的排队等前一条回执。 */
                        const run = (): void => {
                            this.current = { id: req.id, socket }
                            /* 待认领的输出（连接横幅、上一条异步命令的收尾）先给，再按本命令的
                             * 实测输出追加——顺序即时间序，调用方读起来才与交互式 repl 一致。 */
                            this.buffer = this.unclaimed.splice(0, this.unclaimed.length)
                            try {
                                this.onLine(req.line, (r) => {
                                    this.reply(r)
                                    const next = this.pending.shift()
                                    if (next) next()
                                })
                            } catch (e) {
                                this.reply({ ok: false, lines: [], error: e instanceof Error ? e.message : String(e) })
                                const next = this.pending.shift()
                                if (next) next()
                            }
                        }
                        if (this.current) this.pending.push(run)
                        else run()
                    }
                })
                socket.on('error', () => this.sockets.delete(socket))
                socket.on('close', () => this.sockets.delete(socket))
            })
            server.on('error', reject)
            server.listen(pipe, () => {
                this.server = server
                resolve()
            })
        })
    }

    close(): void {
        for (const s of this.sockets) {
            try {
                s.destroy()
            } catch {
                /* ignore */
            }
        }
        this.sockets.clear()
        try {
            this.server?.close()
        } catch {
            /* ignore */
        }
    }
}

/** 调用侧：把一条命令送到已存在的会话，等它那条回执。 */
export async function sendToSession(
    meta: SessionMeta,
    line: string,
    timeoutMs: number,
): Promise<ServeReply> {
    return await new Promise<ServeReply>((resolve, reject) => {
        const sock = connect(meta.pipe)
        const id = Date.now() % 1_000_000_000
        let buf = ''
        const done = (fn: () => void): void => {
            clearTimeout(timer)
            try {
                sock.destroy()
            } catch {
                /* ignore */
            }
            fn()
        }
        const timer = setTimeout(() => {
            done(() => reject(new Error(`会话 '${meta.name}' 在 ${timeoutMs}ms 内没有回执（会话可能卡在一条长命令上；先 quit 再重试）`)))
        }, timeoutMs)
        sock.setEncoding('utf8')
        sock.on('connect', () => sock.write(JSON.stringify({ id, line }) + '\n'))
        sock.on('data', (chunk: string) => {
            buf += chunk
            let i
            while ((i = buf.indexOf('\n')) >= 0) {
                const raw = buf.slice(0, i)
                buf = buf.slice(i + 1)
                if (!raw.trim()) continue
                let rep: ServeReply
                try {
                    rep = JSON.parse(raw) as ServeReply
                } catch {
                    continue
                }
                if (rep.id !== id) continue
                done(() => resolve(rep))
                return
            }
        })
        sock.on('error', (e) => done(() => reject(e)))
    })
}

/** 起一个脱离父进程的常驻会话（`--session-serve` 模式）。 */
export function spawnSessionServer(name: string, cliEntry: string, connectArgs: Record<string, unknown>): SessionMeta {
    const dir = sessionDir(name)
    mkdirSync(dir, { recursive: true })
    const pipe = sessionPipePath(name)
    const args = [cliEntry, 'repl', '--session-serve', name, ...connectArgsToArgv(connectArgs)]
    const child = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    })
    child.unref()
    const meta: SessionMeta = {
        name,
        pid: child.pid ?? 0,
        pipe,
        startedAt: new Date().toISOString(),
        connectArgs,
    }
    writeFileSync(sessionMetaPath(name), JSON.stringify(meta, null, 2))
    return meta
}

/** 连接参数 → argv（会话常驻进程用同一套 CLI 旗标启动，不另造一套参数面）。 */
export function connectArgsToArgv(a: Record<string, unknown>): string[] {
    const out: string[] = []
    for (const [k, v] of Object.entries(a)) {
        if (v === undefined || v === null) continue
        out.push('--' + k, String(v))
    }
    return out
}

/** 等管道可连（常驻进程起来要时间；轮询到超时为止，不靠固定 sleep）。 */
export async function waitPipeReady(pipe: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const ok = await new Promise<boolean>((resolve) => {
            const sock = connect(pipe)
            sock.on('connect', () => {
                sock.destroy()
                resolve(true)
            })
            sock.on('error', () => {
                sock.destroy()
                resolve(false)
            })
        })
        if (ok) return true
        if (Date.now() > deadline) return false
        await new Promise((r) => setTimeout(r, 100))
    }
}

/** 收掉一条会话（清 meta 与目录，管道随进程退出消失）。 */
export function stopSession(name: string): void {
    const meta = readSessionMeta(name)
    if (meta && pidAlive(meta.pid)) {
        try {
            process.kill(meta.pid)
        } catch {
            /* ignore */
        }
    }
    try {
        rmSync(sessionDir(name), { recursive: true, force: true })
    } catch {
        /* ignore */
    }
}
