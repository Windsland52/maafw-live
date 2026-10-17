/**
 * 命名常驻会话（`repl --session <name>`）—— 本仓 G12。
 *
 * 痛点原文：「repl stdin 需常驻驱动 ❌ 仍开 —— 仍要自建 `repl-driver.mjs`；无 `--session`」。
 * 根因是 daemon 连接是**进程态**（帧流、L0 热缓存、事件环都活在 repl 进程里），
 * 而一次性命令退出即销毁。此前跨命令复用只能自建驱动：spawn 一个 repl、持续喂 stdin、
 * 把 stdout 落盘、再读文件——每个使用者都重写一遍，各有各的坑。
 *
 * 这里钉住的是「不用驱动也能跨进程复用」：
 *   ① 首次 `--session <name> <cmd>` 起常驻会话并执行，**脱离父进程**（父命令退出不带它走）；
 *   ② 后续同 name 的**独立进程**调用复用同一个会话（设备连接、L0、事件环都保住）；
 *   ③ 回执按命令切段（一行一条 JSON 信封，带 id）——不靠 sleep 猜；
 *   ④ `quit` / `--session-stop` 收得掉，且幂等；
 *   ⑤ 会话名做白名单（它要进管道名与文件路径）。
 *
 * 不碰设备：用**记录型桩 daemon**（`MAA_DAEMON`）。桩是每次调用各起一个进程，所以
 * "跨调用复用了同一个 daemon"这件事本身无法用桩证明——那部分靠真机回执（见提交信息）。
 * 这里测的是**会话机制**：起、复用、串行、状态、收尾、名字校验、错误路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'maafw-live.mjs')
const STUB = join(HERE, 'fixtures', 'stub-recording-daemon.mjs')

/** 唯一会话名，避免与真机/其它测试的会话撞名 */
let seq = 0
const sessionName = () => 't' + process.pid.toString(36) + (seq++).toString(36)

/* 桩 daemon 的记账文件必须活到**会话结束**，不能随每次 runCli 的临时目录一起删：
 * 常驻会话里的 daemon 是**跨调用**存活的，它每次收到命令都要 append 到这个文件——
 * 文件所在目录被删掉的话 append 失败，桩自己崩掉（表现为"第二条命令报 daemon 已退出"）。
 * 所以按会话名给一份独立的、由测试自己在 t.after 里收的日志路径。 */
const logDirs = new Map()
function stubLogFor(name) {
    if (!logDirs.has(name)) {
        const dir = mkdtempSync(join(tmpdir(), 'maafw-sesslog-'))
        logDirs.set(name, join(dir, 'requests.jsonl'))
    }
    return { path: logDirs.get(name), dir: dirname(logDirs.get(name)) }
}
function dropStubLog(name) {
    const dir = logDirs.get(name)
    if (!dir) return
    try {
        rmSync(dirname(dir), { recursive: true, force: true })
    } catch {
        /* ignore */
    }
    logDirs.delete(name)
}

/** 跑一次性 CLI，返回 stdout/stderr 与退出码。`logPath` 指定桩的记账文件（会话级复用）。 */
async function runCli(args, logPath, timeoutMs = 30000) {
    const dir = mkdtempSync(join(tmpdir(), 'maafw-sess-'))
    const child = spawn(process.execPath, [CLI, ...args], {
        env: {
            ...process.env,
            MAA_DAEMON: STUB,
            ...(logPath ? { MAAFW_STUB_LOG: logPath } : { MAAFW_STUB_LOG: join(dir, 'requests.jsonl') }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (out += String(d)))
    const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            try {
                child.kill()
            } catch {
                /* ignore */
            }
            reject(new Error(timeoutMs + 'ms 内没退出（输出尾部：' + out.slice(-500) + '）'))
        }, timeoutMs)
        child.on('exit', (c) => {
            clearTimeout(timer)
            resolve(c)
        })
    })
    try {
        rmSync(dir, { recursive: true, force: true })
    } catch {
        /* ignore */
    }
    return { out, code }
}

