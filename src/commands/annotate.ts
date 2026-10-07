/**
 * annotate（轻量 SoM）：候选区域 + 编号回画。
 *
 * 模型消费方式：看回画图选编号 → 查候选表 ctrl 坐标 → click / reco / crop。
 * 候选源：OCR 框（语义最强）、变化 diff 区域、连通域、边缘密度；半透明/粒子/渐变场景
 * 候选质量降级——那时走点选路径（crop --point），两条路径互为降级。
 *
 * 源帧两条路：会话内 L1 小图（缺省，一次性命令自动截一帧）或**关键帧库留存帧**（`--from-kf`，
 * 控制器分辨率、离线、不需要设备）。库帧路径下 diff 源不可用（没有会话事件），工具如实报出，
 * 不拿别的区域顶替——所以它适合"事后在旧帧上重跑候选"，不适合替代实时变化检测。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultFramesDir, resolveFrame, type KfRecord } from '../runtime/keyframes.js'
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { annotate, screencap, withDaemon, type CropKfSource } from '../runtime/actions.js'
import { describeSession, ensureSession, offlineResource, type SessionState } from '../runtime/session.js'
import { CONNECT_OPTIONS, daemonFail, sessionOptions } from './runtime.js'

export const annotateCommand: Command = {
  name: 'annotate',
  summary: '轻量 SoM：OCR/diff/连通域/边缘密度候选区域 + 编号回画（源可为会话内帧或关键帧库留存帧）',
  usage: 'maafw-live annotate [--seq n] [--out <png>] [--resource-dir <dir>] [--project <dir>|--kind ...]\n' +
    '       maafw-live annotate --from-kf <kf:库UUID:序号> [--frames-dir <dir>] [--out <png>] [--resource-dir <dir>|--project <dir>]\n' +
    '       OCR 候选需要资源目录（OCR 模型）；一次性命令自动截一帧；其余候选源无依赖\n' +
    '       --from-kf 在库里留存帧上离线跑（不需要设备；该路径没有会话事件，diff 源不可用）',
  options: {
    ...CONNECT_OPTIONS,
    seq: { type: 'string' },
    out: { type: 'string' },
    'resource-dir': { type: 'string' },
    'from-kf': { type: 'string' },
    'frames-dir': { type: 'string' },
  },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx.values)
    const seq = typeof ctx.values.seq === 'string' ? Number(ctx.values.seq) : undefined
    if (ctx.values.seq !== undefined && !Number.isFinite(seq)) {
      return fail('BAD_ARGUMENTS', '--seq 必须是数字', undefined, EXIT.USAGE)
    }
    const out = typeof ctx.values.out === 'string' ? ctx.values.out : undefined
    const fromKf = typeof ctx.values['from-kf'] === 'string' ? ctx.values['from-kf'] : undefined
    if (fromKf !== undefined && seq !== undefined) {
      return fail('BAD_ARGUMENTS', '--from-kf 与 --seq 互斥：前者在库内留存帧上跑，后者在本会话缓冲帧上跑',
        '取库里有哪些帧：maafw-live kf list', EXIT.USAGE)
    }

    /* 库帧来源：先走离线读侧解析（契约 §4.1），daemon 只接身份与路径 */
    let kfSource: CropKfSource | undefined
    if (fromKf !== undefined) {
      const dir = typeof ctx.values['frames-dir'] === 'string' ? ctx.values['frames-dir'] : defaultFramesDir()
      const r = resolveFrame(dir, fromKf)
      if (r.status !== 'available' || !r.path || !r.record) {
        const code = r.status === 'corrupt' ? 'KF_CORRUPT' : (r.status === 'unsupported' ? 'KF_UNSUPPORTED' : 'KF_MISSING')
        return fail(code, '库帧不可用（' + r.status + '）：' + String(r.reason ?? '') + '（库 ' + dir + '）',
          'kf list 看库内有哪些帧；missing 表示本机不可复核，不代表历史从未观测', EXIT.FINDINGS)
      }
      const rec = r.record as KfRecord
      kfSource = {
        id: rec.id, path: r.path, sha256: rec.sha256, ctrlW: rec.ctrlW, ctrlH: rec.ctrlH,
        captureSeq: rec.captureSeq, capturedAt: rec.capturedAt,
      }
    }
    const offline = kfSource !== undefined

    try {
      return await withDaemon(async (client) => {
        const s: SessionState = offline ? { connected: false } : await ensureSession(client, o)
        let resourceDir = (typeof ctx.values['resource-dir'] === 'string' ? ctx.values['resource-dir'] : undefined)
          ?? s.plan?.resource?.paths[0]
        if (!resourceDir && offline && o.project) {
          /* 离线：项目只作资源的来源（OCR 模型），不扫设备不连接 */
          const off = offlineResource(o.project, o.controller, o.resource)
          if (off.error) {
            return fail('PLAN_FAILED', '离线解析项目资源失败：' + off.error, '也可以直接给 --resource-dir <dir>', EXIT.FINDINGS)
          }
          resourceDir = off.paths[0]
        }
        /* 一次性命令缓冲为空：先截一帧（截帧文件写临时目录）。库帧路径不截帧——源已固定。 */
        if (!offline && seq === undefined) {
          await screencap(client, join(tmpdir(), 'maafw_annotate_' + Date.now() + '.png')).catch(() => null)
        }
        const r = await annotate(client, {
          ...(offline ? { kfSource } : {}),
          ...(!offline && seq !== undefined ? { seq } : {}),
          ...(out ? { out } : {}),
          ...(resourceDir ? { resourceDir } : {}),
        })
        if (r.ok === false) {
          return fail('ANNOTATE', String(r.error ?? '候选生成失败'),
            offline
              ? '库帧候选失败通常是文件被改动或库记录不一致；kf resolve 可复核'
              : '需要观测：REPL 里先 screencap / stream start；一次性命令会自动截一帧',
            EXIT.FINDINGS)
        }
        const cands = (r.candidates as Array<{ id: number; source: string; ctrl: number[]; text?: string }>) ?? []
        const sources = r.sources as Record<string, number> | undefined
        const src = r.source as { kind?: string; id?: string; captureSeq?: number | null; seq?: number } | undefined
        const unavailable = r.sourcesUnavailable as Record<string, string> | undefined
        const ctrl = Array.isArray(r.ctrl) ? (r.ctrl as number[]) : null
        const srcLine = src?.kind === 'kf'
          ? '源帧 ' + String(src.id) + '（留存帧，捕获 seq=' + String(src.captureSeq) + '，' +
            String(ctrl?.[0] ?? '?') + 'x' + String(ctrl?.[1] ?? '?') + '，离线）'
          : '源帧 seq=' + String(r.seq) + '（小图 ' + JSON.stringify(r.small) + ' × ctrl ' + JSON.stringify(r.ctrl) + '）'
        return {
          exitCode: EXIT.OK,
          human: [
            ...describeSession(s),
            ...(offline ? ['离线候选：未连接设备（库帧是本机持久文件）'] : []),
            'SoM 候选 ' + String(r.count) + ' 个（ocr ' + String(sources?.ocr ?? 0) + ' / diff ' + String(sources?.diff ?? 0) +
              ' / conn ' + String(sources?.conn ?? 0) + ' / edge ' + String(sources?.edge ?? 0) + '）→ ' + String(r.out),
            '  ' + srcLine,
            ...(unavailable ? Object.entries(unavailable).map(([k, v]) => '  ' + k + ' 源不可用：' + v) : []),
            '  坐标为控制器分辨率：',
            ...cands.map((c) => '  #' + c.id + ' [' + c.source + '] ctrl=' + c.ctrl.join(',') + (c.text ? '  "' + c.text + '"' : '')),
            ...(r.warn ? ['  警告：' + String(r.warn)] : []),
            '选号后：click / reco --node（roi 用 ctrl 坐标）/ crop --roi（可再 crop --from-kf 于同一帧）',
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
