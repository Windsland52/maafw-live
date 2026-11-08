/**
 * 输入注入命令：click / swipe / key / text。
 *
 * 全部经 maafw 控制器本体注入（不直接调 adb），坐标是控制器分辨率空间——默认短边 720，
 * 与 pipeline 里 roi / 模板图同一坐标系。要设备就必须给 --project（推荐）或 --kind。
 */
import { EXIT, fail, type Command, type CommandContext, type CommandResult } from '../protocol.js'
import { input, withDaemon } from '../runtime/actions.js'
import { describeSession, ensureSession, type SessionOptions } from '../runtime/session.js'
import { CONNECT_OPTIONS, daemonFail, sessionOptions } from './runtime.js'

function needSession(o: SessionOptions): CommandResult | null {
  if (!o.project && !o.kind) {
    return fail('BAD_ARGUMENTS', '要设备才能注入输入：给 --project <dir>（推荐）或 --kind win32|adb|gamepad',
      'CLI 不做连接持久化；多步操作用 maafw-live repl 连接一次后连续注入', EXIT.USAGE)
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
  ctx: CommandContext,
  o: SessionOptions,
  payload: Record<string, unknown>,
  human: (r: Record<string, unknown>) => string[],
  timeoutMs = 20000,
  expectGuard = false,
): Promise<CommandResult> {
  try {
    return await withDaemon(ctx, async (client) => {
      const s = await ensureSession(client, o)
      const r = await input(client, payload, timeoutMs)
      /* daemon 回执恒 ok:true 包 handler 返回值——"业务拒绝"（{ok:false,code,...}）落在 data，
       * 不抛错。必须查 r.ok===false：帧身份守卫拒发就在这里，不能再走"已点击"成功路径。 */
      if (r.ok === false) {
        const msg = String(r.error ?? 'daemon 拒绝')
        if (expectGuard && /帧身份守卫|EXPECT_FAILED/.test(msg + String(r.code ?? ''))) {
          return fail('EXPECT_FAILED', msg, '重看当前画面再点', EXIT.FINDINGS)
        }
        return fail(String(r.code ?? 'INPUT_REJECTED'), msg, undefined, EXIT.FINDINGS)
      }
      return { exitCode: EXIT.OK, human: [...describeSession(s), ...human(r)], data: r }
    })
  } catch (e) {
    /* 帧身份守卫拒发：daemon 回 ok:false 经 client.call 变 Error（只带 error 文本）。
     * 用文本前缀识别——守卫错误都以"帧身份守卫"开头；落到 FINDINGS（画面已变是"发现"，不是崩）。 */
    if (expectGuard && /帧身份守卫/.test(String((e as Error)?.message ?? e))) {
      return fail('EXPECT_FAILED', String((e as Error)?.message ?? e), '重看当前画面再点', EXIT.FINDINGS)
    }
    return daemonFail(e)
  }
}

export const clickCommand: Command = {
  name: 'click',
  summary: '点击一个坐标（控制器分辨率空间，默认短边 720）',
  usage: 'maafw-live click <x> <y> [--project <dir>|--kind ...] [--contact n] [--pressure n]\n' +
    '       [--expect-seq N | --expect-frame <hash>]——帧身份守卫：画面已变则拒发输入（FINDINGS 退出）',
  options: {
    ...CONNECT_OPTIONS, contact: { type: 'string' }, pressure: { type: 'string' },
    'expect-seq': { type: 'string' }, 'expect-frame': { type: 'string' },
  },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx)
    const miss = needSession(o)
    if (miss) return miss
    const x = Number(ctx.positionals[0])
    const y = Number(ctx.positionals[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return fail('BAD_ARGUMENTS', '用法：maafw-live click <x> <y>', undefined, EXIT.USAGE)
    }
    const expectSeq = num(ctx.values, 'expect-seq')
    const expectFrame = typeof ctx.values['expect-frame'] === 'string' && ctx.values['expect-frame']
      ? String(ctx.values['expect-frame']) : undefined
    return inject(
      ctx,
      o,
      { kind: 'click', x, y, contact: num(ctx.values, 'contact') ?? 0, pressure: num(ctx.values, 'pressure') ?? 1,
        ...(expectSeq !== undefined ? { expectSeq } : {}),
        ...(expectFrame ? { expectFrame } : {}) },
      (r) => ['已点击 (' + x + ', ' + y + ')，' + String(r.ms) + 'ms'],
      20000,
      true,
    )
  },
}

