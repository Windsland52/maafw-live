/**
 * 识别单测：maafw-live reco。
 *
 * 走 daemon 的 reco_test —— 它把识别放进一次性子进程执行（beta 绑定在无效模板上会原生崩溃，
 * 子进程炸掉只损失一次测试，不带走调用方）。支持阈值扫描：一次调用给出阈值-命中曲线。
 * 项目模式下资源目录从 interface.json 解析，避免手写路径与项目声明不一致。
 */
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { recoTest, withDaemon, type CropKfSource } from '../runtime/actions.js'
import { defaultFramesDir, resolveFrame, type KfRecord } from '../runtime/keyframes.js'
import { describeSession, ensureSession, offlineResource, type SessionState } from '../runtime/session.js'
import { CONNECT_OPTIONS, daemonFail, sessionOptions } from './runtime.js'

function parseJson<T>(raw: unknown, what: string): { value?: T; error?: string } {
  if (raw === undefined) return {}
  if (typeof raw !== 'string') return {}
  try {
    return { value: JSON.parse(raw) as T }
  } catch (e) {
    return { error: what + ' 不是合法 JSON：' + String((e as Error).message) }
  }
}

/** threshold 起点建议（maafw-pipeline 技能口径）：实测最高置信度 − 0.1 留余量，换场景会掉。
 * 得分在识别详情内层（detail.detail.best/all——miss 时 best 为 null，all 仍带各候选得分）；
 * 无数值得分的类型（OCR 等）返回 null，不编造。低于 0.5 视为模板与画面不匹配：
 * 未命中不是调低阈值的理由，建议不适用。 */
export interface ThresholdSuggestion {
  bestScore: number
  suggest: number | null
  lowMatch: boolean
}

export function suggestThreshold(
  results: Array<{ ok: boolean; detail?: unknown }>,
): ThresholdSuggestion | null {
  let best = -1
  for (const r of results) {
    const inner = (r.detail as { detail?: { best?: { score?: unknown }; all?: Array<{ score?: unknown }> } } | null | undefined)?.detail
    const candidates = [Number(inner?.best?.score), ...(inner?.all ?? []).map((x) => Number(x.score))]
    for (const s of candidates) if (Number.isFinite(s) && s > best) best = s
  }
  if (best < 0) return null
  const bestScore = Math.round(best * 1000) / 1000
  const lowMatch = best < 0.5
  return {
    bestScore,
    suggest: lowMatch ? null : Math.max(0, Math.round((best - 0.1) * 1000) / 1000),
    lowMatch,
  }
}

