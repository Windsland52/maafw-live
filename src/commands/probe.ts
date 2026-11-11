/**
 * `maafw-live screencap-probe` —— 截图能力探测：判定"后台可截"（A 路前提）。
 *
 * 方法（契约 demo-trace §3）：用另一个窗口把目标**完全盖住**，两次 `post_screencap`
 * 间隔比 blockHash 与亮度。探针不知道"此刻是否真的遮挡"——所以 `--occluded` 让用户
 * 显式声明；不给时判定结果如实标 `occluded:null`，不把"未声明遮挡"混成"前台结论"。
 *
 * 判据：
 *   changed==true + occluded   → 后台可截（A 路前提成立）
 *   changed==true + !occluded  → 像素在变——要判"后台可截"得在遮挡下重测
 *   changed==false + 正常亮度  → 静止（目标停止渲染？改应用设置）
 *   黑图 / post_screencap 报错 → 截图方法不兼容，换 `win32.screencap` 方法
 */
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { screencapProbe, withDaemon } from '../runtime/actions.js'
import { describeSession, ensureSession, type SessionOptions } from '../runtime/session.js'
import { CONNECT_OPTIONS, daemonFail, sessionOptions } from './runtime.js'

const needSession = (o: SessionOptions) =>
  o.project || o.kind ? null : fail('NO_SESSION', '用法：maafw-live screencap-probe --project <dir> 或 --kind ...', undefined, EXIT.USAGE)

export const screencapProbeCommand: Command = {
  name: 'screencap-probe',
  summary: '截图能力探测：判定"后台可截"（A 路前提）——两次截图比像素与亮度',
  usage: 'maafw-live screencap-probe [--project <dir>|--kind ...] [--interval ms] [--occluded]\n' +
    '       先 connect/起会话；要用另一个窗口把目标完全盖住后，带 --occluded 再跑一次',
  options: {
    ...CONNECT_OPTIONS,
    interval: { type: 'string' },
    occluded: { type: 'boolean' },
  },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx)
    const miss = needSession(o)
    if (miss) return miss
    const interval = ctx.values.interval !== undefined ? Number(ctx.values.interval) : 3000
    const occluded = ctx.values.occluded === true
    try {
      return await withDaemon(ctx, async (client) => {
        const s = await ensureSession(client, o)
        const r = await screencapProbe(client, interval, occluded)
        const first = (r.first ?? {}) as { ok?: boolean; w?: number; h?: number; hash?: string; mean?: number; error?: string }
        const second = (r.second ?? {}) as { ok?: boolean; w?: number; h?: number; hash?: string; mean?: number; error?: string }
        const lines = [
          ...describeSession(s, ctx.flags.verbose),
          '截图能力探测：两次 post_screencap 间隔 ' + String(r.intervalMs) + 'ms'
            + (r.occluded === true ? '（已声明窗口被完全遮挡）' : '（未声明遮挡——判据只在遮挡态成立）'),
        ]
        if (first.ok) lines.push('  第 1 帧：' + first.w + 'x' + first.h + ' hash=' + String(first.hash).slice(0, 24) + '… mean=' + first.mean)
        else if (first.error !== undefined || 'ok' in first) lines.push('  第 1 帧：失败——' + String(first.error))
        if (second.ok) lines.push('  第 2 帧：' + second.w + 'x' + second.h + ' hash=' + String(second.hash).slice(0, 24) + '… mean=' + second.mean)
        else if (second.error !== undefined || 'ok' in second) lines.push('  第 2 帧：失败——' + String(second.error))
        if (r.changed !== null && r.changed !== undefined) lines.push('  像素：' + (r.changed ? '在变' : '未变'))
        lines.push('  判定：' + String(r.verdict) + '——' + String(r.note ?? ''))
        const verdict = String(r.verdict)
        const exitCode = verdict === 'changing' && occluded ? EXIT.OK
          : verdict === 'error' ? EXIT.FINDINGS
          : EXIT.FINDINGS  // black/static 都是要处置的发现；changing 但没声明遮挡 = 未定论
        return { exitCode, human: lines, data: r }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}