export const swipeCommand: Command = {
  name: 'swipe',
  summary: '滑动（起点到终点，控制器分辨率空间）；--via 给中途路径点 = 一条笔画画折线',
  usage: 'maafw-live swipe <x1> <y1> <x2> <y2> [--duration ms] [--via "x,y;x,y"] [--project <dir>|--kind ...]\n' +
    '       带 --via 时走 touch_down→逐点 touch_move→touch_up（中途不抬手）——连线/谱曲/拖拽排序要的就是这个',
  options: {
    ...CONNECT_OPTIONS, duration: { type: 'string' }, contact: { type: 'string' },
    pressure: { type: 'string' }, via: { type: 'string' },
  },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx)
    const miss = needSession(o)
    if (miss) return miss
    const [x1, y1, x2, y2] = ctx.positionals.slice(0, 4).map((v) => Number(v))
    if (![x1, y1, x2, y2].every((n) => Number.isFinite(n))) {
      return fail('BAD_ARGUMENTS', '用法：maafw-live swipe <x1> <y1> <x2> <y2>', undefined, EXIT.USAGE)
    }
    const viaRaw = typeof ctx.values.via === 'string' ? ctx.values.via : undefined
    let via: number[][] | undefined
    if (viaRaw !== undefined) {
      via = viaRaw.split(';').map((s) => s.split(',').map((x) => Number(String(x).trim())))
      if (!via.length || via.some((p) => p.length !== 2 || p.some((n) => !Number.isFinite(n)))) {
        return fail('BAD_ARGUMENTS', '--via 每段要 2 个数字（x,y），段间用 ; 分隔，例："100,200;150,250"', undefined, EXIT.USAGE)
      }
    }
    return inject(
      ctx,
      o,
      {
        kind: 'swipe', x1, y1, x2, y2,
        duration: num(ctx.values, 'duration') ?? 300,
        contact: num(ctx.values, 'contact') ?? 0,
        pressure: num(ctx.values, 'pressure') ?? 1,
        ...(via ? { via } : {}),
      },
      (r) => [via
        ? '已折线滑动 (' + x1 + ',' + y1 + ') → ' + via.map((p) => '(' + p.join(',') + ')').join(' → ')
          + ' → (' + x2 + ',' + y2 + ')，' + String(r.ms) + 'ms（一条笔画，' + String(via.length) + ' 个路径点）'
        : '已滑动 (' + x1 + ',' + y1 + ') → (' + x2 + ',' + y2 + ')，' + String(r.ms) + 'ms'],
    )
  },
}

export const keyCommand: Command = {
  name: 'key',
  summary: '按键（Android KeyEvent 码：3=Home、4=返回、187=最近任务）',
  usage: 'maafw-live key <code> [--project <dir>|--kind ...]',
  options: { ...CONNECT_OPTIONS },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx)
    const miss = needSession(o)
    if (miss) return miss
    const code = Number(ctx.positionals[0])
    if (!Number.isFinite(code)) return fail('BAD_ARGUMENTS', '用法：maafw-live key <code>', undefined, EXIT.USAGE)
    return inject(ctx, o, { kind: 'key', code }, (r) => ['已按键 ' + code + '，' + String(r.ms) + 'ms'])
  },
}

export const keysCommand: Command = {
  name: 'keys',
  summary: '组合键（key_down 全按下 → key_up 反序抬起；如 Ctrl+C = 17,67）',
  usage: 'maafw-live keys <code[,code+...]> [--hold ms] [--project <dir>|--kind ...]',
  options: { ...CONNECT_OPTIONS, hold: { type: 'string' } },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx)
    const miss = needSession(o)
    if (miss) return miss
    const raw = String(ctx.positionals[0] ?? '')
    const codes = raw.split(/[+,]/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
    if (!codes.length) {
      return fail('BAD_ARGUMENTS', '用法：maafw-live keys <code[,code+...]>（至少一个正整数键码）', undefined, EXIT.USAGE)
    }
    return inject(
      ctx,
      o,
      { kind: 'keys', codes, hold: num(ctx.values, 'hold') ?? 60 },
      (r) => ['已组合键 ' + codes.join('+') + '，' + String(r.ms) + 'ms'],
    )
  },
}

