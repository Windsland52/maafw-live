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
    '       maafw-live kf promote <seq>|latest [--note <s>] [--project <dir>|--kind ...]\n' +
    '       maafw-live kf list [--dir <frames>]      （离线，不需要设备）\n' +
    '       maafw-live kf resolve <kf:...> [--dir <frames>]   （离线）',
  options: { ...CONNECT_OPTIONS, note: { type: 'string' }, dir: { type: 'string' }, latest: { type: 'boolean' } },

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
        return await withDaemon(async (client) => {
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
      const o = sessionOptions(ctx.values)
      const seqRaw = ctx.positionals[1]
      let args: { seq?: number; latest?: boolean; note?: string }
      if (seqRaw !== undefined && /^\d+$/.test(seqRaw)) args = { seq: Number(seqRaw) }
      else if (seqRaw === 'latest' || ctx.values.latest === true) args = { latest: true }
      else args = {}
      if (typeof ctx.values.note === 'string') args.note = ctx.values.note
      if (!args.seq && !args.latest) {
        return fail('BAD_ARGUMENTS', '给序号（kf promote 42）或 kf promote latest；身份在接受请求时固定，已淘汰则失败',
          '升格要在捕获它的 daemon 会话里做（repl：stream/输入/run 后立刻升格）；一次性命令的 L0 通常只有边界帧',
          EXIT.USAGE)
      }
      try {
        return await withDaemon(async (client) => {
          if (o.project || o.kind) {
            /* 设备会话存在才值得连：L0 缓存是进程态，连一次至少能把输入/截图边界帧留下 */
            await ensureSession(client, o)
          }
          const r = await kfPromote(client, args)
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
