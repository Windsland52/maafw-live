/**
 * 真值（ground truth）判定：把「裁剪最终框」与「人工标注的元素框」按 IoU 对上，算出**漏报与误报**。
 *
 * 为什么单独一个模块：`survey:crop` 此前只能报「位置正确率」——那是**自洽**指标（模板在同帧上找得到
 * 自己），模板把整块背景连同元素一起裁进去也照样为真。要算漏报/误报就必须有**外部标注**，
 * 而标注一旦是人写的，判定口径就必须钉死在一个能被单测锁住的地方，不能散在脚本里。
 *
 * 口径（本模块是唯一出处，`test/unit-survey-truth.mjs` 钉住）：
 *  - **命中** = `iou(最终框, 真值框) >= thr`（默认 0.5）。IoU 取矩形交并比；任一边长为 0 视为不命中。
 *  - **recall**（以真值为中心，抓漏报）= 至少被一个最终框命中的真值数 / 真值总数。
 *    判定用严口径（IoU 门槛）：框偏得厉害也算没找到。
 *  - **precision**（以最终框为中心，抓误报）= 1 − 不与任何真值框**重叠**（IoU > 0）的最终框占比。
 *    判定用松口径（沾边即算找对了地方）——这是"有多少最终框落在画面里没人标注的空处"。
 *  - 两个方向都另出一份另一种口径的数字（`precisionStrict` / `recallLoose`），
 *    这样"框裁得太大"这类情形会在报告里显形（严口径丢分、松口径满分），而不是被口径本身吞掉。
 *  - 多对多：一个真值可被多个最终框命中（recall 只记一次），一个最终框只认 IoU 最大的那个真值。
 *  - **帧内没有真值的最终框不参与判定**（记 `unscored`），不冒充误报——没有标注不等于那里没有元素。
 */

/** 矩形 IoU。边长为 0 或负、或不相交 → 0。 */
export function iou(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 4 || b.length < 4) return 0
  const [ax, ay, aw, ah] = a
  const [bx, by, bw, bh] = b
  if (!(aw > 0) || !(ah > 0) || !(bw > 0) || !(bh > 0)) return 0
  const iw = Math.min(ax + aw, bx + bw) - Math.max(ax, bx)
  const ih = Math.min(ay + ah, by + bh) - Math.max(ay, by)
  if (iw <= 0 || ih <= 0) return 0
  const inter = iw * ih
  return inter / (aw * ah + bw * bh - inter)
}

const area = (b) => (Array.isArray(b) && b.length >= 4 ? Math.max(0, b[2]) * Math.max(0, b[3]) : 0)
const nameOf = (t) => (t.label != null ? String(t.label) : String(t.id))

/**
 * 单帧判定：`finals` / `truths` 都是 `[{label?, box:[x,y,w,h]}]`。
 * 返回逐框结论 + 计数。`truths` 为空时全部最终框记 `unscored`。
 */
export function matchFrame(finals, truths, thr = 0.5) {
  const fs = Array.isArray(finals) ? finals : []
  const ts = Array.isArray(truths) ? truths : []
  /* 帧内 IoU 矩阵算一次，两个方向共用——免得两个方向各算一遍还可能不一致 */
  const m = fs.map((f) => ts.map((t) => iou(f.box, t.box)))
  const bestOf = (row) => {
    let idx = -1
    let best = 0
    row.forEach((v, j) => { if (v > best) { best = v; idx = j } })
    return { idx, best }
  }
  const finalsOut = fs.map((f, i) => {
    const { idx, best } = bestOf(m[i])
    const t = idx >= 0 ? ts[idx] : null
    return {
      label: f.label ?? null,
      box: f.box,
      scored: ts.length > 0,
      bestIou: Math.round(best * 1000) / 1000,
      truth: t ? nameOf(t) : null,
      truthId: t ? t.id : null,
      matched: ts.length > 0 && best >= thr,
      overlapped: ts.length > 0 && best > 0,
      /* 框贴合度：最终框面积 / 最接近的真值框面积。>1 = 裁大了（把背景带进来了），<1 = 裁小了 */
      areaRatio: t && best > 0 ? Math.round((area(f.box) / Math.max(1, area(t.box))) * 100) / 100 : null,
    }
  })
  const truthsOut = ts.map((t, j) => {
    const { best } = bestOf(m.map((row) => row[j]))
    return {
      id: t.id,
      label: nameOf(t),
      box: t.box,
      bestIou: Math.round(best * 1000) / 1000,
      matched: best >= thr,
      overlapped: best > 0,
    }
  })
  return {
    finals: finalsOut,
    truths: truthsOut,
    counts: {
      finals: fs.length,
      truths: ts.length,
      finalMatched: finalsOut.filter((x) => x.matched).length,
      finalOverlapped: finalsOut.filter((x) => x.overlapped).length,
      truthMatched: truthsOut.filter((x) => x.matched).length,
      truthOverlapped: truthsOut.filter((x) => x.overlapped).length,
      unscored: finalsOut.filter((x) => !x.scored).length,
    },
  }
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null)
const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 100) / 100
}

