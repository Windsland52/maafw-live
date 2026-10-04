/**
 * 设备与运行时的命令面：probe / device / connect / disconnect / screencap / frame / run / stop。
 *
 * 这一层只做三件事：解析选项、调 runtime/actions、把它翻译成 CLI 信封。任何领域规则
 * （控制器规划、资源解析、时间线）都不许写在这里——REPL 与其它壳（编辑器插件、面板）调的是同一批动作函数。
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultRunDir } from '../client/daemon.js'
import { computePipelineOverride } from '../interface/index.js'
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import * as act from '../runtime/actions.js'
import { withDaemon } from '../runtime/actions.js'
import { describeSession, ensureSession, SessionError, type SessionOptions } from '../runtime/session.js'

/** 连接类选项：凡是要设备的命令都接受同一组，保证"怎么连"只有一套说法。 */
export const CONNECT_OPTIONS = {
  project: { type: 'string' as const },
  controller: { type: 'string' as const },
  resource: { type: 'string' as const },
  hwnd: { type: 'string' as const },
  address: { type: 'string' as const },
  kind: { type: 'string' as const },
  target: { type: 'string' as const },
  'short-side': { type: 'string' as const },
  'long-side': { type: 'string' as const },
  raw: { type: 'boolean' as const },
}

export function sessionOptions(values: Record<string, unknown>): SessionOptions {
  const num = (k: string): number | undefined => {
    const v = values[k]
    return typeof v === 'string' && v !== '' ? Number(v) : undefined
  }
  const str = (k: string): string | undefined => (typeof values[k] === 'string' ? (values[k] as string) : undefined)
  return {
    project: str('project'),
    controller: str('controller'),
    resource: str('resource'),
    hwnd: str('hwnd'),
    address: str('address'),
    kind: str('kind'),
    target: str('target'),
    shortSide: num('short-side'),
    longSide: num('long-side'),
    rawSize: values.raw === true,
  }
}

/** daemon 抛出的错误一律翻译成结构化失败，不让堆栈进模型上下文。 */
export function daemonFail(e: unknown, hint?: string): CommandResult {
  if (e instanceof SessionError) return fail(e.code, e.message, hint, EXIT.ENV)
  const msg = e instanceof Error ? e.message : String(e)
  return fail('DAEMON_ERROR', msg, hint ?? '用 maafw-live probe 检查运行时；连接类错误先 maafw-live device 看有没有设备', EXIT.ENV)
}

export const probeCommand: Command = {
  name: 'probe',
  summary: '自检 maa-node 运行时：绑定版本、adb/win32 设备发现数',
  usage: 'maafw-live probe',

  async run(): Promise<CommandResult> {
    try {
      return await withDaemon(async (client) => {
        const info = await act.probe(client)
        const devices = await act.deviceList(client, 'all').catch(() => [])
        const human = [
          'maa-node    ' + String(info.version ?? '(未知)'),
          'adb 设备    ' + String(info.adb ?? '?'),
          'win32 窗口  ' + String(info.win32 ?? '?'),
          '可用于连接的设备 ' + devices.length + ' 个',
        ]
        for (const err of (info.errors as string[] | undefined) ?? []) human.push('  error: ' + err)
        return { exitCode: EXIT.OK, human, data: { ...info, devices: devices.length } }
      })
    } catch (e) {
      return daemonFail(e, '探针失败通常意味着 @maaxyz/maa-node 未安装或原生包与平台不匹配')
    }
  },
}

