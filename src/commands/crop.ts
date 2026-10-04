/**
 * 模板裁剪：低精度输入（宽松框或点+外扩）→ snap 收紧 → 从 L0 原图裁剪 →
 * 同帧自匹配逐边重试取得分最高边界。
 *
 * 关键约束：模板尺寸必须与识别空间一致——只从 L0 原图（控制器分辨率）裁，
 * 不从降采样小图裁。点→ROI 派生与裁剪共享同一条 snap 链（roadmap 条目4/5）。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { screencap, tplCrop, withDaemon } from '../runtime/actions.js'
import { describeSession, ensureSession } from '../runtime/session.js'
import { CONNECT_OPTIONS, daemonFail, sessionOptions } from './runtime.js'

function nums(raw: string | undefined, count: number, what: string): number[] | undefined {
  if (raw === undefined) return undefined
  const v = raw.split(',').map((x) => Number(String(x).trim()))
  if (v.length !== count || v.some((n) => !Number.isFinite(n))) {
    throw new Error(what + ' 需要 ' + count + ' 个数字')
  }
  return v
}

export const cropCommand: Command = {
  name: 'crop',
  summary: '模板裁剪：宽松框/点 → snap 收紧 → L0 原图裁剪 → 自匹配验证（点→ROI 派生同链）',
  usage: 'maafw-live crop --roi x,y,w,h | --point x,y [--pad n] [--seq n] [--out <png>] [--resource-dir <dir>] [--no-cross] --project <dir>|--kind ...\n' +
    '       源帧是 L0 最新原图（screencap/stream/输入都会产生）；连接真机时自动做跨帧验证（新帧再匹配一次）',
  options: {
    ...CONNECT_OPTIONS,
    roi: { type: 'string' },
    point: { type: 'string' },
    pad: { type: 'string' },
    seq: { type: 'string' },
    out: { type: 'string' },
    'resource-dir': { type: 'string' },
    'no-cross': { type: 'boolean' },
  },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx.values)
    let roi: number[] | undefined
    let point: number[] | undefined
    try {
      roi = nums(typeof ctx.values.roi === 'string' ? ctx.values.roi : undefined, 4, '--roi')
      point = nums(typeof ctx.values.point === 'string' ? ctx.values.point : undefined, 2, '--point')
    } catch (e) {
      return fail('BAD_ARGUMENTS', (e as Error).message, undefined, EXIT.USAGE)
    }
    if (!roi && !point) {
      return fail('BAD_ARGUMENTS', '给 --roi x,y,w,h（宽松框）或 --point x,y（自动外扩成宽松框）', undefined, EXIT.USAGE)
    }
    const seq = typeof ctx.values.seq === 'string' ? Number(ctx.values.seq) : undefined
    if (ctx.values.seq !== undefined && !Number.isFinite(seq)) {
      return fail('BAD_ARGUMENTS', '--seq 必须是数字', undefined, EXIT.USAGE)
    }
    const pad = typeof ctx.values.pad === 'string' ? Number(ctx.values.pad) : undefined
    if (pad !== undefined && !Number.isFinite(pad)) {
      return fail('BAD_ARGUMENTS', '--pad 必须是数字（点→ROI 外扩半径，默认 24）', undefined, EXIT.USAGE)
    }
    const out = typeof ctx.values.out === 'string' ? ctx.values.out : undefined
    try {
      return await withDaemon(async (client) => {
        const s = await ensureSession(client, o)
        /* 自匹配要加载资源（模板走 override_image，不写项目目录）；项目模式用规划出的资源 */
        const resourceDir = (typeof ctx.values['resource-dir'] === 'string' ? ctx.values['resource-dir'] : undefined)
          ?? s.plan?.resource?.paths[0]
        if (!resourceDir) {
          return fail('BAD_ARGUMENTS', '自匹配需要资源目录：给 --resource-dir <dir> 或 --project <dir>', undefined, EXIT.USAGE)
        }
        /* L0 是进程态：一次性命令先截一帧产生观测（截帧文件写临时目录，不落用户 cwd） */
        if (seq === undefined) {
          await screencap(client, join(tmpdir(), 'maafw_crop_' + Date.now() + '.png')).catch(() => null)
        }
        const r = await tplCrop(client, {
          ...(roi ? { roi } : {}),
          ...(point ? { point } : {}),
          ...(pad !== undefined ? { pad } : {}),
          ...(seq !== undefined ? { seq } : {}),
          ...(out ? { out } : {}),
          resourceDir,
          ...(ctx.values['no-cross'] === true ? { cross: false } : {}),
        })
        if (r.ok === false) {
          return fail('TPL_CROP', String(r.error ?? '裁剪失败'),
            '源帧取 L0 最新原图：先 screencap / stream / 输入产生观测', EXIT.FINDINGS)
        }
        const box = r.box as number[]
        const cross = r.cross as { seq?: number; score?: number; posOk?: boolean; box?: number[] } | undefined
        const human = [
          ...describeSession(s),
          '模板 ' + String(r.w) + 'x' + String(r.h) + ' → ' + String(r.path),
          '  源帧 seq=' + String(r.seq) + '（' + String(r.ctrlW) + 'x' + String(r.ctrlH) + '）' +
            '  宽松框 ' + JSON.stringify(r.loose) + ' → 收紧 ' + JSON.stringify(box) + (r.snapped ? '' : '（snap 无内容收紧，用原框）'),
          '  自匹配 ' + (r.positionOk === false ? '位置错误（best 落在 ' + JSON.stringify(r.selfMatchBox ?? null) + '）' : '位置正确') +
            '，得分 ' + String(r.score) + '（' + String(r.tries) + ' 次评估）',
          ...(cross ? ['  跨帧验证 seq=' + String(cross.seq) + '：得分 ' + String(cross.score) +
            (cross.posOk ? '，位置正确' : '，位置漂移 ' + JSON.stringify(cross.box ?? null))] : []),
        ]
        if (r.warn) human.push('  警告：' + String(r.warn))
        human.push('pipeline 用法：roi ' + box.join(',') + ' + template 该文件（同帧验证：maafw-live reco --node …）')
        return {
          exitCode: r.warn ? EXIT.FINDINGS : EXIT.OK,
          human,
          data: r,
          written: [String(r.path)],
          ...(r.warn ? { warnings: [String(r.warn)] } : {}),
        }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const CROP_COMMANDS: Command[] = [cropCommand]
