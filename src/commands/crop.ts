/**
 * 模板裁剪：低精度输入（宽松框或点+外扩）→ snap 收紧 → 从源帧原图裁剪 →
 * 同帧自匹配逐边重试取得分最高边界。
 *
 * 关键约束：模板尺寸必须与识别空间一致——只从控制器分辨率的完整原图裁，
 * 不从降采样小图裁。点→ROI 派生与裁剪共享同一条 snap 链（roadmap 条目4/5）。
 *
 * 源帧两条路：
 *  - L0 热缓存（缺省）：进程态，seq 或最新；跨帧验证缺省开（新帧再匹配一次）。
 *  - 关键帧库留存帧（--from-kf）：库内 L0 文件，跨会话可用、**不需要设备**——
 *    不可复现状态的动线正是这条（捕获它的那次会话早已结束）。跨帧验证缺省关：
 *    留存帧对应的状态通常已不在画面上，拿当前帧比只会得到假警告。
 *
 * 裁出的 PNG 是 L2 派生图（契约 §2），旁边写 `<out>.prov.json` 出处记录
 * （契约 §5：L2 记录来源及裁剪 / 缩放变换）——出处与模板同生共死，可一起提交进仓库。
 */
import { defaultFramesDir, resolveFrame, type KfRecord } from '../runtime/keyframes.js'
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { seedObservation, tplCrop, withDaemon, type CropKfSource } from '../runtime/actions.js'
import { describeSession, ensureSession, offlineResource, type SessionState } from '../runtime/session.js'
import { CONNECT_OPTIONS, daemonFail, sessionOptions } from './runtime.js'

function nums(raw: string | undefined, count: number, what: string): number[] | undefined {
  if (raw === undefined) return undefined
  const v = raw.split(',').map((x) => Number(String(x).trim()))
  if (v.length !== count || v.some((n) => !Number.isFinite(n))) {
    throw new Error(what + ' 需要 ' + count + ' 个数字')
  }
  return v
}

/** 库里解析出来的帧 → daemon 的裁剪源（身份与路径；daemon 会复核 sha256 与像素尺寸）。 */
function kfSourceOf(r: { record?: KfRecord; path?: string }): CropKfSource {
  const rec = r.record as KfRecord
  return {
    id: rec.id,
    path: String(r.path),
    sha256: rec.sha256,
    ctrlW: rec.ctrlW,
    ctrlH: rec.ctrlH,
    captureSeq: rec.captureSeq,
    capturedAt: rec.capturedAt,
  }
}

