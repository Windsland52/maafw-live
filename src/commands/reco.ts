/**
 * 识别单测：maafw-live reco。
 *
 * 走 daemon 的 reco_test —— 它把识别放进一次性子进程执行（beta 绑定在无效模板上会原生崩溃，
 * 子进程炸掉只损失一次测试，不带走调用方）。支持阈值扫描：一次调用给出阈值-命中曲线。
 * 项目模式下资源目录从 interface.json 解析，避免手写路径与项目声明不一致。
 */
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { recoTest, withDaemon } from '../runtime/actions.js'
import { describeSession, ensureSession } from '../runtime/session.js'
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

export const recoCommand: Command = {
  name: 'reco',
  summary: '识别单测（子进程隔离）+ 阈值扫描：给资源目录与图像或缓冲帧',
  usage: 'maafw-live reco --type TemplateMatch --resource-dir <dir> --image <png> [--param <json>] [--sweep <json>] [--project <dir>]',
  options: {
    ...CONNECT_OPTIONS,
    type: { type: 'string' },
    'resource-dir': { type: 'string' },
    image: { type: 'string' },
    seq: { type: 'string' },
    param: { type: 'string' },
    sweep: { type: 'string' },
  },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx.values)
    const type = typeof ctx.values.type === 'string' ? ctx.values.type : 'TemplateMatch'
    const image = typeof ctx.values.image === 'string' ? ctx.values.image : undefined
    const seq = typeof ctx.values.seq === 'string' ? Number(ctx.values.seq) : undefined
    const param = parseJson<Record<string, unknown>>(ctx.values.param, '--param')
    if (param.error) return fail('BAD_ARGUMENTS', param.error, undefined, EXIT.USAGE)
    const sweep = parseJson<Record<string, unknown>>(ctx.values.sweep, '--sweep')
    if (sweep.error) return fail('BAD_ARGUMENTS', sweep.error, undefined, EXIT.USAGE)

    try {
      return await withDaemon(async (client) => {
        const s = await ensureSession(client, o)
        const resourceDir = (typeof ctx.values['resource-dir'] === 'string' ? ctx.values['resource-dir'] : undefined)
          ?? s.plan?.resource?.paths[0]
        if (!resourceDir) {
          return fail('BAD_ARGUMENTS', '缺少资源目录：给 --resource-dir <dir>，或用 --project <dir> 让 interface.json 决定',
            undefined, EXIT.USAGE)
        }
        if (!image && seq === undefined) {
          return fail('BAD_ARGUMENTS', '缺少图像：一次性命令给 --image <png>；用缓冲帧（--seq）需要在 maafw-live repl 里先 stream start',
            undefined, EXIT.USAGE)
        }
        const r = await recoTest(client, {
          resourceDir, type,
          ...(image ? { image } : {}),
          ...(seq !== undefined ? { seq } : {}),
          ...(param.value ? { param: param.value } : {}),
          ...(sweep.value ? { sweep: sweep.value } : {}),
        })
        const results = (r.results as Array<{ param: Record<string, unknown>; ms: number; ok: boolean }> | undefined) ?? []
        const human = [
          ...describeSession(s),
          '识别 ' + type + '：' + results.length + ' 例',
          ...results.map((x) => '  ' + (x.ok ? '[命中]' : '[未中]') + ' ' + JSON.stringify(x.param) + '  ' + x.ms + 'ms'),
        ]
        if (r.ok === false) human.push('error: ' + String(r.error))
        return { exitCode: r.ok === false ? EXIT.FINDINGS : EXIT.OK, human, data: r }
      })
    } catch (e) {
      return daemonFail(e)
    }
  },
}

export const RECO_COMMANDS: Command[] = [recoCommand]
