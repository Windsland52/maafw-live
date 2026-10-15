/**
 * reco 参数面的共享判据：**roi 空间**校验。
 *
 * 为什么单独立一个文件：repl 与一次性 CLI 都要能给「roi 越出所用图像尺寸」下一个明确结论，
 * 判据必须只有一份 —— 两处各写一遍，迟早分叉成「CLI 报错、repl 静默」，而静默的正是最贵的那种
 * （G16：ctrl 坐标的 roi 打在 L1 小图上 → `results: []`，看起来像"模板没读到"）。
 */

/**
 * roi（控制器/图像空间）是否越出图像尺寸。越界就是**参数用错空间**，不是"没识别到"：
 * 边界相等不算越界（`x+w === w` 是贴右边）。
 *
 * 返回 null 表示在界内或无法判定（缺尺寸）。
 */
export function roiOutOfBounds(roi: number[] | undefined, w: unknown, h: unknown): string | null {
  if (!roi || roi.length !== 4) return null
  const iw = Number(w)
  const ih = Number(h)
  if (!Number.isFinite(iw) || !Number.isFinite(ih) || iw <= 0 || ih <= 0) return null
  const [x, y, rw, rh] = roi as [number, number, number, number]
  const right = x + rw
  const bottom = y + rh
  if (right <= iw && bottom <= ih) return null
  return 'roi 越出图像：roi=' + roi.join(',') + '（右 ' + right + ' / 下 ' + bottom + '）'
    + ' 超出图像尺寸 ' + iw + 'x' + ih
    + ' —— 这是**参数用错空间**（roi 按图像像素给），不是识别未命中；'
    + '控制器的 roi 要按所用图的尺寸换算（L1 小图 vs 控制器原图差一个 scale）'
}
