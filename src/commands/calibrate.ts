/**
 * 变化检测阈值校准：静止画面采帧，统计分块亮度差 / 全局位差率的噪声分布，
 * 推荐 blockThresh / changeGlobal。校准期间画面必须静止（max≫p99 会警告重跑）。
 */
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { calibrate, withDaemon } from '../runtime/actions.js'
import { describeSession, ensureSession } from '../runtime/session.js'
import { CONNECT_OPTIONS, daemonFail, sessionOptions } from './runtime.js'

export const calibrateCommand: Command = {
  name: 'calibrate',
  summary: '变化检测阈值校准：静止画面采帧定噪声地板，推荐 blockThresh / changeGlobal',
  usage: 'maafw-live calibrate [--frames n] [--interval ms] --project <dir>|--kind ...\n' +
    '       采集期间保持画面静止；结果给出可直接粘贴的 stream start 参数',
  options: { ...CONNECT_OPTIONS, frames: { type: 'string' }, interval: { type: 'string' } },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx.values)
    if (!o.project && !o.kind) {
      return fail('BAD_ARGUMENTS', '校准要设备：给 --project <dir>（推荐）或 --kind win32|adb|gamepad', undefined, EXIT.USAGE)
    }
    const frames = typeof ctx.values.frames === 'string' ? Number(ctx.values.frames) : undefined
    if (frames !== undefined && !Number.isFinite(frames)) {
      return fail('BAD_ARGUMENTS', '--frames 必须是数字（6..60，默认 24）', undefined, EXIT.USAGE)
    }
    const interval = typeof ctx.values.interval === 'string' ? Number(ctx.values.interval) : undefined
    if (interval !== undefined && !Number.isFinite(interval)) {
      return fail('BAD_ARGUMENTS', '--interval 必须是毫秒数（默认 300）', undefined, EXIT.USAGE)
    }
    try {
      return await withDaemon(async (client) => {
        const s = await ensureSession(client, o)
        const r = await calibrate(client, {
          ...(frames !== undefined ? { frames } : {}),
          ...(interval !== undefined ? { interval } : {}),
        })
        if (r.ok === false) {
          return fail('CALIBRATE', String(r.error ?? '校准失败'), undefined, EXIT.FINDINGS)
        }
        const block = r.block as { p50: number; p99: number; max: number }
        const global = r.global as { p50: number; p99: number; max: number }
        return {
          exitCode: r.warn ? EXIT.FINDINGS : EXIT.OK,
          human: [
            ...describeSession(s),
            '校准 ' + String(r.frames) + ' 帧（分块亮度差 / 全局位差率的噪声分布）：',
            '  分块差  p50=' + block.p50 + '  p99=' + block.p99 + '  max=' + block.max,
            '  位差率  p50=' + global.p50 + '  p99=' + global.p99 + '  max=' + global.max,
            '  推荐：' + String(r.apply),
            ...(r.warn ? ['  警告：' + String(r.warn)] : []),
          ],
          data: r,
          ...(r.warn ? { warnings: [String(r.warn)] } : {}),
        }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const CALIBRATE_COMMANDS: Command[] = [calibrateCommand]
