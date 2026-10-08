/**
 * 真值判定（IoU / recall / precision）单测。
 *
 * 钉的是四件在别处出错会很难查的事：
 *  - **IoU 的退化情形**：零面积、贴边不相交、包含关系——分母写错会静默给出 >1 或 NaN；
 *  - **两侧口径刻意不同**：recall 用 IoU 门槛、precision 用"沾边即算"，以及两者各自的另一种口径；
 *  - **多对多**：一个真值被多个最终框命中时 recall 只记一次，而 precision 的分母是**最终框数**；
 *  - **没有标注的帧不判分**：最终框记 unscored，绝不冒充误报（没标注 ≠ 那里没有元素）。
 * 另钉真值文件的校验口径：id 必须是库内序号后四位、空间不符要**拒绝打分**而不是照算。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { iou, matchFrame, aggregate, parseTruth, padspecsToRois, overlaps } from '../scripts/survey-truth.mjs'

test('IoU：恒等为 1，零面积/贴边/不相交为 0，半覆盖为 1/3', () => {
  assert.equal(iou([0, 0, 10, 10], [0, 0, 10, 10]), 1)
  assert.equal(iou([0, 0, 10, 10], [20, 20, 10, 10]), 0, '不相交 → 0')
  assert.equal(iou([0, 0, 10, 10], [10, 0, 10, 10]), 0, '贴边（交集面积为 0）→ 0，不是"重叠"')
  assert.equal(iou([0, 0, 0, 10], [0, 0, 10, 10]), 0, '零面积框参与比较 → 0，不产生 NaN/Infinity')
  assert.equal(iou([0, 0, 10, 10], [5, 0, 10, 10]), 1 / 3, '交 50 / 并 150')
  assert.equal(iou([0, 0, 10, 10], [2, 2, 4, 4]), 16 / 100, '小框完全被包含时分母是并集，不是大框面积')
  assert.ok(Number.isFinite(iou([0, 0, 10, 10], [1, 1, 1, 1])))
})

test('matchFrame：recall 严（IoU 门槛）、precision 松（沾边即算），两侧各留另一口径', () => {
  const truth = [{ id: '0001', label: '甲', box: [100, 100, 50, 50] }]
  /* 最终框把真值整个包住、但面积是它的 4 倍：沾边（松口径算命中）却远不到 IoU 0.5 */
  const loose = matchFrame([{ label: '大框', box: [75, 75, 100, 100] }], truth, 0.5)
  assert.equal(loose.counts.truthMatched, 0, 'recall：IoU=0.25 未过门槛 → 漏报')
  assert.equal(loose.counts.finalOverlapped, 1, 'precision：沾边即算 → 不是误报')
  assert.equal(loose.finals[0].areaRatio, 4, '贴合度 4 倍——"压住了但框太松"要能看出来')
  /* 框裁得比真值还小一半、但落在真值中心：同样过不了 IoU 门槛 */
  const tight = matchFrame([{ label: '小框', box: [112, 112, 25, 25] }], truth, 0.5)
  assert.equal(tight.counts.truthMatched, 0)
  assert.equal(tight.counts.finalOverlapped, 1)
  assert.equal(tight.finals[0].areaRatio, 0.25)
  /* 完全重合：两个口径同时命中 */
  const exact = matchFrame([{ label: '正好', box: [100, 100, 50, 50] }], truth, 0.5)
  assert.deepEqual([exact.counts.truthMatched, exact.counts.finalMatched], [1, 1])
  assert.equal(exact.finals[0].truth, '甲', '记的是命中的真值标签，不是自己的标签')
})

test('matchFrame：完全落空的框是误报；没有标注的帧只记 unscored', () => {
  const m = matchFrame([{ label: '空处', box: [600, 400, 80, 80] }], [{ id: '0001', label: '甲', box: [0, 0, 20, 20] }], 0.5)
  assert.deepEqual([m.counts.finalMatched, m.counts.finalOverlapped], [0, 0])
  assert.equal(m.finals[0].truth, null)
  const none = matchFrame([{ label: 'x', box: [1, 2, 3, 4] }], [], 0.5)
  assert.equal(none.finals[0].scored, false)
  assert.equal(none.counts.unscored, 1)
  assert.equal(none.counts.finalMatched, 0, '没有标注 ≠ 误报')
})

