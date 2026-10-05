/**
 * timing：从帧流与节点事件反推 pipeline 的 delay / timeout 建议值。
 *
 * 做法：自动开流 → 跑任务（--runs n 次采样）→ 对齐两类时间线——
 *  - 节点时长（record.nodes）→ 节点级 timeout 建议（P95 × 1.5 余量）
 *  - 节点完成后的画面稳定时间（完成事件到下一个 stable 事件的时距）→ post-delay /
 *    wait_freezes 建议；下一节点先于 stable 开始则标"未稳定"（连续动画/识别窗口过紧）。
 * 分布口径：建议值只取成功 run（失败 run 的时长是提前终止的，对 timeout 建议是误导）；
 * 单次采样退化为 P50=P95=该值，与历史单次行为逐字段一致。
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

/** 单次采样的产物：一次 run 的任务结果 + 该 run 事件区间内的对齐分析 */
export interface RunSample {
  index: number
  ok: boolean
  durationMs: number
  nodes: TimedNode[]
  events: number
}

export interface NodeStat {
  name: string
  status: string
  /** 成功 run 中该节点出现的 run 数（少于成功总数 = 有分支/跳过） */
  runs: number
  /** 总执行次数——同名节点在同一 run 内可能重复（重试/JumpBack/Next 环），
   * 分布统计按全部出现算，丢掉重复会漏掉真正的慢样本 */
  occurrences: number
  msP50: number
  msP95: number
  settleP50: number | null
  settleP95: number | null
  settleSamples: number
  nextBeforeStable: boolean
}

export interface TimingAggregate {
  successful: number
  failed: number
  durationP50: number
  durationP95: number
  /** 各 run 最长节点时长的 P95——建议值的基准（覆盖"最慢节点"这一任务级口径） */
  maxNodeP95: number
  /** 各 run 最长稳定时间的 P95；全无 stable 样本时为 null */
  maxSettleP95: number | null
  nodeStats: NodeStat[]
  suggest: { nodeTimeoutMs: number; taskTimeoutMs: number; postDelayMs: number | null }
}

/** 最近邻秩百分位：sorted 升序；n=1 时任意 p 返回该值，n 小时偏保守端（P95 取最大） */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

/** 跨 run 聚合（纯函数，单测直断言）：节点统计与建议值都只算成功样本 */
export function aggregateTiming(samples: RunSample[]): TimingAggregate {
  const ok = samples.filter((s) => s.ok)
  const failed = samples.length - ok.length
  const durations = ok.map((s) => s.durationMs)
  const maxNodeP95 = ok.length ? percentile(ok.map((s) => Math.max(0, ...s.nodes.map((n) => n.ms))), 95) : 0
  const settleSamples = ok.map((s) => {
    const ss = s.nodes.filter((n) => n.settle !== null).map((n) => n.settle as number)
    return ss.length ? Math.max(...ss) : null
  })
  const settles = settleSamples.filter((v): v is number => v !== null)
  const names = [...new Set(ok.flatMap((s) => s.nodes.map((n) => n.name)))]
  const nodeStats: NodeStat[] = names.map((name) => {
    /* 全部出现都算：同名节点 run 内重复执行时，慢的往往是第二次（首跑等动画） */
    const per = ok.flatMap((s) => s.nodes.filter((n) => n.name === name))
    const ms = per.map((n) => n.ms)
    const st = per.filter((n) => n.settle !== null).map((n) => n.settle as number)
    return {
      name,
      status: per.at(-1)?.status ?? 'unknown',
      runs: ok.filter((s) => s.nodes.some((n) => n.name === name)).length,
      occurrences: per.length,
      msP50: percentile(ms, 50),
      msP95: percentile(ms, 95),
      settleP50: st.length ? percentile(st, 50) : null,
      settleP95: st.length ? percentile(st, 95) : null,
      settleSamples: st.length,
      nextBeforeStable: per.some((n) => n.nextBeforeStable),
    }
  })
  return {
    successful: ok.length, failed,
    durationP50: percentile(durations, 50),
    durationP95: percentile(durations, 95),
    maxNodeP95,
    maxSettleP95: settles.length ? percentile(settles, 95) : null,
    nodeStats,
    suggest: {
      nodeTimeoutMs: Math.ceil((maxNodeP95 * 1.5) / 100) * 100,
      taskTimeoutMs: Math.ceil((percentile(durations, 95) * 2) / 1000) * 1000,
      postDelayMs: settles.length ? Math.ceil((percentile(settles, 95) * 1.2) / 50) * 50 : null,
    },
  }
}