/**
 * 跨帧汇总。`frames` = `[{id, match}]`（每项是 matchFrame 的结果，已按帧分层）。
 * 分母口径：recall 用真值总数（含所有帧），precision 用**参与判定的**最终框数（无标注帧的框不算）。
 */
export function aggregate(frames, thr = 0.5) {
  const list = (Array.isArray(frames) ? frames : []).map((f) => ({ id: f.id, match: f.match, ...f.match.counts }))
  const sum = (k) => list.reduce((a, f) => a + f[k], 0)
  /* 四份明细按口径分开列：报数字的那一行必须与它引用的明细同口径，否则读表的人会拿严口径的名单 */
  /* 去质疑松口径的百分比（第一版就这么错过：打印 100% precision 同时说"1 个没沾到"）。 */
  const missed = []              // 严口径漏报：IoU 没到门槛（含"沾边但框不贴合"）
  const missedLoose = []         // 松口径漏报：连沾边都没有
  const falsePositives = []      // 严口径误报
  const falsePositivesLoose = [] // 松口径误报：完全落空
  const looseHits = []           // 压住了但框不贴合——两个口径的差额全在这
  for (const f of list) {
    for (const t of f.match.truths) {
      const hit = { frame: f.id, id: t.id, label: t.label, box: t.box, bestIou: t.bestIou }
      if (!t.matched) missed.push(hit)
      if (!t.overlapped) missedLoose.push(hit)
    }
    for (const x of f.match.finals) {
      if (!x.scored) continue
      const hit = { frame: f.id, label: x.label, box: x.box, bestIou: x.bestIou, truth: x.truth }
      if (!x.overlapped) falsePositivesLoose.push(hit)
      if (!x.matched) {
        falsePositives.push(hit)
        if (x.overlapped) looseHits.push(hit)
      }
    }
  }
  const scoredFinals = sum('finals') - sum('unscored')
  const matchedFinals = list.reduce((a, f) => a + f.match.finals.filter((x) => x.scored && x.matched).length, 0)
  const overlappedFinals = list.reduce((a, f) => a + f.match.finals.filter((x) => x.scored && x.overlapped).length, 0)
  return {
    iouThr: thr,
    frames: list.length,
    scoredFrames: list.filter((f) => f.truths > 0).length,
    finals: sum('finals'),
    scoredFinals,
    unscoredFinals: sum('unscored'),
    truths: sum('truths'),
    /** 需求口径：recall 严（IoU 门槛），precision 松（重叠即可） */
    recall: pct(sum('truthMatched'), sum('truths')),
    precision: pct(overlappedFinals, scoredFinals),
    /** 另一口径，成对读才知道"丢在哪一侧" */
    recallLoose: pct(sum('truthOverlapped'), sum('truths')),
    precisionStrict: pct(matchedFinals, scoredFinals),
    missed,
    missedLoose,
    falsePositives,
    falsePositivesLoose,
    looseHits,
    /** 命中框的贴合度（面积比）分布——precision 的"宽松"口径只有配上它才说得清框松到什么程度 */
    areaRatio: {
      median: median(list.flatMap((f) => f.match.finals.filter((x) => x.scored && x.matched && x.areaRatio != null).map((x) => x.areaRatio))),
      max: (() => {
        const xs = list.flatMap((f) => f.match.finals.filter((x) => x.scored && x.matched && x.areaRatio != null).map((x) => x.areaRatio))
        return xs.length ? Math.max(...xs) : null
      })(),
    },
    byFrame: Object.fromEntries(list.map((f) => [f.id, {
      truths: f.truths,
      truthMatched: f.truthMatched,
      finals: f.finals - f.unscored,
      finalMatched: f.match.finals.filter((x) => x.scored && x.matched).length,
    }])),
  }
}