test('matchFrame：一个真值被多个框命中时，recall 记一次、precision 记每个框', () => {
  const truth = [{ id: '0001', label: '甲', box: [0, 0, 40, 40] }]
  const m = matchFrame(
    [{ label: 'a', box: [0, 0, 40, 40] }, { label: 'b', box: [0, 0, 42, 42] }, { label: 'c', box: [300, 300, 10, 10] }],
    truth, 0.5,
  )
  assert.equal(m.counts.truthMatched, 1, 'recall 分母是真值数：命中一次就够')
  assert.equal(m.counts.finalMatched, 2, 'precision 分母是最终框数：三个框里两个压住了真值')
  assert.equal(m.truths[0].bestIou, 1, '真值取"最像它的那个框"的 IoU')
})

test('aggregate：百分比按各自分母、漏报/误报/松框三份明细分开列', () => {
  const truthA = [{ id: '0001', label: '甲', box: [100, 100, 50, 50] }, { id: '0002', label: '乙', box: [300, 300, 40, 40] }]
  /* 帧 1：甲的框正好；乙的框把乙整个包住但面积是它的 4 倍（IoU 0.25）——严口径漏报、松口径命中 */
  const frames = [
    { id: '0001', match: matchFrame([{ label: '甲@+6px', box: [100, 100, 50, 50] }, { label: '乙@+6px', box: [280, 280, 80, 80] }], truthA, 0.5) },
    { id: '0002', match: matchFrame([{ label: '空处', box: [800, 500, 60, 60] }], truthA, 0.5) },
  ]
  const s = aggregate(frames, 0.5)
  assert.equal(s.truths, 4, '同一份真值参与两帧判定（每帧各自比）')
  assert.equal(s.recall, 25, '4 个真值里只有 1 个过了 IoU 门槛（第 2 帧一个都没命中）')
  assert.equal(s.recallLoose, 50, '宽松口径多认出"被大框压住"的那个')
  assert.equal(s.scoredFinals, 3)
  assert.equal(s.precision, 66.7, '3 个框里 2 个沾到真值')
  assert.equal(s.precisionStrict, 33.3)
  assert.deepEqual(s.missed.map((m) => `${m.frame}:${m.label}`), ['0001:乙', '0002:甲', '0002:乙'], '每帧各判一次，漏报按帧列')
  assert.deepEqual(s.missedLoose.map((m) => `${m.frame}:${m.label}`), ['0002:甲', '0002:乙'], '松口径漏报只收"连沾边都没有"的')
  assert.deepEqual(s.falsePositives.map((m) => m.label), ['乙@+6px', '空处'], '严口径误报按最终框列')
  assert.deepEqual(s.falsePositivesLoose.map((m) => m.label), ['空处'], '两个口径的误报名单必须各归各的——百分比与名单同口径才读得通')
  assert.deepEqual(s.looseHits.map((m) => m.label), ['乙@+6px'], '严口径误报里"沾了边"的那部分单独列出')
  assert.equal(s.areaRatio.median, 1, '只有命中例参与贴合度统计')
})

test('aggregate：没有真值时所有比率是 null（不是 0——0 会被读成"全错"）', () => {
  const s = aggregate([{ id: '0001', match: matchFrame([{ label: 'x', box: [1, 1, 5, 5] }], [], 0.5) }], 0.5)
  assert.deepEqual([s.recall, s.precision, s.recallLoose, s.precisionStrict], [null, null, null, null])
  assert.equal(s.unscoredFinals, 1)
})

test('matchFrame：没有被任何输入框问到的真值不进 recall 分母（"没问"不是"没找到"）', () => {
  const truth = [{ id: '0001', label: '问了', box: [0, 0, 40, 40] }, { id: '0002', label: '没问', box: [300, 300, 40, 40], asked: false }]
  const m = matchFrame([{ label: 'a', box: [0, 0, 40, 40] }], truth, 0.5)
  assert.equal(m.counts.truths, 2)
  assert.equal(m.counts.truthsAsked, 1, 'recall 分母只数被问到的')
  assert.equal(m.counts.truthMatched, 1)
  assert.deepEqual(m.truths.map((x) => x.asked), [true, false])
  /* 精度侧它照常参与：框压在"没问"的那个真值上，仍然算找对了地方（不因为没人问就被当成误报） */
  const onUnasked = matchFrame([{ label: 'b', box: [300, 300, 40, 40] }], truth, 0.5)
  assert.equal(onUnasked.counts.finalMatched, 1)
  assert.equal(onUnasked.finals[0].truth, '没问')
  const s = aggregate([{ id: '0002', match: onUnasked }], 0.5)
  assert.equal(s.truths, 2)
  assert.equal(s.truthsAsked, 1)
  assert.deepEqual(s.uncovered.map((x) => x.label), ['没问'], '单列 uncovered，不混进漏报')
  assert.deepEqual(s.missed.map((x) => x.label), ['问了'], '只有被问到又没命中的才是漏报')
  assert.equal(s.recall, 0, '分母是 1（问到的那个没命中），不是 2')
})