/** 收尾：不留下常驻进程（测试失败时也要收） */
async function cleanup(name) {
    try {
        await runCli(['repl', '--session', name, '--session-stop'], null, 20000)
    } catch {
        /* ignore */
    }
    dropStubLog(name)
}

test('命名会话：首次调用起会话并执行，后续独立进程复用同一会话', async (t) => {
    const name = sessionName()
    const logPath = stubLogFor(name).path
    t.after(() => cleanup(name))

    // ① 首次：起常驻会话 + 执行第一条命令
    const first = await runCli(['repl', '--session', name, '--kind', 'adb', '--target', 'stub', '--cmd', 'probe'], logPath)
    assert.equal(first.code, 0, '首次调用应成功：' + first.out)
    assert.match(first.out, /已连接/, '启动横幅要在第一条回执里给出（"会话连到了什么"）：' + first.out)
    assert.match(first.out, /\{"ok":true\}/, '命令本身要执行（桩对 probe 回 ok:true）：' + first.out)

    // ② 第二个独立进程：复用同一会话（桩是新的，但会话进程是同一个）
    const second = await runCli(['repl', '--session', name, '--cmd', 'probe'], logPath)
    assert.equal(second.code, 0, '复用调用应成功：' + second.out)
    assert.match(second.out, /\{"ok":true\}/, '第二条命令也要真的执行：' + second.out)
    assert.doesNotMatch(second.out, /已连接/, '启动横幅只跟第一条命令走，不重复：' + second.out)

    // ③ 状态可查
    const status = await runCli(['repl', '--session', name, '--session-status'], logPath)
    assert.match(status.out, /在跑/, '状态应报"在跑"：' + status.out)
    assert.match(status.out, /maafw-live-/, '要报出管道名，便于诊断：' + status.out)
})

test('命名会话：一次送多条命令按序串行执行', async (t) => {
    const name = sessionName()
    const logPath = stubLogFor(name).path
    t.after(() => cleanup(name))

    const r = await runCli(['repl', '--session', name, '--kind', 'adb', '--target', 'stub', '--cmd', 'probe', '--cmd', 'frame status', '--cmd', 'kf status'], logPath)
    assert.equal(r.code, 0, '多条命令应全部成功：' + r.out)
    /* 桩对三条命令都回 ok:true，"都执行了"用条数证明；顺序用"回执不乱"证明——
     * 每条命令一段，段数 = 命令数（衔接处不会串行错位）。 */
    const okCount = (r.out.match(/\{"ok":true\}/g) ?? []).length
    assert.equal(okCount, 3, '三条命令各出一份回执（实际 ' + okCount + '）：' + r.out)
    assert.match(r.out, /已连接/, '启动横幅在最前：' + r.out)
})

test('命名会话：quit 收掉会话，之后状态报不存在（收尾不留常驻进程）', async (t) => {
    const name = sessionName()
    const logPath = stubLogFor(name).path
    t.after(() => cleanup(name))

    await runCli(['repl', '--session', name, '--kind', 'adb', '--target', 'stub', '--cmd', 'probe'], logPath)
    const q = await runCli(['repl', '--session', name, '--cmd', 'quit'], logPath)
    assert.equal(q.code, 0, 'quit 应正常返回：' + q.out)

    // 常驻进程收尾有 150ms 的延后（先把回执写出去），轮询等它退出
    let gone = false
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
        const st = await runCli(['repl', '--session', name, '--session-status'], logPath, 20000)
        if (/不存在/.test(st.out)) {
            gone = true
            break
        }
        await new Promise((r) => setTimeout(r, 300))
    }
    assert.ok(gone, 'quit 之后会话应消失（不留下常驻进程）')
})

test('命名会话：--session-stop 幂等（会话不存在也返回 0）', async () => {
    const name = sessionName()
    const r1 = await runCli(['repl', '--session', name, '--session-stop'], null)
    assert.equal(r1.code, 0, '收一个不存在的会话不该失败：' + r1.out)
    assert.match(r1.out, /不存在/, '要说清"无需收"：' + r1.out)
})

