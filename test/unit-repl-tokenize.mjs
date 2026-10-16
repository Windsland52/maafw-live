/**
 * REPL 分词器的引号语义（回归）：**引号内的空格不是分隔符**。
 *
 * 旧实现是 `line.split(/\s+/)` 再逐 token 剥**首尾成对**的引号。带空格的引号参数被切成
 * 多个 token，残片各自不成对 → 引号原样留着，而 `readFlag` 只取下一个 token：
 *
 *   kf promote latest --note "活动大厅 主界面"   → --note = '"活动大厅'
 *   reco OCR expected="选择 领队"                → expected = '"选择'
 *
 * 这不是显示层截断，是**数据侧污染**：`kf promote` 照收，manifest 里就留下"截断 + 残留引号"
 * 的 note，`kf list` 看起来像渲染截断（本仓 G15 就是这么被记的）。
 *
 * 怎么测才不碰设备：桩 daemon 记账（`MAAFW_STUB_LOG`），断言"REPL 究竟把什么发给了 daemon"。
 * 用 `reco` 的字符串参数当观察面——分词错会**原样出现在请求里**，不经过任何解析。
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

/** 跑一次 REPL 会话（桩 daemon + 管道 stdin），返回 stdout 与桩收到的请求 */
async function runRepl(commands) {
    const dir = mkdtempSync(join(tmpdir(), 'maafw-tok-'))
    const log = join(dir, 'requests.jsonl')
    const child = spawn(process.execPath, [CLI, 'repl', '--kind', 'adb', '--target', 'stub'], {
        env: { ...process.env, MAA_DAEMON: STUB, MAAFW_STUB_LOG: log },
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

/** 取第 i 条 reco_test 请求的 param */
function paramOf(requests, i) {
    const recos = requests.filter((r) => r.cmd === 'reco_test')
    return recos[i] ? recos[i].param : undefined
}

test('REPL 分词：引号内的空格不是分隔符（字符串参数不被切碎）', async () => {
    const { requests, code } = await runRepl([
        'reco OCR --resource-dir C:/x expected="选择 领队"', // 带空格：旧实现给出 '"选择'
        "reco OCR --resource-dir C:/x expected='探索 模式'", // 单引号同义
        'reco OCR --resource-dir C:/x expected=出航日', // 无引号：不受影响
        'quit',
    ])
    assert.equal(code, 0, '会话正常结束')

    assert.equal(paramOf(requests, 0).expected, '选择 领队', '带空格的引号参数要整段保留且剥掉引号')
    assert.equal(paramOf(requests, 1).expected, '探索 模式', '单引号同义')
    assert.equal(paramOf(requests, 2).expected, '出航日', '无引号不受影响')
})

test('REPL 分词：引号内带空格的 ROI 仍落成数组', async () => {
    const { requests } = await runRepl([
        'reco TemplateMatch --resource-dir C:/x roi="1000, 15, 240, 58"', // 逗号后带空格
        'quit',
    ])
    assert.deepEqual(paramOf(requests, 0).roi, [1000, 15, 240, 58], '引号内空格不切分，roi 仍是 4 个数')
})

test('REPL 分词：转义引号还原为字面引号', async () => {
    const { requests } = await runRepl(['reco OCR --resource-dir C:/x expected="含\\"引号\\"的串"', 'quit'])
    assert.equal(paramOf(requests, 0).expected, '含"引号"的串', '转义引号还原为字面引号')
})

test('REPL 分词：未闭合引号按行尾收，内容原样给出（不静默吞掉）', async () => {
    const { requests } = await runRepl(['reco OCR --resource-dir C:/x expected="未闭合', 'quit'])
    assert.equal(paramOf(requests, 0).expected, '未闭合', '未闭合引号按行尾收')
})

test('REPL 分词：Windows 路径的反斜杠不被当转义吃掉', async () => {
    const { requests } = await runRepl(['reco TemplateMatch --resource-dir C:/x image="C:\\github\\M9A\\shot.png"', 'quit'])
    assert.equal(paramOf(requests, 0).image, 'C:\\github\\M9A\\shot.png', '路径反斜杠原样保留')
})

test('REPL 分词：空引号产出空串（显式给空值与没给不同）', async () => {
    const { requests } = await runRepl(['reco OCR --resource-dir C:/x expected=""', 'quit'])
    assert.equal(paramOf(requests, 0).expected, '', '空引号是"显式给了空值"')
})