test('overlaps：正面积相交才算"问到"（贴边不算）', () => {
  assert.equal(overlaps([0, 0, 10, 10], [5, 5, 10, 10]), true)
  assert.equal(overlaps([0, 0, 10, 10], [10, 0, 10, 10]), false, '贴边不算问到')
  assert.equal(overlaps([0, 0, 10, 10], [20, 20, 5, 5]), false)
  assert.equal(overlaps([0, 0, 0, 10], [0, 0, 10, 10]), false, '零面积不算')
})

test('parseTruth：格式校验 + 空间不符拒绝打分', () => {
  const frames = { '0004': { ctrlW: 1280, ctrlH: 720 } }
  const good = parseTruth([{ id: '0004', label: '图鉴图标', box: [71, 463, 57, 66], frame: [1280, 720], why: 'x' }], frames)
  assert.deepEqual(good.errors, [])
  assert.equal(good.entries.length, 1)
  assert.equal(good.entries[0].why, 'x')
  /* 尺寸不符：标注与本帧不是同一空间，比出来的误报全是假的 → 报错（调用方据此中止） */
  const wrongSpace = parseTruth([{ id: '0004', label: 'x', box: [1, 1, 2, 2], frame: [1920, 1080] }], frames)
  assert.equal(wrongSpace.entries.length, 0)
  assert.match(wrongSpace.errors[0], /不一致/)
  /* 格式族：id 不是四位、缺 label、box 不是四个数、box 宽高非正、frame 不是 [w,h] */
  assert.equal(parseTruth([{ id: 'kf:xxx:0004', label: 'x', box: [1, 1, 2, 2] }], frames).errors.length, 1)
  assert.equal(parseTruth([{ id: '0004', box: [1, 1, 2, 2] }], frames).errors.length, 1)
  assert.equal(parseTruth([{ id: '0004', label: 'x', box: [1, 1, 2] }], frames).errors.length, 1)
  assert.equal(parseTruth([{ id: '0004', label: 'x', box: [1, 1, 0, 2] }], frames).errors.length, 1)
  assert.equal(parseTruth([{ id: '0004', label: 'x', box: [1, 1, 2, 2], frame: [1280] }], frames).errors.length, 1)
  assert.equal(parseTruth({ nope: 1 }, frames).errors.length, 1, '顶层不是数组')
  /* 一条坏的不该把后面的好条目一起丢掉 */
  const mixed = parseTruth([{ id: 'bad', label: 'x', box: [1, 1, 2, 2] }, { id: '0004', label: '好', box: [1, 1, 2, 2] }], frames)
  assert.equal(mixed.errors.length, 1)
  assert.deepEqual(mixed.entries.map((e) => e.label), ['好'])
})

test('padspecsToRois：绝对值与百分比两档，且夹在帧内', () => {
  const entries = [{ id: '0004', label: '图鉴图标', box: [71, 463, 57, 66] }]
  const rois = padspecsToRois(entries, ['6', '25%'], { w: 1280, h: 720 })
  assert.equal(rois.length, 2)
  assert.deepEqual(rois[0].roi, [65, 457, 69, 78], '+6px 每边')
  assert.deepEqual(rois[1].roi, [54, 446, 91, 100], '25% 取长边（66×0.25=16.5→17px）')
  assert.deepEqual(rois.map((r) => r.label), ['图鉴图标@+6px', '图鉴图标@+17px(25%)'], '标签带实际像素余量，便于直接读表')
  /* 贴边的元素不能外扩出帧外——出帧的 roi 会让裁剪在帧边界上取到错的内容 */
  const edge = padspecsToRois([{ id: '0001', label: '贴边', box: [2, 1, 20, 20] }], ['6'], { w: 100, h: 100 })[0]
  assert.deepEqual(edge.roi, [0, 0, 28, 27])
})
