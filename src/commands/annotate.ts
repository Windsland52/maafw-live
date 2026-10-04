/**
 * annotate（轻量 SoM）：候选区域 + 编号回画。
 *
 * 模型消费方式：看回画图选编号 → 查候选表 ctrl 坐标 → click / reco / crop。
 * 候选源：OCR 框（语义最强）、变化 diff 区域、连通域、边缘密度；半透明/粒子/渐变场景
 * 候选质量降级——那时走点选路径（crop --point），两条路径互为降级。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { annotate, screencap, withDaemon } from '../runtime/actions.js'
import { describeSession, ensureSession } from '../runtime/session.js'
import { CONNECT_OPTIONS, daemonFail, sessionOptions } from './runtime.js'

export const annotateCommand: Command = {
  name: 'annotate',
  summary: '轻量 SoM：OCR/diff/连通域/边缘密度候选区域 + 编号回画（模型选号 → 查 ctrl 坐标）',
  usage: 'maafw-live annotate [--seq n] [--out <png>] [--resource-dir <dir>] [--project <dir>|--kind ...]\n' +
    '       OCR 候选需要资源目录（OCR 模型）；一次性命令自动截一帧；其余候选源无依赖',
  options: { ...CONNECT_OPTIONS, seq: { type: 'string' }, out: { type: 'string' }, 'resource-dir': { type: 'string' } },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx.values)
    const seq = typeof ctx.values.seq === 'string' ? Number(ctx.values.seq) : undefined
    if (ctx.values.seq !== undefined && !Number.isFinite(seq)) {
      return fail('BAD_ARGUMENTS', '--seq 必须是数字', undefined, EXIT.USAGE)
    }
    const out = typeof ctx.values.out === 'string' ? ctx.values.out : undefined
    try {
      return await withDaemon(async (client) => {
        const s = await ensureSession(client, o)
        const resourceDir = (typeof ctx.values['resource-dir'] === 'string' ? ctx.values['resource-dir'] : undefined)
          ?? s.plan?.resource?.paths[0]
        /* 一次性命令缓冲为空：先截一帧（截帧文件写临时目录） */
        if (seq === undefined) {
          await screencap(client, join(tmpdir(), 'maafw_annotate_' + Date.now() + '.png')).catch(() => null)
        }
        const r = await annotate(client, {
          ...(seq !== undefined ? { seq } : {}),
          ...(out ? { out } : {}),
          ...(resourceDir ? { resourceDir } : {}),
        })
        if (r.ok === false) {
          return fail('ANNOTATE', String(r.error ?? '候选生成失败'),
            '需要观测：REPL 里先 screencap / stream start；一次性命令会自动截一帧', EXIT.FINDINGS)
        }
        const cands = (r.candidates as Array<{ id: number; source: string; ctrl: number[]; text?: string }>) ?? []
        const sources = r.sources as Record<string, number> | undefined
        return {
          exitCode: EXIT.OK,
          human: [
            ...describeSession(s),
            'SoM 候选 ' + String(r.count) + ' 个（ocr ' + String(sources?.ocr ?? 0) + ' / diff ' + String(sources?.diff ?? 0) +
              ' / conn ' + String(sources?.conn ?? 0) + ' / edge ' + String(sources?.edge ?? 0) + '）→ ' + String(r.out),
            '  坐标为控制器分辨率（小图 ' + JSON.stringify(r.small) + ' × ' + JSON.stringify(r.ctrl) + '）：',
            ...cands.map((c) => '  #' + c.id + ' [' + c.source + '] ctrl=' + c.ctrl.join(',') + (c.text ? '  "' + c.text + '"' : '')),
            ...(r.warn ? ['  警告：' + String(r.warn)] : []),
            '选号后：click / reco --node（roi 用 ctrl 坐标）/ crop --roi',
          ],
          data: r,
          written: [String(r.out)],
        }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const ANNOTATE_COMMANDS: Command[] = [annotateCommand]
