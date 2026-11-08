/**
 * 设备与运行时的命令面：probe / device / connect / disconnect / screencap / frame / run / stop。
 *
 * 这一层只做三件事：解析选项、调 runtime/actions、把它翻译成 CLI 信封。任何领域规则
 * （控制器规划、资源解析、时间线）都不许写在这里——REPL 与其它壳（编辑器插件、面板）调的是同一批动作函数。
 */
import { mkdirSync } from 'node:fs'
import { watchLogs } from '../runtime/log-watch.js'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { defaultRunDir } from '../client/daemon.js'
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { parseOptionArgs } from '../option-args.js'
import * as act from '../runtime/actions.js'
import { withDaemon } from '../runtime/actions.js'
import { describeSession, ensureSession, SessionError, type SessionOptions } from '../runtime/session.js'
import { writeRunReceipt } from '../runtime/receipts.js'
import { pruneDir } from '../runtime/prune.js'
import { installRunSignalGuard } from '../runtime/signal-guard.js'

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
  /* 跳过 interface.json 的 pretask（它会连 Controller 之前跑一次，非零即中止连接） */
  'no-pretask': { type: 'boolean' as const },
}

/**
 * 路径参数的解析基准：调用方给的目录就是 `ctx.cwd`（CLI 的 --cwd），不是 process.cwd()。
 * 只处理**纯路径参数**（--project / --resource-dir / --out / --image / --frames-dir 等）——
 * `--resource` 同时是"资源名"，能不能按路径解析要留给 resolveResourcePaths（名字优先），
 * 所以它在 SessionOptions.cwd 里透传，不在这里 resolve。
 */
export function argPath(ctx: { cwd: string }, v: string | undefined): string | undefined {
  if (v === undefined) return undefined
  return isAbsolute(v) ? v : resolve(ctx.cwd, v)
}

export function sessionOptions(ctx: { values: Record<string, unknown>; cwd: string }): SessionOptions {
  const values = ctx.values
  const num = (k: string): number | undefined => {
    const v = values[k]
    return typeof v === 'string' && v !== '' ? Number(v) : undefined
  }
  const str = (k: string): string | undefined => (typeof values[k] === 'string' ? (values[k] as string) : undefined)
  return {
    project: argPath(ctx, str('project')),
    cwd: ctx.cwd,
    controller: str('controller'),
    resource: str('resource'),
    hwnd: str('hwnd'),
    address: str('address'),
    kind: str('kind'),
    target: str('target'),
    shortSide: num('short-side'),
    longSide: num('long-side'),
    rawSize: values.raw === true,
    ...(values['no-pretask'] === true ? { pretask: false } : {}),
  }
}

/** daemon 抛出的错误翻译成结构化失败。退出码按错误的**性质**分：
 * 前置缺失（脚本找不到 / 会话规划失败）退 4；运行时故障（调用超时、进程退出、发送失败）退 1——
 * 同一个 code 在所有路径退同一个码，agent 才不会按"缺环境"去查"daemon 卡住"。 */
export function daemonFail(e: unknown, hint?: string): CommandResult {
  if (e instanceof SessionError) return fail(e.code, e.message, hint, EXIT.ENV)
  const msg = e instanceof Error ? e.message : String(e)
  /* 超时与进程退出是运行时故障，不是前置缺失：退 1，让"重试 / 换参数"排在"装环境"之前 */
  if (/^daemon 调用超时|^daemon 已退出|^daemon 请求发送失败/.test(msg)) {
    return fail('DAEMON_ERROR', msg, hint ?? '重试或看 maafw-live probe；连续出现先 kill 会话重连', EXIT.FAIL)
  }
  if (/^找不到 daemon 脚本/.test(msg)) {
    return fail('DAEMON_ERROR', msg, hint ?? 'daemon 脚本缺失：检查 npm 安装是否完整', EXIT.ENV)
  }
  return fail('DAEMON_ERROR', msg, hint ?? '用 maafw-live probe 检查运行时；连接类错误先 maafw-live device 看有没有设备', EXIT.FAIL)
}