export const deviceCommand: Command = {
  name: 'device',
  summary: '列出可连接的设备：adb 设备与 win32 窗口',
  usage: 'maafw-live device [--kind all|adb|win32]',
  options: { kind: { type: 'string' } },

  async run(ctx): Promise<CommandResult> {
    const kind = (typeof ctx.values.kind === 'string' ? ctx.values.kind : 'all') as 'all' | 'adb' | 'win32'
    if (!['all', 'adb', 'win32'].includes(kind)) {
      return fail('BAD_ARGUMENTS', 'kind 只能是 all / adb / win32', undefined, EXIT.USAGE)
    }
    try {
      return await withDaemon(async (client) => {
        const list = await act.deviceList(client, kind)
        type Row = { kind?: string; id?: string; name?: string; cls?: string }
        const human = list.length
          ? list.map((d) => {
              const r = d as unknown as Row
              return '  ' + String(r.kind) + '  ' + String(r.id) + '  ' + String(r.name ?? '') +
                (r.cls ? ' [' + r.cls + ']' : '')
            })
          : ['（未发现设备）']
        return {
          exitCode: list.length ? EXIT.OK : EXIT.FINDINGS,
          human: ['设备 ' + list.length + ' 个：', ...human],
          data: { count: list.length, devices: list },
          ...(list.length ? {} : { suggestedCommands: ['maafw-live device'] }),
        }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const connectCommand: Command = {
  name: 'connect',
  summary: '连接设备（进程态：命令退出即断开；多步操作用 maafw-live repl）',
  usage: 'maafw-live connect --project <dir> | --kind win32|adb|gamepad [--target ...]',
  options: { ...CONNECT_OPTIONS },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx.values)
    if (!o.project && !o.kind) {
      return fail('BAD_ARGUMENTS', '要么给 --project <dir>（按 interface.json 规划），要么给 --kind',
        '推荐 --project：控制器类型/窗口正则/输入方法/识别缩放全跟项目走', EXIT.USAGE)
    }
    try {
      return await withDaemon(async (client) => {
        const s = await ensureSession(client, o)
        const lines = describeSession(s)
        lines.push('', '注意：连接是进程态，本命令退出即断开。多步操作请用 maafw-live repl（连接一次、命令复用）。')
        return {
          exitCode: EXIT.OK,
          human: lines,
          data: {
            session: s.session ?? null,
            controller: s.plan?.controllerName ?? null,
            resourcePaths: s.plan?.resource?.paths ?? null,
          },
        }
      })
    } catch (e) {
      return daemonFail(e, '没有匹配的窗口/设备时：先 maafw-live device 看目标是否存在，或用 --hwnd 显式指定')
    }
  },
}

export const disconnectCommand: Command = {
  name: 'disconnect',
  summary: '断开设备并销毁 Tasker/Controller（一次性命令，等价于结束 REPL 会话）',
  usage: 'maafw-live disconnect --project <dir> | --kind ...',
  options: { ...CONNECT_OPTIONS },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx.values)
    if (!o.project && !o.kind) {
      return fail('BAD_ARGUMENTS', '需要 --project 或 --kind 才能建立会话再断开', undefined, EXIT.USAGE)
    }
    try {
      return await withDaemon(async (client) => {
        await ensureSession(client, o)
        const r = await act.disconnect(client)
        return { exitCode: EXIT.OK, human: ['已断开：' + JSON.stringify(r)], data: r }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const screencapCommand: Command = {
  name: 'screencap',
  summary: '截一帧图并落盘（需要连接：给 --project 或 --kind）',
  usage: 'maafw-live screencap [--project <dir>|--kind ...] [--out <png>]',
  options: { ...CONNECT_OPTIONS, out: { type: 'string' } },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx.values)
    const out = typeof ctx.values.out === 'string'
      ? ctx.values.out
      : join(defaultRunDir(), 'png', 'shot_' + Date.now() + '.png')
    try {
      mkdirSync(dirname(out), { recursive: true })
    } catch { /* 落盘失败交给 daemon 报错 */ }
    try {
      return await withDaemon(async (client) => {
        const s = await ensureSession(client, o)
        const r = await act.screencap(client, out)
        return {
          exitCode: r.ok === false ? EXIT.FAIL : EXIT.OK,
          human: [...describeSession(s), '截图：' + String(r.path ?? out) + (r.bytes ? ' (' + r.bytes + ' bytes)' : '')],
          data: r,
          written: r.path ? [String(r.path)] : [out],
        }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const frameCommand: Command = {
  name: 'frame',
  summary: '帧流状态与历史帧取用（环形缓冲只在 REPL 会话里才有内容）',
  usage: 'maafw-live frame status | maafw-live frame get [seq] [--roi x,y,w,h] [--out <png>]',
  options: { ...CONNECT_OPTIONS, roi: { type: 'string' }, out: { type: 'string' } },

  async run(ctx): Promise<CommandResult> {
    const sub = ctx.positionals[0] ?? 'status'
    const o = sessionOptions(ctx.values)
    if (sub === 'status') {
      try {
        return await withDaemon(async (client) => {
          const s = await ensureSession(client, o)
          const st = await act.streamStatus(client)
          return { exitCode: EXIT.OK, human: [...describeSession(s), '帧流：' + JSON.stringify(st)], data: st }
        })
      } catch (e) {
        return daemonFail(e)
      }
    }
    if (sub !== 'get') {
      return fail('BAD_ARGUMENTS', '用法：maafw-live frame status | maafw-live frame get [seq]', undefined, EXIT.USAGE)
    }

    const rawSeq = ctx.positionals[1]
    const seq = rawSeq !== undefined ? Number(rawSeq) : undefined
    if (rawSeq !== undefined && !Number.isFinite(seq)) {
      return fail('BAD_ARGUMENTS', 'seq 必须是数字', undefined, EXIT.USAGE)
    }
    const roi = typeof ctx.values.roi === 'string'
      ? ctx.values.roi.split(',').map((x) => Number(String(x).trim()))
      : undefined
    if (roi && (roi.length !== 4 || roi.some((n) => !Number.isFinite(n)))) {
      return fail('BAD_ARGUMENTS', '--roi 需要 4 个数字：x,y,w,h（控制器分辨率坐标，与 pipeline 的 roi 同空间）', undefined, EXIT.USAGE)
    }
    const out = typeof ctx.values.out === 'string' ? ctx.values.out : undefined
    try {
      return await withDaemon(async (client) => {
        await ensureSession(client, o)
        const r = await act.frameGet(client, { seq, roi, out })
        if (r.ok === false) {
          return fail('NO_FRAME', String(r.error ?? '取帧失败'),
            '帧流要先在 REPL 里 stream start；一次性命令的环形缓冲是空的', EXIT.FINDINGS)
        }
        return {
          exitCode: EXIT.OK,
          human: ['帧 ' + String(r.seq) + ' → ' + String(r.path) + ' (' + r.w + 'x' + r.h + ')'],
          data: r,
          written: [String(r.path)],
        }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const runCommand: Command = {
  name: 'run',
  summary: '运行 pipeline：项目模式（推荐）或 resource 目录模式；节点事件按帧序对齐。退出码按任务级 record.ok',
  usage: 'maafw-live run --entry <task> --project <dir> | --resource-dir <dir> [--timeout <ms|0>] [--override <json>] [--preset <name>] [--resource <名|路径>]\n' +
    '       --timeout 0 = 不自动停止（停止权交调用方：事件流判断 + maafw-live stop / 客户端 run_stop）；>0 时超时自动 post_stop\n' +
    '       项目模式自动合成 pipeline_override（global→resource→controller→task，preset/default 取值），--override 最后覆盖',
  options: {
    ...CONNECT_OPTIONS,
    entry: { type: 'string' },
    'resource-dir': { type: 'string' },
    timeout: { type: 'string' },
    override: { type: 'string' },
    preset: { type: 'string' },
  },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx.values)
    const entry = (typeof ctx.values.entry === 'string' ? ctx.values.entry : ctx.positionals[0]) ?? undefined
    const resourceDir = typeof ctx.values['resource-dir'] === 'string' ? ctx.values['resource-dir'] : undefined
    if (!entry) {
      return fail('BAD_ARGUMENTS', '缺少入口任务名：--entry <task>',
        '项目模式=interface.json 的 task 名；bundle 模式=pipeline 首节点名', EXIT.USAGE)
    }
    if (!o.project && !resourceDir) {
      return fail('BAD_ARGUMENTS', '要么给 --project <dir>，要么给 --resource-dir <dir>', undefined, EXIT.USAGE)
    }

    let override: Record<string, unknown> = {}
    if (typeof ctx.values.override === 'string') {
      try {
        override = JSON.parse(ctx.values.override) as Record<string, unknown>
      } catch (e) {
        return fail('BAD_ARGUMENTS', '--override 不是合法 JSON：' + String((e as Error).message), undefined, EXIT.USAGE)
      }
    }
    const timeoutMs = typeof ctx.values.timeout === 'string' ? Number(ctx.values.timeout) : 30000
    if (!Number.isFinite(timeoutMs)) {
      return fail('BAD_ARGUMENTS', '--timeout 必须是毫秒数', undefined, EXIT.USAGE)
    }

    try {
      return await withDaemon(async (client) => {
        const s = await ensureSession(client, o)
        let args: Record<string, unknown>
        let resolvedEntry: string = entry
        let chain: ReturnType<typeof computePipelineOverride> | null = null
        let extraWarns: string[] = []
        let appliedLines: string[] = []
        if (o.project) {
          const paths = s.plan?.resource?.paths ?? []
          if (!paths.length) {
            return fail('RESOURCE_NOT_FOUND', '项目里没有解析出资源路径：检查 interface.json 的 resource[] 声明', undefined, EXIT.FINDINGS)
          }
          const task = s.plan?.loaded.tasks.find((t) => t.name === entry || t.entry === entry)
          resolvedEntry = task?.entry ?? entry
          /* task 适用性（task.controller / task.resource 声明） */
          const ctrlName = s.plan?.controllerName ?? null
          const resName = s.plan?.resource?.selected ?? null
          if (task?.controller?.length && ctrlName && !task.controller.includes(ctrlName)) {
            return fail('TASK_NOT_APPLICABLE',
              '任务 ' + task.name + ' 不支持当前控制器 ' + ctrlName + '（声明：' + task.controller.join(' / ') + '）',
              '换 --controller ' + task.controller[0] + '，或选别的任务', EXIT.FINDINGS)
          }
          if (task?.resource?.length && resName && !task.resource.includes(resName)) {
            extraWarns.push('任务 ' + task.name + ' 声明资源 ' + task.resource.join(' / ') + '，当前选中的是 ' + resName)
          }
          /* pipeline_override 四级合并链（preset > default_case 取值） + 用户 --override 最后覆盖 */
          chain = computePipelineOverride({
            loaded: s.plan!.loaded,
            controllerName: ctrlName,
            resourceName: resName,
            taskName: task?.name ?? null,
            presetName: typeof ctx.values.preset === 'string' ? ctx.values.preset : null,
          })
          extraWarns = [...extraWarns, ...chain.warns]
          appliedLines = chain.applied
          const pt = s.plan!.loaded.pretask
          if (pt.length) {
            extraWarns.push('项目声明了 ' + pt.length + ' 条 pretask（' + pt.map((p) => p.exec ?? p.name ?? '?').join(' , ') + '），本 CLI 不执行——需自行保证前置条件')
          }
          args = { resourceDirs: paths, entry: resolvedEntry, override: { ...chain.override }, timeoutMs }
        } else {
          args = { resourceDir, entry, override, timeoutMs }
        }
        if (o.project && chain) {
          /* 用户 --override 最后覆盖合成结果（同节点字段替换） */
          const merged = args.override as Record<string, unknown>
          for (const [node, fields] of Object.entries(override)) {
            if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
              merged[node] = {
                ...((merged[node] as Record<string, unknown>) ?? {}),
                ...(fields as Record<string, unknown>),
              }
            } else {
              merged[node] = fields
            }
          }
        }
        const r = await act.run(client, args, timeoutMs)
        if (r.ok === false || !r.record) {
          /* 调用级失败：任务根本没跑起来（未连接 / 资源缺失 / 已有任务在跑）→ FINDINGS */
          return {
            exitCode: EXIT.FINDINGS,
            human: [...describeSession(s), '调用失败：' + String(r.error ?? 'run 未返回记录')],
            data: r,
            warnings: [...extraWarns, ...((r.warns as string[] | undefined) ?? [])],
          }
        }
        /* 任务级结果以 record.ok 为准（daemon 外层 ok 只代表调用完成）。
         * 任务失败退出 FAIL——不能吞成 0，也不占用 FINDINGS（那是调用级失败的语义）。 */
        const rec = r.record as {
          ok?: boolean
          status?: unknown
          stopped?: boolean
          durationMs?: number
          nodes?: Array<{ name: string; status: string; ms: number }>
          startSeq?: number | null
          endSeq?: number
          framesCaptured?: number
        }
        const taskOk = rec.ok === true
        const nodes = rec.nodes ?? []
        const human = [
          ...describeSession(s),
          '任务 ' + resolvedEntry + '：' + (taskOk ? '完成' : (rec.stopped ? '超时被停止（视为失败）' : '失败')) +
            '（status=' + String(rec.status) + '，' + String(rec.durationMs) + 'ms，帧序 ' +
            String(rec.startSeq) + '..' + String(rec.endSeq) + '）',
          ...appliedLines.map((l) => '  override: ' + l),
          ...nodes.map((n) => '  [' + n.status + '] ' + n.name + '  ' + n.ms + 'ms'),
        ]
        if (!taskOk) {
          human.push('', 'daemon 原生日志尾部：', ...client.logTail(20).map((l) => '  ' + l))
        }
        return {
          exitCode: taskOk ? EXIT.OK : EXIT.FAIL,
          human,
          data: r,
          warnings: [...extraWarns, ...((r.warns as string[] | undefined) ?? [])],
        }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const stopCommand: Command = {
  name: 'stop',
  summary: '停止运行中的任务（post_stop）',
  usage: 'maafw-live stop',

  async run(): Promise<CommandResult> {
    try {
      return await withDaemon(async (client) => {
        const r = await act.runStop(client)
        return { exitCode: EXIT.OK, human: ['已请求停止：' + JSON.stringify(r)], data: r }
      })
    } catch (e) {
      return daemonFail(e, '一次性进程里通常没有正在运行的任务；该命令主要用于 REPL 会话内中断')
    }
  },
}

export const RUNTIME_COMMANDS: Command[] = [
  probeCommand, deviceCommand, connectCommand, disconnectCommand,
  screencapCommand, frameCommand, runCommand, stopCommand,
]