/**
 * 校验真值文件（`[{id,label,box:[x,y,w,h]}]`，可选 `frame:[w,h]` 与 `why`）。
 * `frames` = 本次取样帧的 `{id 后四位 → {ctrlW, ctrlH}}`：给了就顺带校**空间**——
 * 标注与帧不是同一分辨率时拒绝打分（比错空间、得出一串假误报更糟）。
 * 返回 `{entries, errors}`：errors 非空由调用方决定怎么退出，本函数不抛。
 */
export function parseTruth(raw, frames = null) {
  const errors = []
  if (!Array.isArray(raw)) return { entries: [], errors: ['真值文件应为数组 [{id,label,box,frame?,why?}]'] }
  const entries = []
  raw.forEach((x, i) => {
    const at = `第 ${i + 1} 条`
    const bad = (msg) => { errors.push(msg); return true }
    let broken = false
    if (!x || typeof x !== 'object') broken = bad(`${at}不是对象`)
    const id = String(x?.id ?? '')
    if (!broken && !/^\d{4}$/.test(id)) broken = bad(`${at}的 id 必须是库内序号后四位（形如 "0004"），实际 ${JSON.stringify(x?.id)}`)
    if (!broken && (typeof x.label !== 'string' || !x.label)) broken = bad(`${at}缺 label`)
    const box = !broken && Array.isArray(x.box) ? x.box.map(Number) : null
    if (!broken && (!box || box.length !== 4 || box.some((v) => !Number.isFinite(v)))) broken = bad(`${at}的 box 必须是 4 个数字 [x,y,w,h]`)
    else if (!broken && (!(box[2] > 0) || !(box[3] > 0))) broken = bad(`${at}的 box 宽高必须为正`)
    let frame = null
    if (!broken && x.frame != null) {
      const f = Array.isArray(x.frame) ? x.frame.map(Number) : null
      if (!f || f.length !== 2 || f.some((v) => !Number.isFinite(v))) broken = bad(`${at}的 frame 必须是 [w,h]`)
      else frame = f
    }
    if (broken) return
    if (frame && frames) {
      const rec = frames[id]
      if (!rec) errors.push(`${at}引用了本次未选中的帧 ${id}（用 --frames 调大取样范围）`)
      else if (rec.ctrlW !== frame[0] || rec.ctrlH !== frame[1])
        errors.push(`${at}（帧 ${id}）标注空间 ${frame[0]}x${frame[1]} 与该帧实际 ${rec.ctrlW}x${rec.ctrlH} 不一致——不同空间的框不能比，拒绝打分`)
      else entries.push({ id, label: x.label, box, frame, why: x.why ?? null })
      return
    }
    entries.push({ id, label: x.label, box, frame, why: x.why ?? null })
  })
  return { entries, errors }
}

/** 真值 → 用例 ROI：每边外扩一个档位（`6` = 6px；`25%` = 元素长边的 25%），并夹到帧内。 */
export function padspecsToRois(entries, specs, frameSize) {
  const out = []
  for (const spec of specs) {
    const isPct = typeof spec === 'string' && spec.trim().endsWith('%')
    const v = parseFloat(spec)
    if (!Number.isFinite(v) || v < 0) throw new Error('--truth-pad 档位无法解析：' + spec)
    for (const e of entries) {
      const long = Math.max(e.box[2], e.box[3])
      const pad = Math.round(isPct ? (v / 100) * long : v)
      const x = e.box[0] - pad
      const y = e.box[1] - pad
      const w = e.box[2] + pad * 2
      const h = e.box[3] + pad * 2
      const cx = Math.max(0, x)
      const cy = Math.max(0, y)
      const roi = [cx, cy, Math.min(frameSize.w, x + w) - cx, Math.min(frameSize.h, y + h) - cy]
      out.push({ entry: e, pad, label: `${e.label}@+${pad}px${isPct ? `(${v}%)` : ''}`, roi })
    }
  }
  return out
}
