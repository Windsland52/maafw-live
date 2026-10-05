/**
 * timing 分布聚合单测（纯函数，无设备）：percentile 最近邻秩口径 +
 * aggregateTiming 的建议值公式（失败 run 排除、单样本退化与历史单次行为一致）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { percentile, aggregateTiming } from '../lib/commands/timing.js'

const node = (name, ms, settle = null, nextBeforeStable = false, status = 'Succeeded') =>
  ({ name, ms, status, settle, nextBeforeStable })
const run = (index, ok, durationMs, nodes) => ({ index, ok, durationMs, nodes, events: 0 })

test('percentile：最近邻秩——单值恒等、双样本 P95 取最大、顺序无关', () => {
  assert.equal(percentile([42], 50), 42)
  assert.equal(percentile([42], 95), 42)
  assert.equal(percentile([10, 90], 95), 90)
  assert.equal(percentile([90, 10], 95), 90)
  assert.equal(percentile([90, 10], 50), 10, 'n=2 的 P50 取下侧（偏保守口径已记录）')
  /* n=5 最近邻秩的逐档值：rank=ceil(p/100*5)，p10→1档 p20→1档 p30→2档 p40→2档 p50→3档 */
  assert.deepEqual([10, 20, 30, 40, 50].map((p) => percentile([10, 20, 30, 40, 50], p)), [10, 10, 20, 20, 30])
  assert.equal(percentile([5, 1, 4, 2, 3], 95), 5, '输入无需预排序')
  assert.equal(percentile([], 95), 0)
  /* 20 样本 P95 = 第 19 个（nearest-rank），不是插值 */
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1)
  assert.equal(percentile(twenty, 95), 19)
})

test('单成功样本：建议值与历史单次公式逐字段一致', () => {
  const agg = aggregateTiming([run(1, true, 45230, [node('启动', 1234, 456), node('登录', 900, null)])])
  assert.equal(agg.successful, 1)
  assert.equal(agg.failed, 0)
  assert.equal(agg.suggest.nodeTimeoutMs, Math.ceil((1234 * 1.5) / 100) * 100)   // 1900
  assert.equal(agg.suggest.taskTimeoutMs, Math.ceil((45230 * 2) / 1000) * 1000)  // 91000
  assert.equal(agg.suggest.postDelayMs, Math.ceil((456 * 1.2) / 50) * 50)        // 550
  assert.equal(agg.nodeStats[0].msP50, 1234)
  assert.equal(agg.nodeStats[0].msP95, 1234)
})

test('失败 run 不计入建议，但计数与保留在样本里', () => {
  const agg = aggregateTiming([
    run(1, true, 40000, [node('A', 1000, 400)]),
    run(2, false, 5000, [node('A', 200, 100)]), // 提前终止：全部排除
  ])
  assert.equal(agg.successful, 1)
  assert.equal(agg.failed, 1)
  assert.equal(agg.durationP95, 40000)
  assert.equal(agg.suggest.taskTimeoutMs, 80000)
  assert.equal(agg.nodeStats.length, 1)
  assert.equal(agg.nodeStats[0].msP95, 1000)
})

test('多 run 分布：P50 取中位、P95 取保守端；全失败样本给 null 建议', () => {
  const agg = aggregateTiming([
    run(1, true, 30000, [node('A', 1000), node('B', 2000, 300)]),
    run(2, true, 34000, [node('A', 1400), node('B', 2400, 500)]),
    run(3, true, 32000, [node('A', 1200), node('B', 2200, 400)]),
  ])
  assert.equal(agg.durationP50, 32000)
  assert.equal(agg.durationP95, 34000, 'n=3 的 P95 = 最大值（最近邻秩）')
  assert.equal(agg.maxNodeP95, 2400, '各 run 最长节点的 P95')
  assert.equal(agg.suggest.nodeTimeoutMs, Math.ceil((2400 * 1.5) / 100) * 100)
  assert.equal(agg.suggest.postDelayMs, Math.ceil((500 * 1.2) / 50) * 50)
  const a = agg.nodeStats.find((n) => n.name === 'A')
  assert.equal(a.msP50, 1200)
  assert.equal(a.msP95, 1400)

  const none = aggregateTiming([run(1, false, 1, [])])
  assert.equal(none.successful, 0)
})

test('节点覆盖：成功 run 缺席的节点标注 runs<successful', () => {
  const agg = aggregateTiming([
    run(1, true, 100, [node('A', 100), node('B', 50)]),
    run(2, true, 100, [node('A', 110)]), // B 分支未走
  ])
  const b = agg.nodeStats.find((n) => n.name === 'B')
  assert.equal(b.runs, 1)
  assert.equal(agg.successful, 2)
})

test('run 内重复执行（重试/Next 环）：全部出现进分布，慢样本不被丢弃', () => {
  /* 实测形态（M9A StartUp 真机）：StartUp 每 run 执行两次，第二次才是等动画的慢样本 */
  const agg = aggregateTiming([
    run(1, true, 8000, [node('StartUp', 700, 60), node('Home', 900, 100), node('StartUp', 4218, 200)]),
    run(2, true, 7900, [node('StartUp', 690, 55), node('Home', 910, 90), node('StartUp', 3921, 180)]),
  ])
  const su = agg.nodeStats.find((n) => n.name === 'StartUp')
  assert.equal(su.occurrences, 4, '两次执行 × 两个 run 全进样本')
  assert.equal(su.runs, 2, '覆盖计数仍是出现过的 run 数')
  assert.equal(su.msP95, 4218, '慢的第二次执行不被 find-first 丢弃')
  assert.equal(su.msP50, 700, 'P50 取 4 样本中位（最近邻秩下侧第 2）')
  assert.equal(su.settleSamples, 4)
  /* maxNodeP95 与节点表自此一致：都按全部出现算 */
  assert.equal(agg.maxNodeP95, 4218)
  assert.equal(Math.max(...agg.nodeStats.map((n) => n.msP95)), 4218)
})

test('稳定时间：无样本 → null 链路；nextBeforeStable 任一 run 出现即标', () => {
  const noSettle = aggregateTiming([run(1, true, 100, [node('A', 10, null)])])
  assert.equal(noSettle.suggest.postDelayMs, null)
  assert.equal(noSettle.maxSettleP95, null)

  const flagged = aggregateTiming([
    run(1, true, 100, [node('A', 10, 100, false)]),
    run(2, true, 100, [node('A', 10, 100, true)]),
  ])
  assert.equal(flagged.nodeStats[0].nextBeforeStable, true)
  assert.equal(flagged.nodeStats[0].settleSamples, 2)
})