export const pressCommand: Command = {
  name: 'press',
  summary: '长按（touch_down → 保持 duration → touch_up）',
  usage: 'maafw-live press <x> <y> [--duration ms] [--project <dir>|--kind ...]',
  options: { ...CONNECT_OPTIONS, duration: { type: 'string' } },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx)
    const miss = needSession(o)
    if (miss) return miss
    const x = Number(ctx.positionals[0])
    const y = Number(ctx.positionals[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return fail('BAD_ARGUMENTS', '用法：maafw-live press <x> <y>', undefined, EXIT.USAGE)
    }
    return inject(
      ctx,
      o,
      { kind: 'press', x, y, duration: num(ctx.values, 'duration') ?? 800 },
      (r) => ['已长按 (' + x + ', ' + y + ')，' + String(r.ms) + 'ms'],
    )
  },
}

export const dbclickCommand: Command = {
  name: 'dbclick',
  summary: '双击（两次 click，间隔 --gap，默认 60ms）',
  usage: 'maafw-live dbclick <x> <y> [--gap ms] [--project <dir>|--kind ...]',
  options: { ...CONNECT_OPTIONS, gap: { type: 'string' } },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx)
    const miss = needSession(o)
    if (miss) return miss
    const x = Number(ctx.positionals[0])
    const y = Number(ctx.positionals[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return fail('BAD_ARGUMENTS', '用法：maafw-live dbclick <x> <y>', undefined, EXIT.USAGE)
    }
    return inject(ctx, o, { kind: 'dbclick', x, y, gap: num(ctx.values, 'gap') ?? 60 }, (r) => ['已双击 (' + x + ', ' + y + ')，' + String(r.ms) + 'ms'])
  },
}

export const scrollCommand: Command = {
  name: 'scroll',
  summary: '滚轮（dx/dy 格数，建议 120 的倍数 = WHEEL_DELTA；Win32/MacOS）',
  usage: 'maafw-live scroll <dx> <dy> [--project <dir>|--kind ...]',
  options: { ...CONNECT_OPTIONS },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx)
    const miss = needSession(o)
    if (miss) return miss
    const dx = Number(ctx.positionals[0])
    const dy = Number(ctx.positionals[1])
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      return fail('BAD_ARGUMENTS', '用法：maafw-live scroll <dx> <dy>（如 0 -120 向上一格）', undefined, EXIT.USAGE)
    }
    return inject(ctx, o, { kind: 'scroll', dx, dy }, (r) => ['已滚动 (' + dx + ', ' + dy + ')，' + String(r.ms) + 'ms'])
  },
}

export const moveCommand: Command = {
  name: 'move',
  summary: '鼠标相对移动（Win32/MacOS；FPS 锁鼠标场景配合 mouse_lock_follow）',
  usage: 'maafw-live move <dx> <dy> [--project <dir>|--kind ...]',
  options: { ...CONNECT_OPTIONS },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx)
    const miss = needSession(o)
    if (miss) return miss
    const dx = Number(ctx.positionals[0])
    const dy = Number(ctx.positionals[1])
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      return fail('BAD_ARGUMENTS', '用法：maafw-live move <dx> <dy>', undefined, EXIT.USAGE)
    }
    return inject(ctx, o, { kind: 'move', dx, dy }, (r) => ['已相对移动 (' + dx + ', ' + dy + ')，' + String(r.ms) + 'ms'])
  },
}

export const textCommand: Command = {
  name: 'text',
  summary: '输入文本（经控制器注入）',
  usage: 'maafw-live text <string> [--project <dir>|--kind ...]',
  options: { ...CONNECT_OPTIONS },

  async run(ctx): Promise<CommandResult> {
    const o = sessionOptions(ctx)
    const miss = needSession(o)
    if (miss) return miss
    const text = ctx.positionals.join(' ')
    if (!text) return fail('BAD_ARGUMENTS', '用法：maafw-live text <string>', undefined, EXIT.USAGE)
    return inject(ctx, o, { kind: 'text', text }, (r) => ['已输入 ' + text.length + ' 字符，' + String(r.ms) + 'ms'])
  },
}

export const INPUT_COMMANDS: Command[] = [
  clickCommand, swipeCommand, keyCommand, keysCommand,
  pressCommand, dbclickCommand, scrollCommand, moveCommand, textCommand,
]
