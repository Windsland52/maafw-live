/**
 * timing：从帧流与节点事件反推 pipeline 的 delay / timeout 建议值。
 *
 * 做法：自动开流 → 跑一次任务 → 对齐两类时间线——
 *  - 节点时长（record.nodes）→ 节点级 timeout 建议（×1.5 余量）
 *  - 节点完成后的画面稳定时间（完成事件到下一个 stable 事件的时距）→ post-delay /
 *    wait_freezes 建议；下一节点先于 stable 开始则标"未稳定"（连续动画/识别窗口过紧）。
 * 单次采样只是下界参考，多次运行取分布再定稿。
 */
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { computePipelineOverride } from '../interface/index.js'
import * as act from '../runtime/actions.js'
import { withDaemon } from '../runtime/actions.js'
import { describeSession, ensureSession } from '../runtime/session.js'
import { CONNECT_OPTIONS, daemonFail, sessionOptions } from './runtime.js'

interface TimedNode {
  name: string
  ms: number
  status: string
  settle: number | null
  nextBeforeStable: boolean
}

export const timingCommand: Command = {
  name: 'timing',
  summary: '跑一次任务并反推 timing 建议：节点时长 → timeout，动作后稳定时间 → post-delay',
  usage: 'maafw-live timing --entry <task> --project <dir> [--timeout <ms>] [--preset <name>] [--override <json>]\n' +
    '       自动开流（帧流与节点事件对齐是分析前提）；单次采样是下界，多跑几次取分布再定稿',
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
    if (!entry) return fail('BAD_ARGUMENTS', '缺少入口任务名：--entry <task>', undefined, EXIT.USAGE)
    if (!o.project && !resourceDir) {
      return fail('BAD_ARGUMENTS', '要么给 --project <dir>，要么给 --resource-dir <dir>', undefined, EXIT.USAGE)
    }
    const timeoutMs = typeof ctx.values.timeout === 'string' ? Number(ctx.values.timeout) : 120000
    if (!Number.isFinite(timeoutMs)) return fail('BAD_ARGUMENTS', '--timeout 必须是毫秒数', undefined, EXIT.USAGE)
    let override: Record<string, unknown> = {}
    if (typeof ctx.values.override === 'string') {
      try { override = JSON.parse(ctx.values.override) as Record<string, unknown> } catch (e) {
        return fail('BAD_ARGUMENTS', '--override 不是合法 JSON', undefined, EXIT.USAGE)
      }
    }

    try {
      return await withDaemon(async (client) => {
        const s = await ensureSession(client, o)
        let args: Record<string, unknown>
        if (o.project) {
          const paths = s.plan?.resource?.paths ?? []
          if (!paths.length) {
            return fail('RESOURCE_NOT_FOUND', '项目里没有解析出资源路径：检查 interface.json 的 resource[] 声明', undefined, EXIT.FINDINGS)
          }
          const task = s.plan?.loaded.tasks.find((t) => t.name === entry || t.entry === entry)
          const chain = computePipelineOverride({
            loaded: s.plan!.loaded,
            controllerName: s.plan?.controllerName ?? null,
            resourceName: s.plan?.resource?.selected ?? null,
            taskName: task?.name ?? null,
            presetName: typeof ctx.values.preset === 'string' ? ctx.values.preset : null,
          })
          for (const [node, fields] of Object.entries(override)) {
            chain.override[node] = { ...(chain.override[node] as Record<string, unknown> ?? {}), ...(fields as Record<string, unknown>) }
          }
          args = {
            resourceDirs: paths, entry: task?.entry ?? entry,
            override: chain.override, timeoutMs,
            agents: s.plan!.loaded.agents.map((a) => ({ exec: a.exec, args: a.args })),
            agentCwd: s.plan!.loaded.dir ?? undefined,
          }
        } else {
          args = { resourceDir, entry, override, timeoutMs }
        }

        /* 帧流是分析前提：开流 → 跑 → 停流，事件在 client.events 里对齐 */
        await act.streamStart(client, { fps: 8 }).catch(() => null)
        const eventsBefore = client.events.events.length
        const r = await act.run(client, args, timeoutMs)
        await act.streamStop(client).catch(() => null)
        if (r.ok === false || !r.record) {
          return fail('TIMING_RUN', '任务没跑起来：' + String((r as { error?: string }).error ?? '?'), undefined, EXIT.FINDINGS)
        }
        const rec = r.record as {
          ok: boolean
          durationMs: number
          nodes: Array<{ name: string; status: string; ms: number }>
        }

        /* 时间线对齐：run 类事件带节点名与消息；stable 是画面静默点 */
        const evs = client.events.events.slice(eventsBefore)
        const runEvs = evs.filter((e) => e.type === 'run' && e.node) as Array<{ node: string; msg: string; t: number }>
        const stables = evs.filter((e) => e.type === 'stable').map((e) => Number(e.t))

        const timed: TimedNode[] = rec.nodes.map((n) => {
          const done = runEvs.filter((e) => e.node === n.name && /Succeeded$/.test(e.msg)).at(-1)
            ?? runEvs.filter((e) => e.node === n.name && /Failed$/.test(e.msg)).at(-1)
          if (!done) return { name: n.name, ms: n.ms, status: n.status, settle: null, nextBeforeStable: false }
          const nextNode = runEvs.find((e) => e.t > done.t && e.node !== n.name)
          const stable = stables.find((t) => t > done.t)
          const settle = stable !== undefined ? stable - done.t : null
          return {
            name: n.name, ms: n.ms, status: n.status,
            settle,
            nextBeforeStable: nextNode !== undefined && (stable === undefined || nextNode.t < stable),
          }
        })

        const maxMs = Math.max(0, ...timed.map((n) => n.ms))
        const settles = timed.filter((n) => n.settle !== null).map((n) => n.settle as number)
        const maxSettle = settles.length ? Math.max(...settles) : 0
        const suggest = {
          nodeTimeoutMs: Math.ceil((maxMs * 1.5) / 100) * 100,
          taskTimeoutMs: Math.ceil((rec.durationMs * 2) / 1000) * 1000,
          postDelayMs: settles.length ? Math.ceil((maxSettle * 1.2) / 50) * 50 : null,
        }
        const unsettled = timed.filter((n) => n.nextBeforeStable)
        const human = [
          ...describeSession(s),
          'timing 采样（任务 ' + (rec.ok ? '成功' : '失败') + '，' + rec.durationMs + 'ms，' + timed.length + ' 节点）：',
          ...timed.map((n) =>
            '  [' + n.status + '] ' + n.name + '  ' + n.ms + 'ms' +
            (n.settle !== null ? '  稳定 +' + n.settle + 'ms' : '') +
            (n.nextBeforeStable ? '  （下一节点先于画面稳定开始——识别窗口紧或连续动画）' : '')),
          '建议（单次采样=下界，多跑几次取分布）：',
          '  节点 timeout ≥ ' + suggest.nodeTimeoutMs + 'ms（最长节点 ' + maxMs + 'ms × 1.5）',
          '  任务 timeout ≥ ' + suggest.taskTimeoutMs + 'ms（本次 ' + rec.durationMs + 'ms × 2）',
          suggest.postDelayMs !== null
            ? '  动作后 post-delay / wait_freezes 参考 ' + suggest.postDelayMs + 'ms（最长稳定 ' + maxSettle + 'ms × 1.2）'
            : '  动作后稳定时间：本次无 stable 事件可参考（画面持续变化或流太短）',
        ]
        if (unsettled.length) {
          human.push('  注意：' + unsettled.map((n) => n.name).join(' , ') + ' 未等画面稳定就进入下一节点')
        }
        return {
          exitCode: EXIT.OK,
          human,
          data: { record: rec, nodes: timed, suggest, sampledEvents: evs.length },
          warnings: [
            ...(rec.ok ? [] : ['任务未成功——时长样本可能偏短']),
            ...(unsettled.length ? [unsettled.length + ' 个节点未等画面稳定即进入下一节点：' + unsettled.map((n) => n.name).join(' , ')] : []),
          ],
        }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const TIMING_COMMANDS: Command[] = [timingCommand]