export const timingCommand: Command = {
  name: 'timing',
  summary: '跑任务并反推 timing 建议：节点时长 → timeout，动作后稳定时间 → post-delay；--runs n 取 P50/P95 分布',
  usage: 'maafw-live timing --entry <task> --project <dir> [--timeout <ms>] [--runs <n>] [--preset <name>] [--override <json>]\n' +
    '       自动开流（帧流与节点事件对齐是分析前提）；单次采样是下界，--runs 3-5 取分布再定稿',
  options: {
    ...CONNECT_OPTIONS,
    entry: { type: 'string' },
    'resource-dir': { type: 'string' },
    timeout: { type: 'string' },
    runs: { type: 'string' },
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
    const runs = typeof ctx.values.runs === 'string' ? Number(ctx.values.runs) : 1
    if (!Number.isInteger(runs) || runs < 1 || runs > 10) {
      return fail('BAD_ARGUMENTS', '--runs 需为 1-10 的整数（真机动作采样，别当压测跑）', undefined, EXIT.USAGE)
    }
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

        /* 帧流是分析前提：开流 → 跑 n 次 → 停流；每 run 切自己的事件区间对齐。
         * 末节点可能把下一 run 开头的 stable 算作自己的稳定点——语义上仍是
         * "该节点之后画面何时静默"，可接受。 */
        await act.streamStart(client, { fps: 8 }).catch(() => null)
        const samples: RunSample[] = []
        try {
          for (let i = 1; i <= runs; i++) {
            const eventsBefore = client.events.events.length
            const r = await act.run(client, args, timeoutMs)
            const evs = client.events.events.slice(eventsBefore)
            if (r.ok === false || !r.record) {
              return fail('TIMING_RUN', '任务没跑起来：' + String((r as { error?: string }).error ?? '?'), undefined, EXIT.FINDINGS)
            }
            const rec = r.record as {
              ok: boolean
              durationMs: number
              nodes: Array<{ name: string; status: string; ms: number }>
            }
            /* 时间线对齐：run 类事件带节点名与消息；stable 是画面静默点 */
            const runEvs = evs.filter((e) => e.type === 'run' && e.node) as Array<{ node: string; msg: string; t: number }>
            const stables = evs.filter((e) => e.type === 'stable').map((e) => Number(e.t))
            const nodes: TimedNode[] = rec.nodes.map((n) => {
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
            samples.push({ index: i, ok: rec.ok, durationMs: rec.durationMs, nodes, events: evs.length })
          }
        } finally {
          await act.streamStop(client).catch(() => null)
        }

        const agg = aggregateTiming(samples)
        if (!agg.successful) {
          return fail('TIMING_RUN', runs + ' 次采样全部未成功——没有可用于建议的成功样本', undefined, EXIT.FINDINGS)
        }

        const unsettled = agg.nodeStats.filter((n) => n.nextBeforeStable)
        const last = samples.at(-1)!
        const human = [
          ...describeSession(s),
          'timing 采样 x' + runs + '（' + agg.successful + ' 成功' + (agg.failed ? ' / ' + agg.failed + ' 失败' : '') + '）：',
          ...samples.map((smp) =>
            '  #' + smp.index + ' ' + (smp.ok ? '成功' : '失败（不计入建议）') + '  ' + smp.durationMs + 'ms  ' + smp.nodes.length + ' 节点'),
          '节点时长分布（成功样本，P50 / P95）：',
          ...agg.nodeStats.map((n) =>
            '  [' + n.status + '] ' + n.name + '  ' + n.msP50 + ' / ' + n.msP95 + 'ms' +
            (n.settleP50 !== null ? '  稳定 +' + n.settleP50 + ' / +' + n.settleP95 + 'ms' : '') +
            (n.occurrences > n.runs ? '  （重复执行 ' + n.occurrences + ' 次 / ' + n.runs + ' run——重试或 Next 环）' : '') +
            (n.runs < agg.successful ? '  （' + n.runs + '/' + agg.successful + ' run 出现——分支或跳过）' : '') +
            (n.nextBeforeStable ? '  （下一节点先于画面稳定开始——识别窗口紧或连续动画）' : '')),
          '建议（P95 × 余量，n=' + agg.successful + ' 成功采样）：',
          '  节点 timeout ≥ ' + agg.suggest.nodeTimeoutMs + 'ms（各 run 最长节点 P95 ' + agg.maxNodeP95 + 'ms × 1.5）',
          '  任务 timeout ≥ ' + agg.suggest.taskTimeoutMs + 'ms（任务时长 P95 ' + agg.durationP95 + 'ms × 2）',
          agg.suggest.postDelayMs !== null
            ? '  动作后 post-delay / wait_freezes 参考 ' + agg.suggest.postDelayMs + 'ms（各 run 最长稳定 P95 ' + agg.maxSettleP95 + 'ms × 1.2）'
            : '  动作后稳定时间：无 stable 事件可参考（画面持续变化或流太短）',
        ]
        if (agg.failed) human.push('  注意：' + agg.failed + ' 个失败 run 未计入建议；失败原因与时长见 data.runs')
        if (unsettled.length) {
          human.push('  注意：' + unsettled.map((n) => n.name).join(' , ') + ' 未等画面稳定就进入下一节点')
        }
        return {
          exitCode: EXIT.OK,
          human,
          data: {
            runs: samples, distribution: agg, suggest: agg.suggest,
            /* 兼容字段：单次消费方读 record / nodes 的形状不变 */
            record: { ok: last.ok, durationMs: last.durationMs, nodes: last.nodes },
            nodes: last.nodes,
            sampledEvents: samples.reduce((a, smp) => a + smp.events, 0),
          },
          warnings: [
            ...(agg.failed ? [agg.failed + ' 个失败 run 未计入建议'] : []),
            ...samples.filter((smp) => !smp.ok).map((smp) => 'run #' + smp.index + ' 未成功——该样本已排除'),
            ...(unsettled.length ? [unsettled.length + ' 个节点未等画面稳定即进入下一节点：' + unsettled.map((n) => n.name).join(' , ')] : []),
            ...(runs === 1 ? ['单次采样=下界：加 --runs 3-5 取分布再定稿'] : []),
          ],
        }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const TIMING_COMMANDS: Command[] = [timingCommand]