export const cropCommand: Command = {
  name: 'crop',
  summary: '模板裁剪：宽松框/点 → snap 收紧 → 原图裁剪 → 自匹配验证（源可为 L0 热缓存或关键帧库留存帧）',
  usage: 'maafw-live crop --roi x,y,w,h | --point x,y [--pad n] [--seq n] [--out <png>] [--no-cross] --project <dir>|--kind ...\n' +
    '       maafw-live crop --from-kf <kf:库UUID:序号> --roi x,y,w,h [--frames-dir <dir>] [--resource-dir <dir> | --project <dir>] [--cross]\n' +
    '       源帧缺省是 L0 最新原图（screencap/stream/输入都会产生）；连接真机时自动做跨帧验证（新帧再匹配一次）\n' +
    '       --from-kf 改从关键帧库留存帧裁：离线可用（不需要设备），跨帧验证缺省关（留存帧对应的状态通常已不在画面上）\n' +
    '       裁出的 PNG 是 L2 派生图，旁边写 <out>.prov.json 出处记录（来源 + 裁剪变换；--no-prov 可关）\n' +
    '       --keep-source 顺手把本次裁剪用的那一帧升格进关键帧库，出处随即带上可复核的 kf: 身份\n' +
    '       （契约的模型是 L0 缓存 → 选择性升格 → 从库帧裁；少了这步，出处只剩一个随进程消失的 seq）\n' +
    '       --prov-out <dir> 把出处写到该目录下（同名），用于模板要进资源包、而资源包只装框架要加载的东西：\n' +
    '       约定不变量是"同一相对路径"（如 state-plan/provenance/ 与 image/ 同构）',
  options: {
    ...CONNECT_OPTIONS,
    roi: { type: 'string' },
    point: { type: 'string' },
    pad: { type: 'string' },
    seq: { type: 'string' },
    out: { type: 'string' },
    'resource-dir': { type: 'string' },
    'no-cross': { type: 'boolean' },
    'from-kf': { type: 'string' },
    'frames-dir': { type: 'string' },
    cross: { type: 'boolean' },
    'no-prov': { type: 'boolean' },
    'prov-out': { type: 'string' },
    'keep-source': { type: 'boolean' },
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

    const fromKf = typeof ctx.values['from-kf'] === 'string' ? ctx.values['from-kf'] : undefined
    if (fromKf !== undefined && seq !== undefined) {
      return fail('BAD_ARGUMENTS', '--from-kf 与 --seq 互斥：前者从库内留存帧裁，后者从本会话 L0 热缓存裁',
        '取库里有哪些帧：maafw-live kf list', EXIT.USAGE)
    }
    if (fromKf !== undefined && ctx.values.cross === true && ctx.values['no-cross'] === true) {
      return fail('BAD_ARGUMENTS', '--cross 与 --no-cross 互斥', undefined, EXIT.USAGE)
    }

    /* 库帧来源：先走离线读侧解析（契约 §4.1），daemon 只接身份与路径——
     * 解析失败就在这一层如实报，不把不可复核的帧送进裁剪。 */
    let kfSource: CropKfSource | undefined
    if (fromKf !== undefined) {
      const dir = typeof ctx.values['frames-dir'] === 'string' ? ctx.values['frames-dir'] : defaultFramesDir()
      const r = resolveFrame(dir, fromKf)
      if (r.status !== 'available' || !r.path || !r.record) {
        const code = r.status === 'corrupt' ? 'KF_CORRUPT' : (r.status === 'unsupported' ? 'KF_UNSUPPORTED' : 'KF_MISSING')
        return fail(code, '库帧不可用（' + r.status + '）：' + String(r.reason ?? '') + '（库 ' + dir + '）',
          'kf list 看库内有哪些帧；missing 表示本机不可复核，不代表历史从未观测', EXIT.FINDINGS)
      }
      kfSource = kfSourceOf(r)
    }
    const wantCross = ctx.values.cross === true
    /* 库帧路径默认离线：留存帧是本机持久文件，裁剪不需要设备。要跨帧验证才连。 */
    const offline = kfSource !== undefined && !wantCross
    if (kfSource !== undefined && wantCross && !o.project && !o.kind) {
      return fail('BAD_ARGUMENTS', '--cross 需要连接设备：给 --project <dir> 或 --kind',
        '不留 --cross 就是纯离线裁剪（留存帧的价值所在）', EXIT.USAGE)
    }

    try {
      return await withDaemon(async (client) => {
        const s: SessionState = offline ? { connected: false } : await ensureSession(client, o)
        /* 自匹配要加载资源（模板走 override_image，不写项目目录）；项目模式用规划出的资源 */
        let resourceDir = (typeof ctx.values['resource-dir'] === 'string' ? ctx.values['resource-dir'] : undefined)
          ?? s.plan?.resource?.paths[0]
        if (!resourceDir && offline && o.project) {
          /* 离线：项目只是资源的来源，不是连接的对象——只读 interface.json，不扫设备 */
          const off = offlineResource(o.project, o.controller, o.resource)
          if (off.error) {
            return fail('PLAN_FAILED', '离线解析项目资源失败：' + off.error,
              '也可以直接给 --resource-dir <dir>', EXIT.FINDINGS)
          }
          resourceDir = off.paths[0]
        }
        if (!resourceDir) {
          return fail('BAD_ARGUMENTS', '自匹配需要资源目录：给 --resource-dir <dir> 或 --project <dir>', undefined, EXIT.USAGE)
        }
        /* L0 是进程态：一次性命令先截一帧产生观测（截帧文件用完即删，不落用户 cwd、也不留在临时目录）。
         * 库帧路径不截帧——源已经固定，重截只会拿到另一个时刻。 */
        if (kfSource === undefined && seq === undefined) {
          await seedObservation(client, 'crop')
        }
        const r = await tplCrop(client, {
          ...(roi ? { roi } : {}),
          ...(point ? { point } : {}),
          ...(pad !== undefined ? { pad } : {}),
          ...(kfSource === undefined && seq !== undefined ? { seq } : {}),
          ...(kfSource ? { kfSource } : {}),
          ...(out ? { out } : {}),
          resourceDir,
          /* 跨帧验证缺省：热缓存路径交给 daemon 判（连接着就做）；库帧路径显式关，--cross 才做 */
          ...(kfSource !== undefined && !wantCross ? { cross: false } : (wantCross ? { cross: true } : {})),
          ...(ctx.values['no-cross'] === true ? { cross: false } : {}),
          ...(ctx.values['no-prov'] === true ? { prov: false } : {}),
          ...(typeof ctx.values['prov-out'] === 'string' && ctx.values['prov-out']
            ? { provOut: ctx.values['prov-out'] }
            : {}),
          ...(ctx.values['keep-source'] === true ? { keepSource: true } : {}),
        })
        if (r.ok === false) {
          return fail('TPL_CROP', String(r.error ?? '裁剪失败'),
            kfSource ? '库帧裁剪失败通常是文件被改动或库记录不一致；kf resolve 可复核' : '源帧取 L0 最新原图：先 screencap / stream / 输入产生观测',
            EXIT.FINDINGS)
        }
        const box = r.box as number[]
        const src = r.source as {
          kind?: string; id?: string; sha256?: string; ctrlW?: number; ctrlH?: number
          seq?: number; captureSeq?: number | null
        } | undefined
        const cross = r.cross as { seq?: number; score?: number; posOk?: boolean; box?: number[] } | undefined
        /* 贴合度信号：宽松框 → 最终框的几何对比（得分那一路分辨不出贴合度：三种窗口自匹配都是 1.0） */
        const tg = r.tighten as {
          from?: number[]; to?: number[]; areaRatio?: number | null; grew?: boolean
          looseMatch?: { score: number; positionOk: boolean }
        } | undefined
        const space = r.spaceCheck as { current?: { w: number; h: number } | null; match?: boolean | null } | undefined
        const srcLine = src && src.kind === 'kf'
          ? '源帧 ' + String(src.id) + '（留存帧，捕获 seq=' + String(src.captureSeq) + '，' +
            String(src.ctrlW) + 'x' + String(src.ctrlH) + '，sha ' + String(src.sha256).slice(0, 12) + '）'
          : '源帧 seq=' + String(r.seq) + '（' + String(r.ctrlW) + 'x' + String(r.ctrlH) + '，L0 热缓存）'
        const spaceLine = space && space.current
          ? '  空间核对：源 ' + String(r.ctrlW) + 'x' + String(r.ctrlH) + (space.match ? ' = ' : ' ≠ ') +
            '当前控制器 ' + space.current.w + 'x' + space.current.h
          : '  空间核对：未连接设备，未与当前控制器尺寸比对（模板空间 = 源帧捕获时尺寸 ' +
            String(r.ctrlW) + 'x' + String(r.ctrlH) + '）'
        const human = [
          ...describeSession(s),
          ...(offline ? ['离线裁剪：未连接设备（留存帧是本机持久文件，裁剪不需要设备）'] : []),
          '模板 ' + String(r.w) + 'x' + String(r.h) + ' → ' + String(r.path),
          '  ' + srcLine,
          '  宽松框 ' + JSON.stringify(r.loose) + ' → 收紧 ' + JSON.stringify(box) +
            (tg?.from && tg?.to
              ? '（' + tg.from.join('×') + ' → ' + tg.to.join('×') +
                (tg.areaRatio !== null && tg.areaRatio !== undefined ? '，面积 ' + tg.areaRatio + '×' : '') +
                (tg.grew ? '，反而放大' : '') + '）'
              : '') +
            (tg?.looseMatch
              ? '；宽松框自匹配 ' + tg.looseMatch.score + (tg.looseMatch.positionOk ? '（位置正确，说明得分分辨不出贴合度）' : '（位置漂移）')
              : '') +
            (r.snapped ? '' : '（snap 无内容收紧，用原框）'),
          '  自匹配 ' + (r.positionOk === false ? '位置错误（best 落在 ' + JSON.stringify(r.selfMatchBox ?? null) + '）' : '位置正确') +
            '，得分 ' + String(r.score) + '（' + String(r.tries) + ' 次评估）',
          ...(cross
            ? ['  跨帧验证 seq=' + String(cross.seq) + '：得分 ' + String(cross.score) +
              (cross.posOk ? '，位置正确' : '，位置漂移 ' + JSON.stringify(cross.box ?? null))]
            : [kfSource
                ? '  跨帧验证：跳过（源为留存帧，它对应的状态通常已不在当前画面上；状态可复现时给 --cross）'
                : (ctx.values['no-cross'] === true
                    ? '  跨帧验证：已按 --no-cross 关闭'
                    : '  跨帧验证：未做（未连接设备）')]),
          spaceLine,
          ...(r.provPath
            ? ['L2 出处：' + String(r.provPath) + '（来源 + 裁剪变换；随模板一起提交进仓库）']
            : ['L2 出处：未写（--no-prov）']),
          ...(r.keptSource && (r.keptSource as { id?: string }).id
            ? ['源帧已留档：' + String((r.keptSource as { id: string }).id) + '（出处随之升级为可复核的 kf: 身份）']
            : []),
          ...((r.warns as string[] | undefined) ?? []).map((w) => '  警告：' + w),
          'pipeline 用法：roi ' + box.join(',') + ' + template 该文件（同帧验证：maafw-live reco --node …）',
        ]
        const warns = (r.warns as string[] | undefined) ?? []
        return {
          exitCode: warns.length ? EXIT.FINDINGS : EXIT.OK,
          human,
          data: r,
          written: [String(r.path), ...(r.provPath ? [String(r.provPath)] : [])],
          ...(warns.length ? { warnings: warns } : {}),
        }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const CROP_COMMANDS: Command[] = [cropCommand]
