/**
 * 输入注入命令：click / swipe / key / text。
 *
 * 全部经 maafw 控制器本体注入（不直接调 adb），坐标是控制器分辨率空间——默认短边 720，
 * 与 pipeline 里 roi / 模板图同一坐标系。要设备就必须给 --project（推荐）或 --kind。
 */
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { input, withDaemon } from '../runtime/actions.js'
import { describeSession, ensureSession, type SessionOptions } from '../runtime/session.js'
import { CONNECT_OPTIONS, daemonFail, sessionOptions } from './runtime.js'

function needSession(o: SessionOptions): CommandResult | null {
  if (!o.project && !o.kind) {
    return fail('BAD_ARGUMENTS', '要设备才能注入输入：给 --project <dir>（推荐）或 --kind win32|adb|gamepad',
      'CLI 不做连接持久化；多步操作用 maafw-run repl 连接一次后连续注入', EXIT.USAGE)
  }
  return null
}

function num(values: Record<string, unknown>, key: string): number | undefined {
  const v = values[key]
  if (typeof v === 'string' && v !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

async function inject(
  o: SessionOptions,
  payload: Record<string, unknown>,
  human: (r: Record<string, unknown>) => string[],
  timeoutMs = 20000,
): Promise<CommandResult> {
  try {
    return await withDaemon(async (client) => {
      const s = await ensureSession(client, o)
      const r = await input(client, payload, timeoutMs)
      return { exitCode: EXIT.OK, human: [...describeSession(s), ...human(r)], data: r }
    })
  } catch (e) {
    return daemonFail(e)
  }
}

export const clickCommand: Command = {
  name: 'click',
  summary: '点击一个坐标（控制器分辨率空间，默认短边 720）',
  usage: 'maafw-run click <x> <y> [--project <dir>|--kind ...] [--contact n] [--pressure n]',
  options: { ...CONNECT_OPTIONS, contact: { type: 'string' }, pressure: { type: 'string' } },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx.values)
    const miss = needSession(o)
    if (miss) return miss
    const x = Number(ctx.positionals[0])
    const y = Number(ctx.positionals[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return fail('BAD_ARGUMENTS', '用法：maafw-run click <x> <y>', undefined, EXIT.USAGE)
    }
    return inject(
      o,
      { kind: 'click', x, y, contact: num(ctx.values, 'contact') ?? 0, pressure: num(ctx.values, 'pressure') ?? 1 },
      (r) => ['已点击 (' + x + ', ' + y + ')，' + String(r.ms) + 'ms'],
    )
  },
}

export const swipeCommand: Command = {
  name: 'swipe',
  summary: '滑动（起点到终点，控制器分辨率空间）',
  usage: 'maafw-run swipe <x1> <y1> <x2> <y2> [--duration ms] [--project <dir>|--kind ...]',
  options: { ...CONNECT_OPTIONS, duration: { type: 'string' }, contact: { type: 'string' }, pressure: { type: 'string' } },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx.values)
    const miss = needSession(o)
    if (miss) return miss
    const [x1, y1, x2, y2] = ctx.positionals.slice(0, 4).map((v) => Number(v))
    if (![x1, y1, x2, y2].every((n) => Number.isFinite(n))) {
      return fail('BAD_ARGUMENTS', '用法：maafw-run swipe <x1> <y1> <x2> <y2>', undefined, EXIT.USAGE)
    }
    return inject(
      o,
      {
        kind: 'swipe', x1, y1, x2, y2,
        duration: num(ctx.values, 'duration') ?? 300,
        contact: num(ctx.values, 'contact') ?? 0,
        pressure: num(ctx.values, 'pressure') ?? 1,
      },
      (r) => ['已滑动 (' + x1 + ',' + y1 + ') → (' + x2 + ',' + y2 + ')，' + String(r.ms) + 'ms'],
    )
  },
}

export const keyCommand: Command = {
  name: 'key',
  summary: '按键（Android KeyEvent 码：3=Home、4=返回、187=最近任务）',
  usage: 'maafw-run key <code> [--project <dir>|--kind ...]',
  options: { ...CONNECT_OPTIONS },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx.values)
    const miss = needSession(o)
    if (miss) return miss
    const code = Number(ctx.positionals[0])
    if (!Number.isFinite(code)) return fail('BAD_ARGUMENTS', '用法：maafw-run key <code>', undefined, EXIT.USAGE)
    return inject(o, { kind: 'key', code }, (r) => ['已按键 ' + code + '，' + String(r.ms) + 'ms'])
  },
}

export const textCommand: Command = {
  name: 'text',
  summary: '输入文本（经控制器注入）',
  usage: 'maafw-run text <string> [--project <dir>|--kind ...]',
  options: { ...CONNECT_OPTIONS },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx.values)
    const miss = needSession(o)
    if (miss) return miss
    const text = ctx.positionals.join(' ')
    if (!text) return fail('BAD_ARGUMENTS', '用法：maafw-run text <string>', undefined, EXIT.USAGE)
    return inject(o, { kind: 'text', text }, (r) => ['已输入 ' + text.length + ' 字符，' + String(r.ms) + 'ms'])
  },
}

export const INPUT_COMMANDS: Command[] = [clickCommand, swipeCommand, keyCommand, textCommand]
