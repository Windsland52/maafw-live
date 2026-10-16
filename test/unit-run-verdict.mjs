/**
 * `run` 的三态结论词（回归）：`status:0 + stopped:true` 不是"完成"。
 *
 * 本仓 G21 实测：`{"status":0,"stopped":true,"durationMs":120376}` 被中途误读成"成功完成"——
 * 单看 `status` 分不清「跑满窗口被截断」与「任务自己结束但没成功」，而两者处置完全不同。
 * 判据必须是 **record 自带的 timeoutMs**，不能靠调用方回忆当初给了什么：
 *
 *   durationMs >= timeoutMs 且 stopped → 超时截断（非成功，也非失败）
 *   stopped 但没跑满                    → 被停止（任务自己结束，只是没成功）
 *   没 stopped                          → 失败
 *
 * 退出码仍按任务级 `record.ok`：截断不给开绿灯（这是"没跑完"，不是"跑完了没成功"）。
 *
 * 怎么测才不碰设备：桩 daemon 记账 + `MAAFW_STUB_REPLIES` 叠 run 回执字段。
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

/** 跑一次 REPL 会话（桩 daemon + 管道 stdin），返回 stdout 与退出码 */
async function runRepl(commands, replies) {
    const dir = mkdtempSync(join(tmpdir(), 'maafw-run3-'))
    const log = join(dir, 'requests.jsonl')
    const child = spawn(process.execPath, [CLI, 'repl', '--kind', 'adb', '--target', 'stub'], {
        env: {
            ...process.env,
            MAA_DAEMON: STUB,
            MAAFW_STUB_LOG: log,
            ...(replies ? { MAAFW_STUB_REPLIES: JSON.stringify(replies) } : {}),
        },
        stdio: ['pipe', 'pipe', 'ignore'],
    })
    let out = ''
    child.stdout.on('data', (d) => {
        out += String(d)
    })
    child.stdin.write(commands.join('\n') + '\n')
    child.stdin.end()

    const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            try {
                child.kill()
            } catch {
                /* ignore */
            }
            reject(new Error('15s 内 REPL 没退出（stdout 尾部：' + out.slice(-400) + '）'))
        }, 15000)
        child.on('exit', (c) => {
            clearTimeout(timer)
            resolve(c)
        })
    })

    let requests = []
    try {
        if (existsSync(log)) {
            requests = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        }
    } catch {
        /* ignore */
    }
    try {
        rmSync(dir, { recursive: true, force: true })
    } catch {
        /* ignore */
    }
    return { out, requests, code }
}

/** 跑一次性 CLI `run`（同样用桩），返回 stdout 与退出码 */
async function runCli(args, replies) {
    const dir = mkdtempSync(join(tmpdir(), 'maafw-run3c-'))
    const log = join(dir, 'requests.jsonl')
    const child = spawn(process.execPath, [CLI, ...args], {
        env: {
            ...process.env,
            MAA_DAEMON: STUB,
            MAAFW_STUB_LOG: log,
            ...(replies ? { MAAFW_STUB_REPLIES: JSON.stringify(replies) } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => {
        out += String(d)
    })
    child.stderr.on('data', (d) => {
        out += String(d)
    })
    const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            try {
                child.kill()
            } catch {
                /* ignore */
            }
            reject(new Error('15s 内没退出（输出尾部：' + out.slice(-400) + '）'))
        }, 15000)
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

const rec = (fields) => ({ run: { record: { entry: 'X', nodes: [], startSeq: 1, endSeq: 2, framesCaptured: 2, ...fields } } })

test('run 三态：跑满窗口被截断 → 「超时截断」，且不是「完成」', async () => {
    // timeout=2000，durationMs=2000 → 跑满窗口
    const { out } = await runRepl(['run X --resource-dir C:/x --timeout 2000', 'quit'], rec({ ok: false, status: 0, stopped: true, timeoutMs: 2000, durationMs: 2000 }))
    assert.match(out, /超时截断/, '要给出「超时截断」结论词：' + out)
    assert.doesNotMatch(out, /任务级 ok/, '截断不许说成 ok：' + out)
})

test('run 三态：stopped 但没跑满 → 「被停止」，与截断区分开', async () => {
    // timeout=60000，durationMs=5000 → 任务自己结束了
    const { out } = await runRepl(['run X --resource-dir C:/x --timeout 60000', 'quit'], rec({ ok: false, status: 0, stopped: true, timeoutMs: 60000, durationMs: 5000 }))
    assert.match(out, /被停止/, '要给出「被停止」结论词：' + out)
    assert.doesNotMatch(out, /超时截断/, '没跑满就不该说成超时截断：' + out)
})

test('run 三态：未 stopped 的失败 → FAIL', async () => {
    const { out } = await runRepl(['run X --resource-dir C:/x --timeout 60000', 'quit'], rec({ ok: false, status: 4000, stopped: false, timeoutMs: 60000, durationMs: 300 }))
    assert.match(out, /FAIL/, '未 stopped 的失败仍是 FAIL：' + out)
    assert.doesNotMatch(out, /超时截断|被停止/, '别把普通失败说成截断/停止：' + out)
})

test('run 三态：成功仍是 ok', async () => {
    const { out } = await runRepl(['run X --resource-dir C:/x --timeout 60000', 'quit'], rec({ ok: true, status: 3000, stopped: false, timeoutMs: 60000, durationMs: 8000 }))
    assert.match(out, /任务级 ok/, '成功照旧：' + out)
})

test('run 三态：缺 timeoutMs 时不臆断为截断（旧 daemon 回执兼容）', async () => {
    // 没有 timeoutMs 字段：无法证明"跑满窗口"，就不许说超时截断
    const { out } = await runRepl(['run X --resource-dir C:/x --timeout 2000', 'quit'], rec({ ok: false, status: 0, stopped: true, durationMs: 2000 }))
    assert.match(out, /被停止/, '缺 timeoutMs 时退到「被停止」而不是臆断截断：' + out)
    assert.doesNotMatch(out, /超时截断/, '没有预算证据就不许说截断：' + out)
})

test('一次性 CLI run：同一份三态判据，且截断不给开绿灯（退出码非 0）', async () => {
    const { out, code } = await runCli(
        ['run', '--entry', 'X', '--resource-dir', 'C:/x', '--timeout', '2000', '--kind', 'adb', '--target', 'stub'],
        rec({ ok: false, status: 0, stopped: true, timeoutMs: 2000, durationMs: 2000 }),
    )
    assert.match(out, /超时截断/, 'CLI 也要给出结论词：' + out)
    assert.notEqual(code, 0, '截断是任务级失败，退出码不得为 0（实际 ' + code + '）')
})

test('daemon 回执自带 timeoutMs（结论词的证据来源）', async () => {
    // 桩把请求记账；这里只确认 run 请求里 timeoutMs 原样送达，
    // 回执字段由 daemon 侧填充（真机验证在提交信息里）
    const { requests } = await runRepl(['run X --resource-dir C:/x --timeout 1234', 'quit'], rec({ ok: true, status: 3000, stopped: false, timeoutMs: 1234, durationMs: 10 }))
    const runReq = requests.find((r) => r.cmd === 'run')
    assert.equal(runReq.timeoutMs, 1234, 'timeoutMs 要原样送达 daemon：' + JSON.stringify(runReq))
})