export const recoCommand: Command = {
  name: 'reco',
  summary: '识别单测（子进程隔离）：--param/--sweep 阈值扫描，或 --node 整节点 JSON 透传；--act 真机执行动作半',
  usage: 'maafw-live reco --type TemplateMatch --resource-dir <dir> --image <png|kf:ID> [--param <json>] [--sweep <json>] [--project <dir>]\n' +
    '       maafw-live reco --node <json> --resource-dir <dir> --image <png|kf:ID>   （V1 扁平 / V2 嵌套节点均原样透传）\n' +
    '       maafw-live reco --node <json> --resource-dir <dir> --from-kf <kf:库UUID:序号>   （库内留存帧：离线、不需要设备）\n' +
    '       maafw-live reco --node <json> --act --project <dir>               （识别拿框 → 用框 run_action 真机执行）',
  options: {
    ...CONNECT_OPTIONS,
    type: { type: 'string' },
    'resource-dir': { type: 'string' },
    image: { type: 'string' },
    seq: { type: 'string' },
    param: { type: 'string' },
    sweep: { type: 'string' },
    node: { type: 'string' },
    act: { type: 'boolean' },
    'from-kf': { type: 'string' },
    'frames-dir': { type: 'string' },
  },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx.values)
    const type = typeof ctx.values.type === 'string' ? ctx.values.type : 'TemplateMatch'
    const imageRaw = typeof ctx.values.image === 'string' && ctx.values.image !== '' ? ctx.values.image : undefined
    /* `--image kf:…:0011` 是 SKILL / roadmap 里记过的写法：以 kf: 开头就按**库帧 ID**解释，
     * 而不是文件路径（否则一路走到 ENOENT，实测踩过）。规范入口仍是 --from-kf。 */
    const kfFromImage = imageRaw?.startsWith('kf:') === true ? imageRaw : undefined
    const image = kfFromImage ? undefined : imageRaw
    const seq = typeof ctx.values.seq === 'string' ? Number(ctx.values.seq) : undefined
    const nodeRaw = typeof ctx.values.node === 'string' ? ctx.values.node : undefined
    let node: Record<string, unknown> | undefined
    if (nodeRaw !== undefined) {
      const parsed = parseJson<Record<string, unknown>>(nodeRaw, '--node')
      if (parsed.error) return fail('BAD_ARGUMENTS', parsed.error, undefined, EXIT.USAGE)
      if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
        return fail('BAD_ARGUMENTS', '--node 必须是 JSON 对象（pipeline 节点）', undefined, EXIT.USAGE)
      }
      node = parsed.value
    }
    const param = parseJson<Record<string, unknown>>(ctx.values.param, '--param')
    if (param.error) return fail('BAD_ARGUMENTS', param.error, undefined, EXIT.USAGE)
    const sweep = parseJson<Record<string, unknown>>(ctx.values.sweep, '--sweep')
    if (sweep.error) return fail('BAD_ARGUMENTS', sweep.error, undefined, EXIT.USAGE)

    const act = ctx.values.act === true

    /* 库帧来源（离线，镜像 crop / annotate 的 --from-kf）：先走离线读侧解析，daemon 只接身份与路径 */
    const fromKf = typeof ctx.values['from-kf'] === 'string' && ctx.values['from-kf'] !== ''
      ? ctx.values['from-kf']
      : kfFromImage
    if (fromKf !== undefined && seq !== undefined) {
      return fail('BAD_ARGUMENTS', '--from-kf 与 --seq 互斥：前者在库内留存帧上跑，后者在本会话缓冲帧上跑',
        '取库里有哪些帧：maafw-live kf list', EXIT.USAGE)
    }
    let kfSource: CropKfSource | undefined
    if (fromKf !== undefined) {
      const dir = typeof ctx.values['frames-dir'] === 'string' ? ctx.values['frames-dir'] : defaultFramesDir()
      const rf = resolveFrame(dir, fromKf)
      if (rf.status !== 'available' || !rf.path || !rf.record) {
        const code = rf.status === 'corrupt' ? 'KF_CORRUPT' : (rf.status === 'unsupported' ? 'KF_UNSUPPORTED' : 'KF_MISSING')
        return fail(code, '库帧不可用（' + rf.status + '）：' + String(rf.reason ?? '') + '（库 ' + dir + '）',
          'kf list 看库内有哪些帧；missing 表示本机不可复核，不代表历史从未观测', EXIT.FINDINGS)
      }
      const rec = rf.record as KfRecord
      kfSource = {
        id: rec.id, path: rf.path, sha256: rec.sha256, ctrlW: rec.ctrlW, ctrlH: rec.ctrlH,
        captureSeq: rec.captureSeq, capturedAt: rec.capturedAt,
      }
    }
    const offline = kfSource !== undefined
    if (act && offline) {
      return fail('BAD_ARGUMENTS', '--act 要在真机上执行动作、图像取自当前画面：不能与 --from-kf 同用',
        '离线只做识别判据；要连真机就把 --from-kf 换成 --project 跑 --act', EXIT.USAGE)
    }

    try {
      return await withDaemon(async (client) => {
        const s: SessionState = offline ? { connected: false } : await ensureSession(client, o)
        let resourceDir = (typeof ctx.values['resource-dir'] === 'string' ? ctx.values['resource-dir'] : undefined)
          ?? s.plan?.resource?.paths[0]
        if (!resourceDir && offline && o.project) {
          /* 离线：项目只作资源来源（模板与 OCR 模型），不扫设备不连接 */
          const off = offlineResource(o.project, o.controller, o.resource)
          if (off.error) {
            return fail('PLAN_FAILED', '离线解析项目资源失败：' + off.error, '也可以直接给 --resource-dir <dir>', EXIT.FINDINGS)
          }
          resourceDir = off.paths[0]
        }
        if (!resourceDir) {
          return fail('BAD_ARGUMENTS', '缺少资源目录：给 --resource-dir <dir>，或用 --project <dir> 让 interface.json 决定',
            undefined, EXIT.USAGE)
        }
        if (act) {
          /* --act：识别拿框 → 真机 run_action。图像来自当前画面（daemon 抓帧），不吃 --image/--seq */
          if (!node) {
            return fail('BAD_ARGUMENTS', '--act 需要同时给 --node <json>（整节点，含 action）', undefined, EXIT.USAGE)
          }
          if (!o.project && !o.kind) {
            return fail('BAD_ARGUMENTS', '--act 要真机执行动作：给 --project <dir> 或 --kind 连接设备',
              '多步操作用 maafw-live repl', EXIT.USAGE)
          }
          const r = await recoTest(client, { resourceDir, act: true, node })
          if (r.ok === false) {
            return fail('RECO_ACT', String(r.error ?? '动作单测失败'),
              r.stage === 'recognition' ? '识别未命中/报错——动作半未执行' : undefined, EXIT.FINDINGS)
          }
          const reco = r.reco as { box?: number[] } | undefined
          const retention = r.retention as { before?: { seq?: number }, after?: { seq?: number } } | undefined
          return {
            exitCode: EXIT.OK,
            human: [
              ...describeSession(s),
              '节点单测（识别→动作，真机执行）：',
              '  识别框 ' + JSON.stringify(reco?.box ?? null),
              '  动作回执 ' + JSON.stringify(r.action ?? null),
              '  边界帧 seq ' + String(retention?.before?.seq) + ' → ' + String(retention?.after?.seq) +
                '（frame_get / kf promote 可复核动作效果）',
            ],
            data: r,
          }
        }
        if (!image && seq === undefined && !offline) {
          return fail('BAD_ARGUMENTS', '缺少图像：一次性命令给 --image <png>；用缓冲帧（--seq）需要在 maafw-live repl 里先 stream start',
            '库里留存帧用 --from-kf <kf:…>（离线、不需要设备）', EXIT.USAGE)
        }
        const r = await recoTest(client, {
          resourceDir, type,
          ...(image ? { image } : {}),
          ...(seq !== undefined ? { seq } : {}),
          ...(kfSource ? { kfSource } : {}),
          ...(node ? { node } : {}),
          ...(!node && param.value ? { param: param.value } : {}),
          ...(!node && sweep.value ? { sweep: sweep.value } : {}),
        })
        const results = (r.results as Array<{ param: Record<string, unknown>; ms: number; ok: boolean }> | undefined) ?? []
        const human = [
          ...describeSession(s),
          '识别 ' + String(r.type ?? type) + '：' + results.length + ' 例' + (node ? '（整节点透传）' : ''),
          ...results.map((x) => '  ' + (x.ok ? '[命中]' : '[未中]') + ' ' + JSON.stringify(x.param) + '  ' + x.ms + 'ms'),
        ]
        const th = suggestThreshold(r.results as Array<{ ok: boolean; detail?: unknown }> | undefined ?? [])
        if (th && th.suggest !== null) {
          human.push('  实测最高置信度 ' + th.bestScore + ' → threshold 起点建议 ' + th.suggest +
            '（实测 − 0.1 留余量，换场景会掉；ROI 收紧可再提）')
        } else if (th && th.lowMatch) {
          human.push('  实测最高置信度 ' + th.bestScore + '：模板与该画面不匹配——threshold 建议不适用，' +
            '先核对模板来源画面与当前画面（识别未命中不是调低阈值的理由）')
        } else if (results.length > 0) {
          /* 第三形态：识别跑了，但一个置信度都没带回来（实测：模板文件读不到时就是这个签名——
           * ~230ms、`[未中]`、detail.best 空、all 为空）。它和"分数低的未命中"必须分得开：
           * 后者是画面不匹配（有分数），前者是**输入当时读不到**，处置方向完全不同。 */
          human.push('  识别未返回任何置信度（' + results.length + ' 例）：这与"分数低的未命中"不同——' +
            '多半是模板/资源当时没读到（资源包未加载、模板文件缺失或不可读、临时文件正被杀软扫描）。' +
            '先核对 --resource-dir 与模板是否存在，再重跑一次看是否复现；别当成"画面不匹配"去调阈值')
        }
        if (r.ok === false) human.push('error: ' + String(r.error))
        /* 机器侧也要能一眼认出第三形态（阈值建议缺席 ≠ 没跑） */
        const noConfidence = th === null && results.length > 0
        return {
          exitCode: r.ok === false ? EXIT.FINDINGS : EXIT.OK,
          human,
          data: { ...r, ...(th ? { thresholdSuggestion: th } : {}), ...(noConfidence ? { noConfidence: true } : {}) },
        }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const RECO_COMMANDS: Command[] = [recoCommand]
