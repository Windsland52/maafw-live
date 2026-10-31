/**
 * 识别单测：maafw-live reco。
 *
 * 走 daemon 的 reco_test —— 它把识别放进一次性子进程执行（beta 绑定在无效模板上会原生崩溃，
 * 子进程炸掉只损失一次测试，不带走调用方）。支持阈值扫描：一次调用给出阈值-命中曲线。
 * 项目模式下资源目录从 interface.json 解析（整条链，含控制器 attach 段），避免手写路径与项目声明不一致。
 *
 * 节点来源三选一：`--node`（argv 手写）/ `--node-file`（文件，JSONC）/ `--node-name`（资源里按原名跑）。
 * 前两者测的是"你写的那份"，后者测的是"项目里那份"——真实定义还会叠加 overlay 资源包。
 */
import { basename } from 'node:path'
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { recoTest, withDaemon, type CropKfSource } from '../runtime/actions.js'
import { defaultFramesDir, resolveFrame, type KfRecord } from '../runtime/keyframes.js'
import { readNodeFile, readParamFile } from '../runtime/node-source.js'
import { ocrModelStatus } from '../runtime/ocr-model.js'
import { roiOutOfBounds } from '../runtime/reco-args.js'
import { describeMisses, type RecoResultLike } from '../runtime/reco-verdict.js'
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

/** 实际用的资源链（含 attach 段）：回执要能自证"在看哪一层"，单包运行时也一样 */
interface ResourceChain {
  paths: string[]
  name: string | null
  /** 链从哪来：项目声明 / 显式 --resource-dir */
  source: 'project' | 'resource-dir'
}

function resourceInfo(chain: ResourceChain): { name: string | null; paths: string[]; labels: string[]; source: string } {
  return {
    name: chain.name,
    paths: chain.paths,
    labels: chain.paths.map((p) => basename(p)),
    source: chain.source,
  }
}

function resourceLine(chain: ResourceChain): string {
  const labels = chain.paths.map((p) => basename(p))
  return '  资源链（layer=resource）：' + (chain.name ?? '(未命名)') + '  ' + labels.join(' + ')
}

/**
 * OCR 模型名：框架按 `model/ocr/<name>/` 找模型，缺省空串 = 直接放在 `model/ocr/` 下。
 * 优先级：资源 dump（V2 缺省也填满）> 手写节点的 V2 param / V1 顶层 model > `--type` 的 `--param`。
 */
export function ocrModelName(
  node: Record<string, unknown> | undefined,
  param: Record<string, unknown> | undefined,
  dump: { recognition?: { param?: { model?: unknown } } } | undefined,
): string | undefined {
  const fromDump = dump?.recognition?.param?.model
  if (typeof fromDump === 'string') return fromDump
  if (typeof param?.model === 'string') return param.model
  const rec = node?.recognition
  if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
    const m = (rec as { param?: { model?: unknown } }).param?.model
    if (typeof m === 'string') return m
  }
  if (typeof node?.model === 'string') return node.model
  return undefined
}