/* 下面两条钉住的是**实现过程中真实踩到的坑**，不是假想边界：
 * 最初形态是裸位置参数 `<命令>…`，于是
 *   `repl --session cc run X --timeout 0`  → `--timeout` 被 repl 自己的选项表拒掉；
 *   `repl --session cc screencap out.png`  → 位置参数被当成**两条命令**：
 *        `screencap` 用默认路径真截了一张（结果丢掉）+ `out.png` 报未知命令，
 *        也就是**静默执行了错误的动作**，还退 0。
 * 所以改成只认 `--cmd`，并把裸位置参数明确拒掉。 */

test('命名会话：裸位置参数被明确拒掉（不猜意图、不静默拆成多条命令）', async () => {
    const name = sessionName()
    const r = await runCli(['repl', '--session', name, 'screencap', 'out.png'], null)
    assert.notEqual(r.code, 0, '裸位置参数应失败（实际 ' + r.code + '）：' + r.out)
    assert.match(r.out, /要用 --cmd 传/, '要点名正确的用法：' + r.out)
    assert.match(r.out, /screencap/, '要把收到的位置参数原样报出，便于对照：' + r.out)
    assert.doesNotMatch(r.out, /\{"ok":true\}/, '**不许真的执行**任何一条（静默错动作比报错更贵）：' + r.out)
})

test('命名会话：--cmd 里的子命令选项原样交给会话（不被 repl 自己的选项表吃掉）', async (t) => {
    const name = sessionName()
    const logPath = stubLogFor(name).path
    t.after(() => cleanup(name))

    /* `run … --timeout 1200` 整条作为 --cmd 的值：repl 不该把 --timeout 当自己的选项。
     * 判据不能用 `{ok:true}` —— 会话内 `run` 还要求 --resource-dir（缺了会先拦），
     * 那条"缺资源"的提示**本身就是命令已完整送达**的证明（说明它解析到了 run 分支、
     * 且没在 repl 的选项层就被拒）。所以直接钉这两件事：不报选项错 + 走到 run 分支。 */
    const r = await runCli(
        ['repl', '--session', name, '--kind', 'adb', '--target', 'stub', '--cmd', 'run StartUp --timeout 1200'],
        logPath,
    )
    assert.equal(r.code, 0, '--cmd 应正常执行：' + r.out)
    assert.doesNotMatch(r.out, /Unknown option|\[BAD_ARGUMENTS\]/, '--timeout 不该被 repl 的选项表拒掉：' + r.out)
    assert.doesNotMatch(r.out, /未知命令：--timeout/, '--timeout 不该被切成独立命令：' + r.out)
    assert.match(r.out, /缺资源|已提交|"ok":true/, '命令要真的走到 run 分支：' + r.out)
})

test('命名会话：会话名白名单（要进管道名与文件路径，不能被穿越）', async () => {
    for (const bad of ['../evil', 'a/b', 'a\\b', 'a b', '', 'x'.repeat(49)]) {
        const r = await runCli(['repl', '--session', bad, '--cmd', 'probe'], null)
        assert.notEqual(r.code, 0, '非法会话名 ' + JSON.stringify(bad) + ' 应被拒：' + r.out)
        assert.match(r.out, /会话名只允许/, '要给出可读的拒绝理由：' + r.out)
    }
})

test('命名会话：meta 里记下连接参数（诊断"这条会话连的是哪个设备"）', async (t) => {
    const name = sessionName()
    const logPath = stubLogFor(name).path
    t.after(() => cleanup(name))

    await runCli(['repl', '--session', name, '--kind', 'adb', '--target', 'stub', '--cmd', 'probe'], logPath)
    const status = await runCli(['repl', '--session', name, '--session-status'], logPath)
    assert.match(status.out, /连接参数/, '状态里要能看出连接参数：' + status.out)
    assert.match(status.out, /stub/, '连接参数要包含实际给的目标：' + status.out)
})