export const probeCommand: Command = {
  name: 'probe',
  summary: '自检 maa-node 运行时：绑定版本、adb/win32 设备发现数',
  usage: 'maafw-live probe',

  async run(ctx): Promise<CommandResult> {
    try {
      return await withDaemon(ctx, async (client) => {
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
      return await withDaemon(ctx, async (client) => {
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
    const o = sessionOptions(ctx)
    if (!o.project && !o.kind) {
      return fail('BAD_ARGUMENTS', '要么给 --project <dir>（按 interface.json 规划），要么给 --kind',
        '推荐 --project：控制器类型/窗口正则/输入方法/识别缩放全跟项目走', EXIT.USAGE)
    }
    try {
      return await withDaemon(ctx, async (client) => {
        const s = await ensureSession(client, o)
        const lines = describeSession(s)
        if (s.streamStopped) {
          /* 重建控制器会让旧流失效：如实说，别让调用方以为是设备卡了（曾经是"流静默死掉"） */
          lines.push('', '帧流：已停止（本次连接重建了控制器）；要看帧就 stream start 重开。')
        }
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
  summary: '断开设备并销毁 Tasker/Controller（会话内命令，等价于结束 REPL 会话）',
  usage: 'maafw-live disconnect --session <name>（一次性形态：为断开先新连一次，没意义）',
  options: { ...CONNECT_OPTIONS },
  /* 为断开先新连一次是自相矛盾的操作——断开会话态才需要"断开"（P0-3 L4） */
  requiresSession: true,

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx)
    if (!o.project && !o.kind) {
      return fail('BAD_ARGUMENTS', '需要 --project 或 --kind 才能建立会话再断开', undefined, EXIT.USAGE)
    }
    try {
      return await withDaemon(ctx, async (client) => {
        await ensureSession(client, o)
        const r = await act.disconnect(client)
        return { exitCode: EXIT.OK, human: ['已断开：' + JSON.stringify(r)], data: r }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

/** 缺省落点 png/ 的保留上限（与 runs/ 同量级的"不留着看"产物） */
const PNG_KEEP = 30

export const screencapCommand: Command = {
  name: 'screencap',
  summary: '截一帧图并落盘（需要连接：给 --project 或 --kind）',
  usage: 'maafw-live screencap [--project <dir>|--kind ...] [--out <png>]',
  options: { ...CONNECT_OPTIONS, out: { type: 'string' } },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx)
    const out = argPath(ctx, typeof ctx.values.out === 'string' ? ctx.values.out : undefined)
      ?? join(defaultRunDir(), 'png', 'shot_' + Date.now() + '.png')
    try {
      mkdirSync(dirname(out), { recursive: true })
    } catch { /* 落盘失败交给 daemon 报错 */ }
    /* 只修剪缺省落点 png/——显式 --out 是用户指定的位置，不动它 */
    if (dirname(out) === join(defaultRunDir(), 'png')) {
      pruneDir(dirname(out), { keep: PNG_KEEP, suffix: '.png' })
    }
    try {
      return await withDaemon(ctx, async (client) => {
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

export const eventsCommand: Command = {
  name: 'events',
  summary: '查帧流事件（stable/change/run），每条自带画面锚点；--watch 可自起帧流现场采集',
  usage: 'maafw-live events [--limit <n>] [--since <seq>] [--watch <ms>] [--fps <n>]\n' +
    '       --watch <ms>：本次调用内先起帧流、等 ms 毫秒、再查（**推荐**：daemon 随命令退出而销毁，\n' +
    '                     事件环不跨进程存活，所以"查上一次留下的记录"是拿不到的）\n' +
    '       不带 --watch：只查当前 daemon 会话里已有的事件——一次性 CLI 里这通常为空，\n' +
    '                     该用法主要用于 REPL 之外的脚本在同进程内先跑 run 再查\n' +
    '       每条事件 frame.retained=l0 表示画面还能取（frame get <seq> / kf promote），gone 表示已滚出',
  options: { ...CONNECT_OPTIONS, limit: { type: 'string' }, since: { type: 'string' }, watch: { type: 'string' }, fps: { type: 'string' } },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx)
    const rawLimit = ctx.values.limit
    const limit = typeof rawLimit === 'string' ? Number(rawLimit) : 20
    if (!Number.isFinite(limit) || limit <= 0) {
      return fail('BAD_ARGUMENTS', '--limit 必须是正整数', undefined, EXIT.USAGE)
    }
    const rawSince = ctx.values.since
    const since = typeof rawSince === 'string' ? Number(rawSince) : undefined
    if (rawSince !== undefined && !Number.isFinite(since)) {
      return fail('BAD_ARGUMENTS', '--since 必须是数字（seq）', undefined, EXIT.USAGE)
    }
    const rawWatch = ctx.values.watch
    const watch = typeof rawWatch === 'string' ? Number(rawWatch) : undefined
    if (rawWatch !== undefined && (!Number.isFinite(watch) || (watch as number) <= 0)) {
      return fail('BAD_ARGUMENTS', '--watch 必须是正毫秒数', undefined, EXIT.USAGE)
    }
    const rawFps = ctx.values.fps
    const fps = typeof rawFps === 'string' ? Number(rawFps) : undefined
    if (rawFps !== undefined && (!Number.isFinite(fps) || (fps as number) <= 0)) {
      return fail('BAD_ARGUMENTS', '--fps 必须是正数', undefined, EXIT.USAGE)
    }
    try {
      return await withDaemon(ctx, async (client) => {
        const s = await ensureSession(client, o)
        /* --watch：daemon 随命令退出而销毁，事件环不跨进程存活——所以"自己起流、现场采集"
         * 是一次性 CLI 拿到事件的唯一可靠方式。用 `wait` 的 change/stable 语义不合适
         * （它等到第一个满足就返回，而我们要的是"跑满这段窗口"），直接起流后按毫秒等。 */
        let watched: { fps?: number; ms: number } | null = null
        if (watch !== undefined) {
          await act.streamStart(client, fps !== undefined ? { fps } : {})
          await new Promise((r) => setTimeout(r, watch))
          watched = { ...(fps !== undefined ? { fps } : {}), ms: watch }
        }
        const r = await act.eventsList(client, { limit, ...(since !== undefined ? { since } : {}) })
        const evs = r.events ?? []
        const human = [...describeSession(s), '事件 ' + evs.length + ' 条' +
          (r.matched !== r.total ? '（匹配 ' + r.matched + ' / 环内共 ' + r.total + '）' : '') +
          (r.truncated ? '，已按 --limit 截取' : '') +
          (watched ? '（本次起流 ' + watched.ms + 'ms' + (watched.fps ? ' @' + watched.fps + 'fps' : '') + ' 现场采集）' : '')]
        if (!evs.length) {
          human.push(watched
            ? '  （这 ' + watched.ms + 'ms 内画面没有变化：事件只在"动了"或"静下来"时产生，' +
              '静止画面不产生事件。要抓变化就加长 --watch 或在等待期间对设备做操作）'
            : '  （环内没有事件：daemon 随命令退出而销毁，事件环不跨进程存活——' +
              '加 --watch <ms> 让它本次调用内起流采集，或改用 REPL 会话）')
        }
        for (const e of evs) {
          const f = e.frame as { seq?: number; retained?: string; source?: string | null } | undefined
          const anchor = !f
            ? '  frame=?（无锚点）'
            : f.retained === 'l0'
              ? '  frame=l0:' + String(f.seq) + (f.source ? '（' + f.source + '）' : '') + ' → frame get ' + String(f.seq)
              : '  frame=gone（seq ' + String(f.seq) + ' 已滚出 L0，取不到了）'
          human.push('  ' + JSON.stringify(e) + anchor)
        }
        return { exitCode: EXIT.OK, human, data: r }
      })
    } catch (e) {
      return daemonFail(e, '事件环只在 daemon 存活期间保留；一次性 CLI 请用 --watch <ms> 现场采集')
    }
  },
}

export const frameCommand: Command = {
  name: 'frame',
  /* frame get 的环恒空（NO_FRAME）；frame status 读的是流状态，空环也算有内容的回答 */
  requiresSession: (ctx) => ctx.positionals[0] === 'get',
  summary: '帧流状态与历史帧取用（环形缓冲只在 REPL 会话里才有内容）',
  usage: 'maafw-live frame status | maafw-live frame get [seq] [--roi x,y,w,h] [--out <png>] [--src auto|full|ring]\n' +
    '        --src full 强制要控制器分辨率原图（L0 已淘汰则报错，绝不给缩小图冒充）',
  options: { ...CONNECT_OPTIONS, roi: { type: 'string' }, out: { type: 'string' }, src: { type: 'string' } },

  async run(ctx): Promise<CommandResult> {
    const sub = ctx.positionals[0] ?? 'status'
    const o = sessionOptions(ctx)
    if (sub === 'status') {
      try {
        return await withDaemon(ctx, async (client) => {
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
    const out = argPath(ctx, typeof ctx.values.out === 'string' ? ctx.values.out : undefined)
    const srcRaw = typeof ctx.values.src === 'string' ? ctx.values.src.toLowerCase() : 'auto'
    if (!['auto', 'full', 'ring'].includes(srcRaw)) {
      return fail('BAD_ARGUMENTS', '--src 只支持 auto | full | ring', undefined, EXIT.USAGE)
    }
    const src = srcRaw as 'auto' | 'full' | 'ring'
    try {
      return await withDaemon(ctx, async (client) => {
        await ensureSession(client, o)
        const r = await act.frameGet(client, { seq, roi, out, src })
        if (r.ok === false) {
          return fail('NO_FRAME', String(r.error ?? '取帧失败'),
            '帧流要先在 REPL 里 stream start；一次性命令的环形缓冲是空的', EXIT.FINDINGS)
        }
        /* 降级是**发现**不是失败：图能用，但分辨率与预期不符必须让人看见（退出 3）。
         * 判据取自 daemon 的 `degraded`——它按"调用方要什么"判（带 roi 的 auto 退小图才算降级；
         * 显式 ring 与整帧小图都是预期行为），比在命令面拿 `sourceResolution < 1` 反推准确。 */
        const degraded = r.degraded === true
        return {
          exitCode: degraded ? EXIT.FINDINGS : EXIT.OK,
          human: [
            '帧 ' + String(r.seq) + ' → ' + String(r.path) + ' (' + r.w + 'x' + r.h + ')'
              + '  来源 ' + String(r.source ?? '?') + '  有效分辨率 ' + String(r.sourceResolution ?? '?'),
            ...(r.warn ? ['  警告：' + String(r.warn)] : []),
          ],
          data: r,
          warnings: r.warn ? [String(r.warn)] : [],
          written: [String(r.path)],
        }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const waitCommand: Command = {
  name: 'wait',
  /* 预热截图不进环 → 恒 NO_FRAME 退 3；就算有帧也没流，stable 秒成立/change 必超时——
   * 两种结果都是假信号（P0-3 L4） */
  requiresSession: true,
  summary: '等状态谓词成立：stable=画面静下来 / change=画面动了（取代硬睡时钟）',
  usage: 'maafw-live wait stable|change [--timeout ms] [--quiet ms] [--roi x,y,w,h] [--threshold n]\n' +
    '        超时不算命令失败（ok=true, satisfied=false, 退出码 3）——"没等到"是观测结果',
  options: {
    ...CONNECT_OPTIONS,
    timeout: { type: 'string' }, quiet: { type: 'string' },
    roi: { type: 'string' }, threshold: { type: 'string' },
  },

  async run(ctx): Promise<CommandResult> {
    const modeRaw = ctx.positionals[0]
    if (modeRaw !== 'stable' && modeRaw !== 'change') {
      return fail('BAD_ARGUMENTS',
        'wait 只认 stable | change' + (modeRaw ? '（收到 ' + JSON.stringify(modeRaw) + '）' : ''),
        '用法：maafw-live wait stable|change [--timeout ms] [--quiet ms] [--roi x,y,w,h] [--threshold n]',
        EXIT.USAGE)
    }
    const mode = modeRaw
    const o = sessionOptions(ctx)
    const timeout = ctx.values.timeout !== undefined ? Number(ctx.values.timeout) : undefined
    if (timeout !== undefined && !Number.isFinite(timeout)) {
      return fail('BAD_ARGUMENTS', '--timeout 必须是毫秒数', undefined, EXIT.USAGE)
    }
    const quiet = ctx.values.quiet !== undefined ? Number(ctx.values.quiet) : undefined
    if (quiet !== undefined && !Number.isFinite(quiet)) {
      return fail('BAD_ARGUMENTS', '--quiet 必须是毫秒数', undefined, EXIT.USAGE)
    }
    const threshold = ctx.values.threshold !== undefined ? Number(ctx.values.threshold) : undefined
    if (threshold !== undefined && !Number.isFinite(threshold)) {
      return fail('BAD_ARGUMENTS', '--threshold 必须是数字', undefined, EXIT.USAGE)
    }
    const roi = typeof ctx.values.roi === 'string'
      ? ctx.values.roi.split(',').map((x) => Number(String(x).trim()))
      : undefined
    if (roi && (roi.length !== 4 || roi.some((n) => !Number.isFinite(n)))) {
      return fail('BAD_ARGUMENTS', '--roi 需要 4 个数字：x,y,w,h', undefined, EXIT.USAGE)
    }
    try {
      return await withDaemon(ctx, async (client) => {
        await ensureSession(client, o)
        const r = await act.waitState(client, {
          mode,
          ...(timeout !== undefined ? { timeout } : {}),
          ...(quiet !== undefined ? { quiet } : {}),
          ...(roi ? { roi } : {}),
          ...(threshold !== undefined ? { threshold } : {}),
        })
        if (r.ok === false) return fail('WAIT', String(r.error ?? '等待失败'), undefined, EXIT.FINDINGS)
        const ok = r.satisfied === true
        return {
          exitCode: ok ? EXIT.OK : EXIT.FINDINGS,
          human: [
            'wait ' + mode + '：' + (ok ? '已成立' : '超时未成立')
              + '  等了 ' + String(r.waitedMs) + 'ms  当前帧 seq=' + String(r.seq),
            ...(r.warn ? ['  警告：' + String(r.warn)] : []),
          ],
          data: r,
          warnings: r.warn ? [String(r.warn)] : [],
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
  usage: 'maafw-live run --entry <task> --project <dir> | --resource-dir <dir> [--timeout <ms|0>] [--override <json>] [--preset <name>] [--resource <名|路径>] [--option <键>=<值>|<键>.<字段>=<值>]…\n' +
    '       --option 按次给选项取值（可多次）：<键>=<case 名>（select/switch；checkbox 用逗号分隔）、\n' +
    '                <键>.<字段>=<值>（input 的输入字段）。优先级 CLI > preset > default_case；\n' +
    '                input/hotkey 的 pipeline_override 模板靠它替换 {字段名}（hotkey 按控制器 type 映射成键码）\n' +
    '       项目模式的 pretask 在连 Controller **之前**执行（非零退出即中止，--no-pretask 跳过）\n' +
    '       --timeout 0 = 不自动停止（停止权交调用方：事件流判断 + maafw-live stop / 客户端 run_stop）；>0 时超时自动 post_stop\n' +
    '       项目模式自动合成 pipeline_override（global→resource→controller→task，preset/default 取值），--override 最后覆盖\n' +
    '       --watch <日志文件> = 跑的同时实时 tail 该文件（可多次给）——长任务执行中 daemon 帧流被框架占住，这是唯一能看到进展的通道',
  options: {
    ...CONNECT_OPTIONS,
    entry: { type: 'string' },
    'resource-dir': { type: 'string' },
    timeout: { type: 'string' },
    override: { type: 'string' },
    preset: { type: 'string' },
    /* 按次取值（可多次给）：<键>=<case 名>（select/switch/checkbox）、<键>.<字段>=<值>（input） */
    option: { type: 'string', multiple: true },
    /* 运行期日志跟随：跑的时候把项目 agent 写的日志实时打出来（可多次给） */
    watch: { type: 'string', multiple: true },
    'watch-interval': { type: 'string' },
  },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx)
    const entry = (typeof ctx.values.entry === 'string' ? ctx.values.entry : ctx.positionals[0]) ?? undefined
    const resourceDir = argPath(ctx, typeof ctx.values['resource-dir'] === 'string' ? ctx.values['resource-dir'] : undefined)
    if (!entry) {
      return fail('BAD_ARGUMENTS', '缺少入口任务名：--entry <task>',
        '项目模式=interface.json 的 task 名；bundle 模式=pipeline 首节点名', EXIT.USAGE)
    }
    if (!o.project && !resourceDir) {
      return fail('BAD_ARGUMENTS', '要么给 --project <dir>，要么给 --resource-dir <dir>', undefined, EXIT.USAGE)
    }

    /* --override 收对象（=一层）或数组（=逐层）：框架按数组逐层继承，对象会被摊成
     * [obj] 等价一层。字段缺失继承前值——与 GUI 客户端同一语义（@8061d5b 已核）。 */
    let override: Record<string, unknown> | Record<string, unknown>[] = {}
    if (typeof ctx.values.override === 'string') {
      try {
        override = JSON.parse(ctx.values.override) as Record<string, unknown> | Record<string, unknown>[]
      } catch (e) {
        return fail('BAD_ARGUMENTS', '--override 不是合法 JSON：' + String((e as Error).message), undefined, EXIT.USAGE)
      }
    }
    const timeoutMs = typeof ctx.values.timeout === 'string' ? Number(ctx.values.timeout) : 30000
    if (!Number.isFinite(timeoutMs)) {
      return fail('BAD_ARGUMENTS', '--timeout 必须是毫秒数', undefined, EXIT.USAGE)
    }
    const presetName = typeof ctx.values.preset === 'string' ? ctx.values.preset : null
  const parsedOptions = parseOptionArgs(ctx.values.option)
  if (parsedOptions.error) {
    return fail('BAD_ARGUMENTS', parsedOptions.error, '例：--option taskOpt=b  --option 章节数.章节号=4', EXIT.USAGE)
  }
  const { cases: optionCases, fields: optionFields } = parsedOptions
  /* run 是"启动工作"类命令：pretask 要跑（P0-2——观测/输入类命令不跑，run 保留）。
   * --no-pretask 显式关。 */
  if (o.pretask === undefined) o.pretask = true
  /* pretask 在连接之前就跑，所以按次取值必须在 ensureSession 之前挂进 SessionOptions——
   * 否则同一次 run 里 pretask 的末位 JSON 与 pipeline_override 用的不是同一份取值。 */
  if (Object.keys(optionCases).length) o.optionCases = optionCases
  if (Object.keys(optionFields).length) o.optionFields = optionFields

    try {
      return await withDaemon(ctx, async (client) => {
        const s = await ensureSession(client, o)
        let args: Record<string, unknown>
        let resolvedEntry: string = entry
        let extraWarns: string[] = []
        let appliedLines: string[] = []
        if (o.project) {
          /* 入口解析 / task 适用性 / 四级 override / agent 桥接只有一份实现：
           * REPL `run` 调的是同一个 prepareProjectRun，不再各长一套规则。 */
          const prep = act.prepareProjectRun({
            project: s.plan!,
            entry,
            presetName,
            override,
            ...(Object.keys(optionCases).length ? { optionCases } : {}),
            ...(Object.keys(optionFields).length ? { optionFields } : {}),
          })
          if (!prep.ok) return fail(prep.code, prep.error, prep.hint, EXIT.FINDINGS)
          args = prep.args
          resolvedEntry = prep.entry
          extraWarns = prep.warns
          appliedLines = prep.applied
        } else {
          args = { resourceDir, entry, override, timeoutMs }
          /* bundle 模式不载入 interface，preset 没有可应用的四级链——静默丢参数会让调用方
           * 以为 P1 已生效；与 REPL 同一句警告。 */
          if (presetName) extraWarns.push('--resource-dir 是 bundle 模式：--preset ' + presetName + ' 不生效（不叠 interface 四级 override）')
          if (Object.keys(optionCases).length || Object.keys(optionFields).length) {
            extraWarns.push('--resource-dir 是 bundle 模式：--option 不生效（取值只作用于 interface 的 option 链与模板替换）')
          }
        }
        /* 运行期日志跟随：run 会阻塞到任务结束，期间帧流/事件都不可用（框架占住控制器），
         * 唯一还在更新的只有项目 agent 自己写的日志。给了 --watch 就在这里边跑边推。 */
        const watchRaw = ctx.values.watch
        const watchPaths = (Array.isArray(watchRaw) ? watchRaw : watchRaw === undefined ? [] : [watchRaw])
          .filter((x): x is string => typeof x === 'string' && x.length > 0)
          .map((x) => (isAbsolute(x) ? x : resolve(ctx.cwd, x)))
        const watchInterval = Number(ctx.values['watch-interval'] ?? 2000)
        const watcher = watchPaths.length
          ? watchLogs(
              { paths: watchPaths, intervalMs: Number.isFinite(watchInterval) ? watchInterval : 2000 },
              (lines) => {
                /* 直写 stdout：--json 模式下也会混进人类可读行，所以下面的信封里另给 watch 统计，
                 * 并在 --json 时把人类行改走 stderr（stdout 只留信封）。 */
                const sink = ctx.flags.json ? process.stderr : process.stdout
                for (const l of lines) sink.write('[watch] ' + l + '\n')
              },
            )
          : null
        /* 信号处理（审计 #6）：Ctrl-C / kill 时不许让 daemon 里的任务裸跑——向 daemon 发
         * run_stop（post_stop），run 回执照常落盘，退出码区分「我停的」与「它坏的」：
         * SIGINT=130 / SIGTERM=143（128+signo），任务自身失败仍是 1。
         * 第二次按信号直接 bail——第一次没杀掉说明 daemon 已不应答，再等没有现场可留。 */
        /* 信号处理（审计 #6）：Ctrl-C / kill 时不许让 daemon 里的任务裸跑——向 daemon 发
         * run_stop，run 回执照常落盘，退出码区分「我停的」与「它坏的」（128+signo）。 */
        /* 信号处理（审计 #6）：Ctrl-C / kill 时不许让 daemon 里的任务裸跑——向 daemon 发
         * run_stop，run 回执照常落盘，退出码区分「我停的」与「它坏的」（128+signo）。 */
        const sigGuard = installRunSignalGuard(() => act.runStop(client).then(() => undefined))
        /* finally 摘钩：act.run 抛错（daemon 死了）也不留监听残留 */
        const r = await act.run(client, args, timeoutMs).finally(() => sigGuard.restore())
        const interrupted = sigGuard.code
        const watchStats = watcher ? watcher.stop() : null
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
          timeoutMs?: number
          durationMs?: number
          nodes?: Array<{ name: string; status: string; ms: number }>
          startSeq?: number | null
          endSeq?: number
          framesCaptured?: number
          agent?: { ok?: boolean; reused?: boolean; actions?: string[] | null; recognitions?: string[] | null; error?: string }
          hashCheck?: { resourceName?: string; expected?: string; actual?: string; match?: boolean }
        }
        const taskOk = rec.ok === true
        const nodes = rec.nodes ?? []
        /* 三态结论词：`status:0 + stopped:true` 单看 status 会被读成"成功完成"（本仓 G21 实测误读）。
         * 判据用 record 自带的 timeoutMs，不靠调用方回忆当初给了什么：
         *   跑满窗口被截断 → 非成功非失败（是"没跑完"，不是"跑完了没成功"）；
         *   stopped 但没跑满 → 是任务自己结束、只是没成功。
         * 退出码仍按任务级 record.ok，不给截断开绿灯。 */
        const budget = typeof rec.timeoutMs === 'number' ? rec.timeoutMs : null
        const ranFull = rec.stopped === true && budget !== null && budget > 0
          && typeof rec.durationMs === 'number' && rec.durationMs >= budget
        const verdict = interrupted
          ? (interrupted === EXIT.SIGINT ? '被 Ctrl-C 中断（SIGINT）' : '被终止信号中断（SIGTERM）')
          : taskOk
            ? '完成'
            : ranFull
              ? '超时截断（非成功，也非失败：任务没跑完就被 post_stop 了）'
              : rec.stopped === true
                ? '被停止（run_stop / 任务自身请求 post_stop，未成功）'
                : '失败'
        const agentLines: string[] = []
        if (rec.hashCheck?.expected !== undefined) {
          agentLines.push(rec.hashCheck.match === true
            ? '  资源完整性：' + String(rec.hashCheck.resourceName) + ' hash 校验通过'
            : '  资源完整性：' + String(rec.hashCheck.resourceName) + ' hash 不匹配（期望 ' +
              String(rec.hashCheck.expected) + ' / 实际 ' + String(rec.hashCheck.actual || '?') + '），按 v2.6 语义不阻断')
        }
        if (rec.agent) {
          agentLines.push(rec.agent.ok
            ? '  agent 已连接' + (rec.agent.reused ? '（复用）' : '') + '：custom action ' +
              String(rec.agent.actions?.length ?? '?') + ' 个 / recognition ' + String(rec.agent.recognitions?.length ?? '?') + ' 个'
            : '  agent 连接失败：' + String(rec.agent.error ?? '?'))
        }
        const human = [
          ...describeSession(s),
          '任务 ' + resolvedEntry + '：' + verdict +
            '（status=' + String(rec.status) + '，' + String(rec.durationMs) + 'ms' +
            (budget !== null ? ' / timeout=' + String(budget) + 'ms' : '') + '，帧序 ' +
            String(rec.startSeq) + '..' + String(rec.endSeq) + '）',
          ...agentLines,
          ...appliedLines.map((l) => '  override: ' + l),
          ...nodes.map((n) => '  [' + n.status + '] ' + n.name + '  ' + n.ms + 'ms'),
        ]
        if (!taskOk) {
          human.push('', 'daemon 原生日志尾部：', ...client.logTail(20).map((l) => '  ' + l))
          /* agent 缺位的失败归因：原生层只会说 Action is null，翻译成可行动的诊断 */
          if (/Action is null|Recognition is null/.test(client.logTail(40).join('\n'))) {
            const agents = s.plan?.loaded.agents ?? []
            human.push('',
              '诊断：日志出现 Action/Recognition is null —— 节点依赖项目 agent 注册的 custom 回调。' +
                (rec.agent?.ok
                  ? 'agent 已连接但该动作未注册，检查 custom_action 拼写或 agent 版本。'
                  : agents.length
                    ? 'agent 连接失败（版本错配？maa-node 与 agent 侧 maa 库须同版本）。'
                    : '项目未声明 agent，检查节点 custom_action/custom_recognition 拼写。'))
            extraWarns.push('任务失败疑似缺 agent custom 回调（Action/Recognition is null）')
          }
        }
        if (rec.agent && rec.agent.ok === false) {
          extraWarns.push('agent 连接失败：' + String(rec.agent.error ?? '?'))
        }
        if (watchStats && watchStats.files.length === 0) {
          extraWarns.push('--watch 没有命中任何文件（' + watchPaths.join(' , ') + '）：检查路径是否存在、日志是否在跑起来之后才创建')
        }
        if (watchStats) {
          human.push('  运行期日志跟随：' + String(watchStats.pushed) + ' 行（来自 ' +
            String(watchStats.files.length) + ' 个文件）')
        }
        /* 回执全量落盘（与 repl 同一助手、同一目录约定）：W1 runs 存储的种子。
         * 失败只降级为不打路径行，不影响任务结论与退出码。 */
        const receipt = writeRunReceipt(r, resolvedEntry)
        if (receipt.path !== undefined) {
          human.push('  完整回执（含全部节点与 msgs）：' + receipt.path)
        }
        return {
          /* 中断优先于任务结论：退出码讲"我怎么走的"，不讲"任务结果如何"（回执里有）。
           * 130=SIGINT / 143=SIGTERM，都是 128+signo 惯例。 */
          exitCode: interrupted || (taskOk ? EXIT.OK : EXIT.FAIL),
          human,
          data: watchStats ? { ...(r as object), watch: watchStats } : r,
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
  /* 一次性形态没意义：停的是自己刚起的空 daemon，回 ok 误导（设计审查 P0-3 L4） */
  requiresSession: true,

  async run(ctx): Promise<CommandResult> {
    try {
      return await withDaemon(ctx, async (client) => {
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
  screencapCommand, frameCommand, eventsCommand, waitCommand, runCommand, stopCommand,
]
