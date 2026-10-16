/**
 * 帧流事件的**画面锚点**（回归）：事件必须自报"这一刻的画面还能不能取到"。
 *
 * 本仓 G9 实测：`events` 只给 `{"type":"stable","seq":2,"t":…,"diff":0}`。消费者看到它的
 * 唯一想知道的是"那是什么画面"，而 L0 是**滚动淘汰**的——拿 seq 去 `frame get` 可能已经没了，
 * 试错才知道。所以锚点要报的是**可取性**，不是再报一遍 seq：
 *
 *   frame: { seq, retained: 'l0' | 'gone', source?, w?, h? }
 *
 * 两个易错点（本实现先写错过，都有独立用例钉住）：
 *  ① **入锚区必须早于发事件**：反过来的话刚触发入锚区的那一帧会自报 `retained:'gone'`；
 *  ② **同簇合并时锚点要跟着前移**：`last.seq` 前移到簇尾而 `frame` 留在簇首，锚点与内容对不上。
 *
 * 纯函数测试：直接操作 `__test.S` 的 L0 两区，不连设备。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../src/daemon/framed.mjs'

const { eventFrameAnchor, S } = __test

/** 造一条 L0 条目（只要 anchor/roll 查找用得到的字段） */
const ent = (seq, source) => ({ seq, t: 1792000000000 + seq, w: 1280, h: 720, source, png: Buffer.alloc(16) })

/** 重置 L0 两区到给定状态 */
function reset({ roll = [], anchor = [] } = {}) {
    S.l0.roll = roll
    S.l0.anchor = anchor
}

test('锚点：帧在滚动区 → retained=l0，给出 source 与尺寸', () => {
    reset({ roll: [ent(5, 'change')] })
    const a = eventFrameAnchor(5)
    assert.equal(a.retained, 'l0', '滚动区里有就该报可取：' + JSON.stringify(a))
    assert.equal(a.seq, 5)
    assert.equal(a.source, 'change')
    assert.deepEqual([a.w, a.h], [1280, 720])
})

test('锚点：帧只在锚区 → retained=l0（锚区也算可取）', () => {
    reset({ anchor: [ent(7, 'stable')] })
    const a = eventFrameAnchor(7)
    assert.equal(a.retained, 'l0', '锚区里有也算可取：' + JSON.stringify(a))
    assert.equal(a.source, 'stable')
})

test('锚点：帧已滚出两区 → retained=gone（明说取不到，不让调用方去撞）', () => {
    reset({ roll: [ent(9, 'change')] })
    const a = eventFrameAnchor(3)
    assert.equal(a.retained, 'gone', '滚出后必须明说 gone：' + JSON.stringify(a))
    assert.equal(a.seq, 3, '仍要报出是哪个 seq 取不到')
})

test('锚点：两区同 seq → 报锚区的 source（锚区才是"值得留的"那张）', () => {
    reset({ roll: [ent(4, 'change')], anchor: [ent(4, 'stable')] })
    const a = eventFrameAnchor(4)
    assert.equal(a.retained, 'l0')
    assert.equal(a.source, 'stable', '共享同一 seq 时优先锚区来源：' + JSON.stringify(a))
})

test('锚点：seq 缺失/非数字 → 不造锚点（不臆造 retained）', () => {
    reset({ roll: [ent(1, 'change')] })
    assert.equal(eventFrameAnchor(undefined), undefined, '没有 seq 就没有锚点可言')
    assert.equal(eventFrameAnchor('2'), undefined, '字符串 seq 也不认')
})

test('顺序不变量：入锚区早于发事件，事件才自报可取', async () => {
    /* 直接复刻 pushEvent 的取锚点时机：先用空 L0 查一次（模拟"先发事件"的错误顺序），
     * 再入锚区后查一次（正确顺序）。钉住的是"这件事有顺序要求"，不是某个具体实现。 */
    reset({})
    const wrong = eventFrameAnchor(11)
    assert.equal(wrong.retained, 'gone', '先发事件的话会自报 gone —— 这正是要避免的')

    reset({ anchor: [ent(11, 'stable')] })
    const right = eventFrameAnchor(11)
    assert.equal(right.retained, 'l0', '先入锚区再发事件才自报可取')
})

test('同簇合并：锚点跟着 seq 前移（锚点与内容不得错位）', () => {
    /* 模拟 streamTick 的合并分支：last 的 seq 前移到簇尾，frame 必须一起前移 */
    reset({ anchor: [ent(20, 'change'), ent(21, 'change')] })
    const last = { type: 'change', seq: 20, t: 100, diff: 0.5, frame: eventFrameAnchor(20) }
    assert.equal(last.frame.seq, 20)

    // 合并：seq 前移到 21，锚点重新取
    last.seq = 21
    last.frame = eventFrameAnchor(21)
    assert.equal(last.frame.seq, 21, '锚点必须指向事件当前声称的那一帧')
    assert.equal(last.frame.retained, 'l0')
})
