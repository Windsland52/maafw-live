/**
 * 预留旗标闸门：--dry-run / --verbose / 全局 --limit 传了就退 2，
 * 信封带 FLAG_NOT_IMPLEMENTED——"接受但不生效"会让 agent 以为在试跑、
 * 其实已经落盘。events 自己声明并消费 limit，是唯一的放行例外。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = join(HERE, '..', 'lib', 'index.js')

function runCli(args) {
    const r = spawnSync(process.execPath, [INDEX, ...args], { encoding: 'utf8', timeout: 15000 })
    return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') }
}

test('--dry-run 退 2 且信封带 FLAG_NOT_IMPLEMENTED', () => {
    const r = runCli(['env', '--dry-run', '--json'])
    assert.equal(r.code, 2, r.out)
    const env = JSON.parse(r.out)
    assert.equal(env.error.code, 'FLAG_NOT_IMPLEMENTED')
    assert.match(env.error.message, /--dry-run/)
})

test('--verbose 退 2', () => {
    const r = runCli(['env', '--verbose', '--json'])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /FLAG_NOT_IMPLEMENTED/)
})

test('全局 --limit 退 2（命令没有自己消费时）', () => {
    const r = runCli(['env', '--limit', '5', '--json'])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /FLAG_NOT_IMPLEMENTED/)
})

test('events 自己的 --limit 是命令私有消费，放行', () => {
    /* 一次性 events 无会话 → 空环，但旗标闸门不该拦它 */
    const r = runCli(['events', '--limit', '3', '--json'])
    assert.notEqual(r.code, 2, r.out)
    assert.doesNotMatch(r.out, /FLAG_NOT_IMPLEMENTED/)
})
