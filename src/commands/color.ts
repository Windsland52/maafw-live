/**
 * 探色命令：ROI 实测主色/均值（RGB/HSV/灰度）——模型只选色不报色值。
 *
 * 为什么不靠模型读像素：色值必须来自实测（降采样小图按该帧捕获尺寸换算后的 ROI），
 * 模型选完色后用 reco ColorMatch 出框（走已修好的参数透传链），出框与否是事实不是判断。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { colorProbe, screencap, withDaemon } from '../runtime/actions.js'
import { describeSession, ensureSession } from '../runtime/session.js'
import { CONNECT_OPTIONS, daemonFail, sessionOptions } from './runtime.js'

export const colorCommand: Command = {
  name: 'color',
  summary: '探色：ROI 实测均值/HSV/主色（控制器分辨率坐标；选中后用 reco ColorMatch 出框）',
  usage: 'maafw-live color [--roi x,y,w,h] [--seq n] --project <dir>|--kind ...\n' +
    '       一次性命令先自动截一帧再测；REPL 里测缓冲最新帧（先 screencap / stream）',
  options: { ...CONNECT_OPTIONS, roi: { type: 'string' }, seq: { type: 'string' } },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx.values)
    if (!o.project && !o.kind) {
      return fail('BAD_ARGUMENTS', '要设备才能探色：给 --project <dir>（推荐）或 --kind win32|adb|gamepad',
        '多步操作用 maafw-live repl（连接一次后连续观测）', EXIT.USAGE)
    }
    const roi = typeof ctx.values.roi === 'string'
      ? ctx.values.roi.split(',').map((x) => Number(String(x).trim()))
      : undefined
    if (roi && (roi.length !== 4 || roi.some((n) => !Number.isFinite(n)))) {
      return fail('BAD_ARGUMENTS', '--roi 需要 4 个数字：x,y,w,h（控制器分辨率坐标，与 pipeline 的 roi 同空间）', undefined, EXIT.USAGE)
    }
    const seq = typeof ctx.values.seq === 'string' ? Number(ctx.values.seq) : undefined
    if (ctx.values.seq !== undefined && !Number.isFinite(seq)) {
      return fail('BAD_ARGUMENTS', '--seq 必须是数字', undefined, EXIT.USAGE)
    }
    try {
      return await withDaemon(async (client) => {
        const s = await ensureSession(client, o)
        /* 一次性命令缓冲为空：先截一帧产生观测（screencap 现在进环，有捕获身份）。
         * 截帧文件写临时目录——它只是观测载体，不落在用户 cwd。 */
        if (seq === undefined) {
          await screencap(client, join(tmpdir(), 'maafw_color_' + Date.now() + '.png')).catch(() => null)
        }
        const r = await colorProbe(client, {
          ...(seq !== undefined ? { seq } : {}),
          ...(roi ? { roi } : {}),
        })
        if (r.ok === false) {
          return fail('COLOR_PROBE', String(r.error ?? '探色失败'),
            'REPL 里先 screencap 或 stream start；一次性命令会自动截一帧', EXIT.FINDINGS)
        }
        const mean = r.mean as { r: number; g: number; b: number; gray: number }
        const hsv = r.hsv as { h: number; s: number; v: number }
        const dom = r.dominant as { rgb: number[]; ratio: number }
        return {
          exitCode: EXIT.OK,
          human: [
            ...describeSession(s),
            '探色 seq=' + String(r.seq) + (roi ? '  roi=' + roi.join(',') : '  （整帧）'),
            '  均值 RGB ' + mean.r + ',' + mean.g + ',' + mean.b + '  灰度 ' + mean.gray +
              '  HSV ' + hsv.h + '°,' + hsv.s + '%,' + hsv.v + '%',
            '  主色 RGB ' + dom.rgb.join(',') + '（覆盖 ' + Math.round(dom.ratio * 100) + '%）',
            '出框验证：maafw-live reco --type ColorMatch --param \'{"color":[' + dom.rgb.join(',') + '],"threshold":0.05}\' …',
          ],
          data: r,
          suggestedCommands: [
            'maafw-live reco --type ColorMatch --param \'{"color":[' + dom.rgb.join(',') + '],"threshold":0.05}\' --image <png> --resource-dir <dir>',
          ],
        }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const COLOR_COMMANDS: Command[] = [colorCommand]
