/**
 * 关键帧命令：kf status / kf promote / kf list / kf resolve。
 *
 * 升格（promote）是 daemon 内存操作——从 L0 缓存取原图落盘并登记，必须在捕获它的那个
 * daemon 会话里做（ REPL 里 stream/输入/run 之后立刻升格，"看到即升格，不攒到最后"）。
 * list / resolve 是纯离线文件操作，不依赖 daemon 存活（契约 §4.1）。
 */
import { EXIT, fail, type Command, type CommandResult } from '../protocol.js'
import { defaultFramesDir, describeRecord, loadManifest, resolveFrame } from '../runtime/keyframes.js'
import { kfPromote, l0Status, withDaemon } from '../runtime/actions.js'
import { ensureSession } from '../runtime/session.js'
import { CONNECT_OPTIONS, daemonFail, sessionOptions } from './runtime.js'

const DIR_HINT = '库根默认 ~/.maafw-live/frames（与 daemon 的 runDir 一致）'

export const kfCommand: Command = {
  name: 'kf',
  summary: '关键帧：status 看 L0 缓存，promote 升格原图进本地库，list/resolve 离线解析',
  usage: 'maafw-live kf status [--project <dir>|--kind ...]\n' +
    '       maafw-live kf promote <seq|seq seq|a..b|latest> [--note <s>] [--project <dir>|--kind ...]\n' +
    '       maafw-live kf list [--dir <frames>]      （离线，不需要设备）\n' +
    '       maafw-live kf resolve <kf:...> [--dir <frames>]   （离线）',
  options: { ...CONNECT_OPTIONS, note: { type: 'string' }, dir: { type: 'string' }, latest: { type: 'boolean' } },
  /* promote 要的是"捕获帧的那个 daemon 会话"：一次性进程 seq=0 恒失败
   *（P0-3 L4）。list/resolve/status 离线或边界语义可用，不拦。 */
  requiresSession: (ctx) => ctx.positionals[0] === 'promote',

  async run(ctx): Promise<CommandResult> {
    const sub = ctx.positionals[0] ?? 'status'

    if (sub === 'list' || sub === 'resolve') {
      const dir = typeof ctx.values.dir === 'string' ? ctx.values.dir : defaultFramesDir()
      if (sub === 'list') {
        const { manifest, error } = loadManifest(dir)
        if (error) return fail('KF_MANIFEST', error, DIR_HINT, EXIT.FINDINGS)
        if (!manifest) {
          return {
            exitCode: EXIT.OK,
            human: ['关键帧库 ' + dir + '：尚无留存（manifest 未创建；升格后会自动生成）'],
            data: { dir, count: 0, frames: [] },
          }
        }
        return {
          exitCode: EXIT.OK,
          human: [
            '关键帧库 ' + dir + '：' + manifest.frames.length + ' 条（libraryId ' + manifest.libraryId + '）',
            ...manifest.frames.map(describeRecord),
          ],
          data: { dir, count: manifest.frames.length, frames: manifest.frames },
        }
      }
      const id = ctx.positionals[1]
      if (!id) return fail('BAD_ARGUMENTS', '用法：maafw-live kf resolve <kf:库UUID:序号>', undefined, EXIT.USAGE)
      const r = resolveFrame(dir, id)
      const human = ['解析 ' + id + '：' + r.status + (r.reason ? '（' + r.reason + '）' : '')]
      if (r.record) human.push('  ' + describeRecord(r.record))
      if (r.path) human.push('  path: ' + r.path)
      if (r.record) human.push('  sha256: ' + r.record.sha256)
      return { exitCode: EXIT.OK, human, data: r }
    }

    if (sub === 'status') {
      try {
        return await withDaemon(ctx, async (client) => {
          const st = await l0Status(client)
          const roll = st.roll as { count?: number; cap?: number; bytes?: number } | undefined
          const anchor = st.anchor as { count?: number; cap?: number; bytes?: number; entries?: unknown[] } | undefined
          return {
            exitCode: EXIT.OK,
            human: [
              'L0 原图缓存：滚动区 ' + String(roll?.count) + '/' + String(roll?.cap) +
                '（' + String(roll?.bytes) + ' bytes），锚区 ' + String(anchor?.count) + '/' + String(anchor?.cap) +
                '（' + String(anchor?.bytes) + ' bytes），seq=' + String(st.seq),
              '关键帧库：' + String(st.framesDir),
              '锚区条目（seq, source）：',
              ...((anchor?.entries as Array<{ seq: number; source: string | null }> | undefined) ?? [])
                .map((e) => '  seq=' + e.seq + '  ' + String(e.source)),
            ],
            data: st,
          }
        })
      } catch (e) {
        return daemonFail(e)
      }
    }

    if (sub === 'promote') {
      const o = sessionOptions(ctx)
      /* 批量：kf promote 3909 3910 | kf promote 10..15 | kf promote 10,11,12。
       * 逐条升格、成功/淘汰分开报告；淘汰的附 frame_get <seq> 降级命令（L1 参考帧）。 */
      const seqToks = ctx.positionals.slice(1).flatMap((t) => t.split(',')).filter((t) => t !== '')
      let args: { seq?: number; seqs?: number[]; latest?: boolean; note?: string } = {}
      const range = seqToks.length === 1 && /^(\d+)\.\.(\d+)$/.exec(seqToks[0])
      if (range) {
        const a = Number(range[1]), b = Number(range[2])
        if (a > b || b - a > 200) {
          return fail('BAD_ARGUMENTS', '范围 ' + seqToks[0] + ' 非法（a..b 且跨度 ≤200）', undefined, EXIT.USAGE)
        }
        args.seqs = Array.from({ length: b - a + 1 }, (_, i) => a + i)
      } else if (seqToks.length > 1 || (seqToks.length === 1 && /^\d+$/.test(seqToks[0]))) {
        const nums = seqToks.map((t) => Number(t))
        if (nums.some((n) => !Number.isInteger(n) || n <= 0)) {
          return fail('BAD_ARGUMENTS', 'seq 必须是正整数：' + seqToks.join(' '), undefined, EXIT.USAGE)
        }
        if (nums.length === 1) args = { seq: nums[0] }
        else args = { seqs: nums }
      } else if (seqToks[0] === 'latest' || ctx.values.latest === true) {
        args = { latest: true }
      }
      if (typeof ctx.values.note === 'string') args.note = ctx.values.note
      if (!args.seq && !args.latest && !(args.seqs && args.seqs.length)) {
        return fail('BAD_ARGUMENTS',
          '给序号（kf promote 42）、多个序号（kf promote 42 43）、范围（kf promote 10..15）、或 kf promote latest；身份在接受请求时固定，已淘汰则失败',
          '升格要在捕获它的 daemon 会话里做（repl：stream/输入/run 后立刻升格）；一次性命令的 L0 通常只有边界帧',
          EXIT.USAGE)
      }
      try {
        return await withDaemon(ctx, async (client) => {
          if (o.project || o.kind) {
            /* 设备会话存在才值得连：L0 缓存是进程态，连一次至少能把输入/截图边界帧留下 */
            await ensureSession(client, o)
          }
          const r = await kfPromote(client, args)
          /* 批量：逐条列结果；淘汰的 seq 附可复制的 frame_get 降级命令（L1 参考帧） */
          if (Array.isArray(r.results)) {
            const results = r.results as Array<{ ok?: boolean; seq?: number; id?: string; idempotent?: boolean; error?: string }>
            const lines = []
            for (const it of results) {
              if (it.ok) lines.push('  seq=' + it.seq + ' → ' + it.id + (it.idempotent ? '（幂等）' : ''))
              else lines.push('  seq=' + it.seq + ' ✗ ' + it.error)
            }
            const failed = Number(r.failed ?? 0)
            if (failed > 0) {
              return { exitCode: EXIT.FINDINGS, human: ['批量升格：' + r.promoted + ' 成功 / ' + failed + ' 失败', ...lines], data: r }
            }
            return { exitCode: EXIT.OK, human: ['批量升格 ' + r.promoted + ' 例全部成功', ...lines], data: r }
          }
          if (r.ok === false) {
            return fail('KF_PROMOTE', String(r.error ?? '升格失败'), 'L0 淘汰是诚实失败：换 frame_get 导 L1 参考帧，或重采', EXIT.FINDINGS)
          }
          const rec = r.record as { id: string; captureSeq: number; ctrlW: number; ctrlH: number; source: string } | undefined
          return {
            exitCode: EXIT.OK,
            human: [
              '已升格：' + String(r.id) + (r.idempotent ? '（幂等重试，返回原对象）' : ''),
              ...(rec ? ['  捕获 seq=' + rec.captureSeq + '，控制器尺寸 ' + rec.ctrlW + 'x' + rec.ctrlH + '，source=' + rec.source] : []),
              '  path: ' + String(r.path),
              '  sha256: ' + String(r.sha256),
            ],
            data: r,
            written: [String(r.path)],
          }
        })
      } catch (e) {
        return daemonFail(e)
      }
    }

    return fail('BAD_ARGUMENTS', '用法：kf status | kf promote [seq|latest] | kf list | kf resolve <id>', undefined, EXIT.USAGE)
  },
}

export const KF_COMMANDS: Command[] = [kfCommand]
