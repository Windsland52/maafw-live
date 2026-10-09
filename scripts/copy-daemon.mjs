/**
 * 把 daemon 的 .mjs 源拷进 lib/，并**在构建期校验它能被解析**。
 *
 * tsc 只处理 .ts，不会搬运 .mjs；而 daemon 必须是可直接 spawn 的普通 JS（它跑在独立子进程里，
 * 不经过任何打包器）。所以构建的最后一步是逐字节复制——不做任何改写，避免 daemon 与源码漂移。
 *
 * **为什么要在这里做语法校验**：`.mjs` 既不过 tsc、也不被 `node --check` 之外的任何环节检查，
 * 于是"daemon 里一个括号没配平"能一路通过 `npm run build` 与 `npm run typecheck`，
 * 直到**真去 spawn daemon 时**才炸成 `SyntaxError` —— 而那时调用方看到的是一句和语法无关的
 * "daemon 已退出 (code=1)，会话失效"。实测就是踩了这个：一次编辑留下悬空的 `return {`，
 * 构建通过、typecheck 通过，只有真机会话挂掉。所以复制前先 `node --check`，失败即让构建失败。
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const files = ['framed.mjs', 'reco_child.mjs']

mkdirSync(join(root, 'lib', 'daemon'), { recursive: true })
for (const f of files) {
  const src = join(root, 'src', 'daemon', f)
  try {
    /* `node --check` 用同一个运行时的解析器，够用且零依赖（不进 VM 执行，只解析）。 */
    execFileSync(process.execPath, ['--check', src], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (e) {
    const detail = e && e.stderr ? String(e.stderr).trim() : String(e && e.message)
    process.stderr.write('\n[copy-daemon] 语法校验失败：src/daemon/' + f + '\n' + detail + '\n\n')
    process.exit(1)
  }
  copyFileSync(src, join(root, 'lib', 'daemon', f))
  process.stdout.write('copied src/daemon/' + f + ' -> lib/daemon/' + f + '（语法校验通过）\n')
}