export const recoCommand: Command = {
  name: 'reco',
  summary: '识别单测（子进程隔离）：--param/--param-file/--sweep 阈值扫描，或 --node/--node-file 整节点透传、--node-name 按资源原名跑；--act 真机执行动作半',
  usage: `maafw-live reco --type TemplateMatch --resource-dir <dir> --image <png|kf:ID> [--param <json>|--param-file <json|->] [--sweep <json>]
       maafw-live reco --node <json> | --node-file <json|->  --resource-dir <dir> --image <png|kf:ID>   （V1 扁平 / V2 嵌套节点均原样透传）
       maafw-live reco --node <json> --resource-dir <dir> --from-kf <kf:库UUID:序号>   （库内留存帧：离线、不需要设备）
       maafw-live reco --project <dir> --node-name <节点名> --image <png>   （按资源里的原名跑，整条资源链含 attach）
       maafw-live reco --node-file <json> --act --project <dir>               （识别拿框 → 用框 run_action 真机执行）`,
  options: {
    ...CONNECT_OPTIONS,
    type: { type: 'string' },
    'resource-dir': { type: 'string' },
    image: { type: 'string' },
    seq: { type: 'string' },
    param: { type: 'string' },
    'param-file': { type: 'string' },
    sweep: { type: 'string' },
    node: { type: 'string' },
    'node-file': { type: 'string' },
    'node-name': { type: 'string' },
    act: { type: 'boolean' },
    'from-kf': { type: 'string' },
    'frames-dir': { type: 'string' },
  },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx.values)
    const str = (k: string): string | undefined =>
      typeof ctx.values[k] === 'string' && ctx.values[k] !== '' ? (ctx.values[k] as string) : undefined
    const type = str('type') ?? 'TemplateMatch'
    const imageRaw = str('image')
    /* `--image kf:…:0011` 是 SKILL / roadmap 里记过的写法：以 kf: 开头就按**库帧 ID**解释，
     * 而不是文件路径（否则一路走到 ENOENT，实测踩过）。规范入口仍是 --from-kf。 */
    const kfFromImage = imageRaw?.startsWith('kf:') === true ? imageRaw : undefined
    const image = kfFromImage ? undefined : imageRaw
    const seqRaw = str('seq')
    const seq = seqRaw !== undefined ? Number(seqRaw) : undefined
    const act = ctx.values.act === true

    /* ── 节点来源：三者互斥（测的是同一个位置，同时给只能有一个生效，那就不该"看起来都生效"） ── */
    const nodeJson = str('node')
    const nodeFile = str('node-file')
    const nodeName = str('node-name')
    const nodeFlags = [
      nodeJson !== undefined ? '--node' : '',
      nodeFile !== undefined ? '--node-file' : '',
      nodeName !== undefined ? '--node-name' : '',
    ].filter((x) => x !== '')
    if (nodeFlags.length > 1) {
      return fail('BAD_ARGUMENTS', '节点来源互斥：' + nodeFlags.join(' / ') + ' 只能给一个',
        '--node 手写节点 JSON；--node-file 从文件读一个节点；--node-name 按资源里的原名跑', EXIT.USAGE)
    }
    let node: Record<string, unknown> | undefined
    if (nodeJson !== undefined) {
      const parsed = parseJson<Record<string, unknown>>(nodeJson, '--node')
      if (parsed.error) return fail('BAD_ARGUMENTS', parsed.error, undefined, EXIT.USAGE)
      if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
        return fail('BAD_ARGUMENTS', '--node 必须是 JSON 对象（pipeline 节点）', undefined, EXIT.USAGE)
      }
      node = parsed.value
    } else if (nodeFile !== undefined) {
      const f = readNodeFile(nodeFile)
      if (f.error) return fail('BAD_ARGUMENTS', f.error, f.hint, EXIT.USAGE)
      node = f.node
    }
    const nodeSource = nodeJson !== undefined ? 'node' : (nodeFile !== undefined ? 'node-file' : (nodeName !== undefined ? 'node-name' : null))

    /* ── 参数来源：--param / --param-file 互斥；它们与 --sweep 都只作用于 --type 路径 ── */
    const paramSpec = str('param')
    const paramFile = str('param-file')
    if (paramSpec !== undefined && paramFile !== undefined) {
      return fail('BAD_ARGUMENTS', '--param 与 --param-file 互斥：一个给字面 JSON，一个给文件', undefined, EXIT.USAGE)
    }
    let param: { value?: Record<string, unknown>; error?: string }
    if (paramFile !== undefined) {
      const f = readParamFile(paramFile)
      if (f.error) return fail('BAD_ARGUMENTS', f.error, undefined, EXIT.USAGE)
      param = { value: f.param }
    } else {
      param = parseJson<Record<string, unknown>>(paramSpec, '--param')
    }
    if (param.error) return fail('BAD_ARGUMENTS', param.error, undefined, EXIT.USAGE)
    const sweep = parseJson<Record<string, unknown>>(str('sweep'), '--sweep')
    if (sweep.error) return fail('BAD_ARGUMENTS', sweep.error, undefined, EXIT.USAGE)

    /* 节点自带的参数就是它的定义；再给 --param 是被静默忽略的（回执看不出用了哪套）。这里直接拦下：
     * 想扫阈值，先用 --node-file 把它摘成 --type 形态，或者干脆别给节点来源。 */
    if (nodeSource !== null && (paramSpec !== undefined || paramFile !== undefined || sweep.value !== undefined)) {
      return fail('BAD_ARGUMENTS',
        '--param / --param-file / --sweep 只作用于 --type 路径：与 ' + (nodeName !== undefined ? '--node-name' : '--node/--node-file') + ' 同给时它们不会生效',
        '节点来源测的是节点自带参数（含资源覆盖后的值）；要扫阈值就把节点摘成 --type 形态', EXIT.USAGE)
    }
    const paramSource = nodeSource ?? (paramFile !== undefined ? 'param-file' : (sweep.value !== undefined ? 'sweep' : (paramSpec !== undefined ? 'param' : 'type')))

    /* ── 库帧来源（离线，镜像 crop / annotate 的 --from-kf）：先走离线读侧解析，daemon 只接身份与路径 ── */
    const fromKf = str('from-kf') ?? kfFromImage
    if (fromKf !== undefined && seq !== undefined) {
      return fail('BAD_ARGUMENTS', '--from-kf 与 --seq 互斥：前者在库内留存帧上跑，后者在本会话缓冲帧上跑',
        '取库里有哪些帧：maafw-live kf list', EXIT.USAGE)
    }
    let kfSource: CropKfSource | undefined
    if (fromKf !== undefined) {
      const dir = str('frames-dir') ?? defaultFramesDir()
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
    /* 给了静态图就是离线评估：识别输入与设备无关，没必要为它连一次设备会话
     * （旧行为是 `--project --image` 会 ensureSession，而同一份回执又把它标成"离线评估"——
     * 工具自身的口径分叉）。--seq 是本会话缓冲帧，仍要有会话。 */
    const offline = kfSource !== undefined || image !== undefined
    if (act && offline) {
      return fail('BAD_ARGUMENTS', '--act 要在真机上执行动作、图像取自当前画面：不能与 --image / --from-kf 同用',
        '离线只做识别判据；要连真机就把 --image 换成 --project 跑 --act', EXIT.USAGE)
    }
    if (act) {
      if (nodeName !== undefined) {
        return fail('BAD_ARGUMENTS', '--act 只接受 --node / --node-file：--node-name 按资源原名跑识别，动作半不桥接',
          '识别判据用 --node-name 验；动作半用 maafw-live run 验（它才会桥接 agent 子进程）', EXIT.USAGE)
      }
      if (!node) {
        return fail('BAD_ARGUMENTS', '--act 需要同时给 --node / --node-file <json>（整节点，含 action）', undefined, EXIT.USAGE)
      }
      if (node.action === undefined) {
        return fail('BAD_ARGUMENTS', '--act 要求节点带 action（V1 action 字符串 / V2 action 对象）', '只测识别就去掉 --act', EXIT.USAGE)
      }
    }

    try {
      return await withDaemon(async (client) => {
        const s: SessionState = offline ? { connected: false } : await ensureSession(client, o)
        /* 资源链：--resource-dir 是显式单包；否则按项目声明解析**整条链**（resource.path[] 叠加
         * 控制器 attach_resource_path）。必须走 resolveResourcePaths —— 只写 resource.path 会让
         * attach 进来的一段凭空消失，测出来的节点就不是 run 里那个。 */
        const dirFlag = str('resource-dir')
        let chain: ResourceChain
        if (dirFlag !== undefined) {
          chain = { paths: [dirFlag], name: '(--resource-dir)', source: 'resource-dir' }
        } else if (s.plan?.resource?.paths.length) {
          chain = { paths: s.plan.resource.paths, name: s.plan.resource.selected, source: 'project' }
        } else if (o.project) {
          /* 离线：项目只作资源来源（模板与 OCR 模型），不扫设备不连接 */
          const off = offlineResource(o.project, o.controller, o.resource)
          if (off.error) {
            return fail('PLAN_FAILED', '解析项目资源失败：' + off.error, '也可以直接给 --resource-dir <dir>', EXIT.FINDINGS)
          }
          chain = { paths: off.paths, name: off.selected, source: 'project' }
        } else {
          chain = { paths: [], name: null, source: 'project' }
        }
        if (!chain.paths.length) {
          return fail('BAD_ARGUMENTS', '缺少资源目录：给 --resource-dir <dir>，或用 --project <dir> 让 interface.json 决定',
            nodeName !== undefined ? '--node-name 按资源里的原名跑，没有资源就没有节点可查' : undefined, EXIT.USAGE)
        }
        /* 单包沿用旧字段名 resourceDir（daemon 两种写法都收：单段还是整链）；整链才送 resourceDirs */
        const resources = chain.paths.length > 1 ? { resourceDirs: chain.paths } : { resourceDir: chain.paths[0] }

        if (act) {
          /* --act：识别拿框 → 真机 run_action。图像来自当前画面（daemon 抓帧），不吃 --image/--seq */
          if (!o.project && !o.kind) {
            return fail('BAD_ARGUMENTS', '--act 要真机执行动作：给 --project <dir> 或 --kind 连接设备',
              '多步操作用 maafw-live repl', EXIT.USAGE)
          }
          const r = await recoTest(client, { ...resources, act: true, node })
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
              resourceLine(chain),
              '节点单测（识别→动作，真机执行）：',
              '  识别框 ' + JSON.stringify(reco?.box ?? null),
              '  动作回执 ' + JSON.stringify(r.action ?? null),
              '  边界帧 seq ' + String(retention?.before?.seq) + ' → ' + String(retention?.after?.seq) +
                '（frame_get / kf promote 可复核动作效果）',
            ],
            data: { ...r, resource: resourceInfo(chain), layer: 'resource', paramSource },
          }
        }

        if (!image && seq === undefined && !offline) {
          return fail('BAD_ARGUMENTS', '缺少图像：一次性命令给 --image <png>；用缓冲帧（--seq）需要在 maafw-live repl 里先 stream start',
            '库里留存帧用 --from-kf <kf:…>（离线、不需要设备）', EXIT.USAGE)
        }
        const r = await recoTest(client, {
          ...resources,
          type,
          ...(nodeName !== undefined ? { nodeName } : {}),
          ...(image ? { image } : {}),
          ...(seq !== undefined ? { seq } : {}),
          ...(kfSource ? { kfSource } : {}),
          ...(node ? { node } : {}),
          ...(nodeSource === null && param.value ? { param: param.value } : {}),
          ...(nodeSource === null && sweep.value ? { sweep: sweep.value } : {}),
        })
        const results = (r.results as Array<{ param: Record<string, unknown>; ms: number; ok: boolean; detail?: unknown }> | undefined) ?? []
        const shownType = String(r.type ?? type)

        /* ── 能力边界与"查无此节点"要报成明确结论，不能落进"看起来像 miss" ── */
        const code = String(r.code ?? '')
        if (r.ok === false && (code === 'CUSTOM_NODE' || code === 'NODE_MISSING')) {
          const candidates = Array.isArray(r.candidates) ? (r.candidates as unknown[]).map(String) : []
          const hint = code === 'CUSTOM_NODE'
            ? 'custom/agent 识别要桥接 agent 子进程：用 maafw-live run --project 跑；reco 只测资源合并后的普通节点'
            : candidates.length
              /* 拼错一个字时，正确名字就在资源里——不给近邻等于让人对着资源目录逐个比对 */
              ? '资源里最接近的节点名：' + candidates.join(' / ') + '（按资源合并后的原名跑；单包时 overlay 段的节点不在）'
              : '确认资源名与链（--resource）是否正确；手写节点用 --node-file'
          return {
            exitCode: EXIT.FINDINGS,
            human: [
              ...describeSession(s), resourceLine(chain),
              ...(nodeName !== undefined ? ['  节点来源：--node-name ' + nodeName] : []),
              ...(candidates.length ? ['  资源里最接近的节点名：' + candidates.join(' / ')] : []),
            ],
            error: {
              code: code === 'CUSTOM_NODE' ? 'RECO_CUSTOM_NODE' : 'RECO_NODE_MISSING',
              message: String(r.error),
              hint,
            },
            data: { ...r, resource: resourceInfo(chain), layer: 'resource', paramSource },
          }
        }

        const th = suggestThreshold(results)
        /* roi 越界 = 参数用错空间（repl 侧同一判据，见 runtime/reco-args）。
         * 只有 daemon 回执带 w/h 时才判得动：`--image`（0.3.0 起补 w/h）与 kfSource 都有，
         * 缓冲帧的 meta.seq 分支本来就有；判不动就如实不判，不猜。 */
        const meta = r.meta as { w?: unknown; h?: unknown } | undefined
        const oob = roiOutOfBounds(node || nodeName !== undefined ? undefined : (param.value?.roi as number[] | undefined), meta?.w, meta?.h)
        if (oob) {
          return fail('ROI_OUT_OF_BOUNDS', oob,
            '把 roi 按所用图的尺寸给：--image 是控制器空间原图，缓冲帧是 L1 小图（差一个 scale）',
            EXIT.FINDINGS)
        }
        /* 离线评估（静态图 / 库帧）标记：防"拿旧截图出分冒充实测"（本仓 G21 同族事故）。
         * 分数可用于调参与回归，不构成真机验收证据；验收判据只认真机 run 的 record.ok。
         * `--seq` 是本会话帧流的缓冲帧，不在此列。 */
        const offlineEvidence = image !== undefined || kfSource !== undefined
        const nodeDump = r.nodeDump as {
          recognition?: { type?: unknown; param?: { model?: unknown } }
          action?: { type?: unknown }
        } | undefined
        /* OCR 的"空结果"与"模型没加载"同形：先看链上有没有模型，再谈 roi（判据见 runtime/ocr-model） */
        const ocrModel = shownType === 'OCR'
          ? ocrModelStatus(chain.paths, ocrModelName(node, param.value, nodeDump))
          : undefined
        const verdict = describeMisses(results as RecoResultLike[], shownType,
          th ? { bestScore: th.bestScore, lowMatch: th.lowMatch } : null,
          ocrModel ? { ocrModel } : {})
        const anyHit = results.some((x) => x.ok === true)
        /* 只有会带 0..1 置信度的算法才有"无置信度"这回事：OCR / ColorMatch 本来就没有分数，
         * 把它们标成"无置信度"正是这条判据要避免的误导。 */
        const scoringType = shownType === 'TemplateMatch'
        const human = [
          ...describeSession(s),
          resourceLine(chain),
          ...(nodeName !== undefined
            ? [
                '  节点来源：--node-name ' + nodeName + '（按资源里的原名跑；dump 只进回执，不参与识别）',
                ...(nodeDump
                  ? ['  节点定义：recognition=' + String(nodeDump.recognition?.type ?? '?') +
                      '  action=' + String(nodeDump.action?.type ?? '?')]
                  : []),
                '  layer=resource：这里只到资源合并结果；run --project 还会再叠 interface 的四级 pipeline_override' +
                  '（GUI 选项改过同一字段时两者对不上是预期行为）',
              ]
            : []),
          '识别 ' + shownType + '：' + results.length + ' 例' +
            (node ? '（整节点透传）' : nodeName !== undefined ? '（资源原名）' : ''),
          ...(offlineEvidence
            ? ['  ⚠ 离线评估（' + (kfSource ? '库帧 --from-kf' : '静态图 --image') +
                '）：分数可用于调参/回归，不构成真机验收证据——验收只认真机 run 的 record.ok']
            : []),
          ...results.map((x, i) => {
            const d = verdict.perResult[i]
            /* 计数逐例如实给：`all` 是框架的原始候选，`filtered` 是 expected 过滤后的那层
             * （模板匹配没有 filtered，只有 all） */
            const counts: string[] = []
            if (d?.rawCount !== null && d?.rawCount !== undefined) counts.push('all=' + d.rawCount)
            if (d?.filteredCount !== null && d?.filteredCount !== undefined) counts.push('filtered=' + d.filteredCount)
            const mark = x.ok ? '[命中]' : (d?.failed ? '[报错]' : '[未中]')
            return '  ' + mark + ' ' + JSON.stringify(x.param) + '  ' + x.ms + 'ms' +
              (counts.length ? '  ' + counts.join(' ') : '') + (d?.missReason ? '  ← ' + d.missReason : '')
          }),
        ]
        /* 单例时逐例行已经写了原因，不再重复；多例（扫描）才给一条汇总 */
        if (verdict.missReason && results.length > 1) human.push('  未命中原因：' + verdict.missReason)
        else if (verdict.missReasons.length > 1) human.push('  未命中原因：' + verdict.missReasons.join(' / '))
        /* 调用报错与未命中必须分开读：前者是"没跑成"，先看原生消息；两者都算 FINDINGS（见下方退出码） */
        const failedCount = verdict.perResult.filter((d) => d.failed).length
        if (failedCount > 0) {
          human.push('  识别调用报错 ' + failedCount + ' 例（上面标 [报错]）：这不是未命中，先处理原生消息，' +
            '别去调阈值/改 roi')
        }
        if (th && th.suggest !== null) {
          human.push('  实测最高置信度 ' + th.bestScore + ' → threshold 起点建议 ' + th.suggest +
            '（实测 − 0.1 留余量，换场景会掉；ROI 收紧可再提）')
        } else if (th && th.lowMatch) {
          human.push('  实测最高置信度 ' + th.bestScore + '：模板与该画面不匹配——threshold 建议不适用，' +
            '先核对模板来源画面与当前画面（识别未命中不是调低阈值的理由）')
        } else if (results.length > 0 && !anyHit && scoringType) {
          /* 第三形态：识别跑了，但一个置信度都没带回来（实测：模板文件读不到时就是这个签名——
           * ~230ms、`[未中]`、detail.best 空、all 为空）。它和"分数低的未命中"必须分得开：
           * 后者是画面不匹配（有分数），前者是**输入当时读不到**，处置方向完全不同。
           * 判据必须先看有没有命中：OCR 命中时也没有数值分，旧判据会把命中标成"无置信度"。 */
          human.push('  识别未返回任何置信度（' + results.length + ' 例）：这与"分数低的未命中"不同。'
            + '先看 **roi 是否越出所用图的尺寸**（越界会先被上面的校验拦下；没拦下说明尺寸判不动）——'
            + 'ctrl 坐标的 roi 打在 L1 小图上就是这个签名，实测踩过。再看模板/资源当时是否读得到'
            + '（资源包未加载、模板文件缺失或不可读、临时文件正被杀软扫描）。'
            + '先核对 --resource-dir 与模板是否存在，再重跑一次看是否复现；别当成"画面不匹配"去调阈值')
        }
        if (r.ok === false) human.push('error: ' + String(r.error))
        /* 机器侧也要能一眼认出第三形态（阈值建议缺席 ≠ 没跑）：命中与否优先于"有没有分数" */
        const noConfidence = scoringType && th === null && results.length > 0 && !anyHit
        const enriched = results.map((x, i) => {
          const d = verdict.perResult[i]
          return {
            ...x,
            ...(d?.missReason ? { missReason: d.missReason } : {}),
            ...(d?.rawCount !== null && d?.rawCount !== undefined ? { rawCount: d.rawCount } : {}),
            ...(d?.filteredCount !== null && d?.filteredCount !== undefined ? { filteredCount: d.filteredCount } : {}),
            /* 机器侧要能区分"没跑成"与"未命中"：miss 也会带 missReason，`failed` 只给调用报错 */
            ...(d?.failed ? { failed: true } : {}),
          }
        })
        /* 退出码对齐文档契约（README 的码表、protocol.ts 的 FINDINGS 注释都写着"reco 未命中 → 3"）：
         * 未命中与调用报错都算"跑成了但发现了问题"；全部命中才是 0。 */
        const anyMiss = results.length > 0 && results.some((x) => x.ok !== true)
        return {
          exitCode: r.ok === false || anyMiss ? EXIT.FINDINGS : EXIT.OK,
          human,
          data: {
            ...r,
            results: enriched,
            resource: resourceInfo(chain),
            layer: 'resource',
            paramSource,
            ...(th ? { thresholdSuggestion: th } : {}),
            ...(noConfidence ? { noConfidence: true } : {}),
            ...(verdict.missReason ? { missReason: verdict.missReason } : {}),
            ...(verdict.missReasons.length > 1 ? { missReasons: verdict.missReasons } : {}),
            ...(verdict.rawCount !== null ? { rawCount: verdict.rawCount } : {}),
            ...(verdict.filteredCount !== null ? { filteredCount: verdict.filteredCount } : {}),
            ...(offlineEvidence ? { offlineEvidence: true } : {}),
          },
        }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const RECO_COMMANDS: Command[] = [recoCommand]
