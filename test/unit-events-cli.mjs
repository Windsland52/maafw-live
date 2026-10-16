/**
 * 顶层 `events` 命令（回归）：一次性 CLI 也能查事件环，不必开 REPL。
 *
 * 本仓 G7：「stream/events/logs 仅 repl」。三条要分开判，不能一起提：
 *   - `events` **可以**提——它查的是 daemon 已有的 `S.events` 环（现查，不订阅）；
 *   - `stream start` 提上去**没有意义**——一次性 CLI 走 `withDaemon`，命令返回即 `client.close()`，
 *     帧流起来后没有任何消费者，事件也随进程消失；
 *   - `logs` 提不了——它是 daemon 的 **stderr 原生日志**，由客户端进程持有（`events.logs`），
 *     跨进程拿不到。
 *
 * 这里钉住的是"能提的那条真的能提，且形状对"：用桩 daemon 回一个造好的事件环。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'maafw-live.mjs')
const STUB = join(HERE, 'fixtures', 'stub-recording-daemon.mjs')

/** 跑一次性 CLI，返回 stdout/stderr 与退出码 */
async function runCli(args, replies) {
    const dir = mkdtempSync(join(tmpdir(), 'maafw-ev-'))
    const child = spawn(process.execPath, [CLI, ...args], {
        env: {
            ...process.env,
            MAA_DAEMON: STUB,
            MAAFW_STUB_LOG: join(dir, 'requests.jsonl'),
            ...(replies ? { MAAFW_STUB_REPLIES: JSON.stringify(replies) } : {}),
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

const CONNECT = ['--kind', 'adb', '--target', 'stub']

test('顶层 events：可查、带锚点、并给出可执行的 frame get', async () => {
    const { out, code } = await runCli(
        ['events', '--limit', '5', ...CONNECT],
        {
            events_list: {
                total: 3,
                matched: 3,
                cap: 1200,
                truncated: false,
                events: [
                    { type: 'stable', seq: 2, t: 1, diff: 0, frame: { seq: 2, retained: 'l0', source: 'stable', w: 1280, h: 720 } },
                    { type: 'change', seq: 7, t: 2, diff: 0.6, frame: { seq: 7, retained: 'l0', source: 'change' } },
                    { type: 'change', seq: 9, t: 3, diff: 0.5, frame: { seq: 9, retained: 'gone' } },
                ],
            },
        },
    )
    assert.equal(code, 0, '查询成功应退出 0：' + out)
    assert.match(out, /事件 3 条/, '要报条数：' + out)
    assert.match(out, /frame=l0:2（stable） → frame get 2/, '可取的要给出可执行下一步：' + out)
    assert.match(out, /frame=gone/, '已滚出的要明说取不到：' + out)
})

test('顶层 events：空环给出可行动的提示，而不是干巴巴的空', async () => {
    const { out, code } = await runCli(
        ['events', ...CONNECT],
        { events_list: { total: 0, matched: 0, cap: 1200, truncated: false, events: [] } },
    )
    assert.equal(code, 0, '空环不是错误：' + out)
    assert.match(out, /环内没有事件/, '要说清为什么空、怎么办：' + out)
    assert.match(out, /--watch/, '要指向真正可用的那条路（--watch）：' + out)
    assert.match(out, /不跨进程存活/, '要把架构约束说给调用方听：' + out)
})

test('顶层 events --watch：本次调用内起流采集，并如实说明采集窗口', async () => {
    const { out, code } = await runCli(
        ['events', '--watch', '1500', '--fps', '10', ...CONNECT],
        { events_list: { total: 1, matched: 1, cap: 1200, truncated: false, events: [{ type: 'stable', seq: 2, t: 1, diff: 0, frame: { seq: 2, retained: 'l0', source: 'stable' } }] } },
    )
    assert.equal(code, 0, '--watch 应正常返回：' + out)
    assert.match(out, /本次起流 1500ms @10fps 现场采集/, '要报出采集窗口，结果才可解释：' + out)
    assert.match(out, /frame=l0:2/, '采集到的事件仍要带锚点：' + out)
})

test('顶层 events --watch：窗口内没变化时，说清"静止不产生事件"而不是报空', async () => {
    const { out, code } = await runCli(
        ['events', '--watch', '1200', ...CONNECT],
        { events_list: { total: 0, matched: 0, cap: 1200, truncated: false, events: [] } },
    )
    assert.equal(code, 0, '没有变化不是错误：' + out)
    assert.match(out, /画面没有变化/, '要说清这是"静止"而非"工具坏了"：' + out)
    assert.match(out, /加长 --watch/, '要给出可行动的下一步：' + out)
})

test('顶层 events：--watch 非正数时只报用法', async () => {
    const bad = await runCli(['events', '--watch', 'abc', ...CONNECT])
    assert.notEqual(bad.code, 0, '--watch 非数字应失败：' + bad.out)
    assert.match(bad.out, /--watch 必须是正毫秒数/, bad.out)

    const zero = await runCli(['events', '--watch', '0', ...CONNECT])
    assert.notEqual(zero.code, 0, '--watch 0 应失败：' + zero.out)
})

test('顶层 events：--limit / --since 非法时只报用法（不静默当默认值）', async () => {
    const bad = await runCli(['events', '--limit', 'abc', ...CONNECT])
    assert.notEqual(bad.code, 0, '--limit 非数字应失败：' + bad.out)
    assert.match(bad.out, /--limit 必须是正整数/, bad.out)

    const bad2 = await runCli(['events', '--since', 'xyz', ...CONNECT])
    assert.notEqual(bad2.code, 0, '--since 非数字应失败：' + bad2.out)
    assert.match(bad2.out, /--since 必须是数字/, bad2.out)
})

test('顶层 events：旧 daemon 回执缺 frame 字段时不崩、明说无锚点', async () => {
    const { out, code } = await runCli(
        ['events', ...CONNECT],
        { events_list: { total: 1, matched: 1, cap: 1200, truncated: false, events: [{ type: 'stable', seq: 2, t: 1, diff: 0 }] } },
    )
    assert.equal(code, 0, '缺锚点不该崩：' + out)
    assert.match(out, /frame=\?（无锚点）/, '要明说没有锚点，不臆造：' + out)
})
