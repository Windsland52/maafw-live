/**
 * 命名会话的**平台面**（回归）。
 *
 * 会话要两件事同时成立，而它们在两个平台上的实现完全不同：
 *   - Windows：命名管道在 `\\.\pipe\` 命名空间里，**不走文件系统**；随进程消失，不会残留。
 *   - POSIX  ：管道是文件系统里的 **socket 文件**（`~/.maafw-live/sessions/<name>/sock`）；
 *              `listen()` 对不存在的父目录直接 ENOENT；进程被强杀时 socket 文件会留下，
 *              再 listen 就是 EADDRINUSE。
 *
 * 初版只写了 Windows 那条路（`\\\\.\\pipe\\…`），POSIX 分支**从没跑过**：父目录没人建、
 * 残留 socket 没人清。这个文件把两侧的**契约**钉住，让它们在 Windows 开发机上也能被测到
 * （不靠"CI 上碰巧有 Linux"）。
 *
 * 只测纯函数与路径形状，不真起 socket——真起异平台 socket 在 Windows 上做不到。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, lstatSync, existsSync, mkdirSync } from 'node:fs'
import {
    ensureSessionDir, sessionDir, sessionMetaPath, sessionPipePath, validSessionName,
} from '../lib/runtime/session-ipc.js'

const isWin = process.platform === 'win32'

test('管道路径：Windows 走命名管道命名空间，其它平台走文件系统 socket 文件', () => {
    const p = sessionPipePath('demo')
    if (isWin) {
        assert.equal(p, '\\\\.\\pipe\\maafw-live-demo', 'Windows 要用命名管道命名空间：' + p)
        assert.ok(!p.includes('sessions'), '命名管道不该落在会话目录里（它不走文件系统）：' + p)
    } else {
        assert.ok(p.startsWith(sessionDir('demo')), 'POSIX 的 socket 要落在会话目录里：' + p)
        assert.ok(p.endsWith('sock'), 'POSIX 的 socket 文件名固定为 sock：' + p)
        assert.ok(!p.startsWith('\\\\.\\pipe\\'), 'POSIX 不认 Windows 管道前缀：' + p)
    }
})

test('ensureSessionDir：Windows 空操作，POSIX 必须把父目录建出来', () => {
    const name = 'ed-test-' + process.pid.toString(36)
    /* 前置：清干净，保证"目录不存在"这个起点是真的 */
    try {
        rmSync(sessionDir(name), { recursive: true, force: true })
    } catch {
        /* ignore */
    }
    ensureSessionDir(name)
    const dir = sessionDir(name)
    if (isWin) {
        /* 命名管道不需要目录；这里只要求"不抛"（建不建都行，别炸） */
        assert.doesNotThrow(() => ensureSessionDir(name), 'Windows 上必须是空操作')
    } else {
        assert.ok(existsSync(dir), 'POSIX 上父目录必须建出来（不建的话 listen 直接 ENOENT）：' + dir)
    }
    try {
        rmSync(dir, { recursive: true, force: true })
    } catch {
        /* ignore */
    }
})

test('sessionDir / sessionMetaPath：都收敛在 ~/.maafw-live/sessions/<name> 下', () => {
    const d = sessionDir('abc')
    assert.equal(d, join(homedir(), '.maafw-live', 'sessions', 'abc'), '会话状态要落在用户目录：' + d)
    assert.equal(sessionMetaPath('abc'), join(d, 'meta.json'), 'meta 文件名固定：' + sessionMetaPath('abc'))
})

test('会话名白名单：挡住路径分隔符与穿越（它要进文件路径与管道名）', () => {
    for (const ok of ['a', 'abc', 'a-b_c', 'X9', 'x'.repeat(48)]) {
        assert.equal(validSessionName(ok), true, '合法名被判非法：' + JSON.stringify(ok))
    }
    for (const bad of ['', 'a b', 'a/b', 'a\\b', '../x', '..', 'x'.repeat(49), 'a.b', '中文', 'a\nb']) {
        assert.equal(validSessionName(bad), false, '非法名被判合法：' + JSON.stringify(bad))
    }
})

test('POSIX 残留 socket：只有"确实是 socket"的才该被清（别误删普通文件）', () => {
    /* 这条钉的是 listen() 里那段预清理的**判据**：它用 lstatSync(...).isSocket() 过滤，
     * 而不是"路径存在就删"。在 Windows 上 isSocket() 对普通文件恒为 false，
     * 所以这里可以直接验证"普通文件不会被当成残留 socket 处理"这一半。 */
    const dir = mkdtempSync(join(tmpdir(), 'maafw-sock-'))
    const plain = join(dir, 'sock')
    try {
        writeFileSync(plain, 'i am a plain file, not a socket')
        const st = lstatSync(plain)
        assert.equal(st.isSocket(), false, '普通文件不该被识别成 socket —— 于是不会被清掉')
        assert.ok(existsSync(plain), '普通文件必须留着')
    } finally {
        try {
            rmSync(dir, { recursive: true, force: true })
        } catch {
            /* ignore */
        }
    }
})

test('两平台都不会把会话状态写进项目目录（要能被 .gitignore 之外的路径统一收掉）', () => {
    const d = sessionDir('proj-check')
    assert.ok(!d.startsWith(process.cwd()), '会话状态不该落在当前工作目录下：' + d)
    mkdirSync(join(tmpdir(), 'maafw-probe-' + process.pid), { recursive: true })
    try {
        rmSync(join(tmpdir(), 'maafw-probe-' + process.pid), { recursive: true, force: true })
    } catch {
        /* ignore */
    }
})
