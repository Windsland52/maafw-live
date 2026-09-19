/**
 * 把 daemon 的 .mjs 源拷进 lib/。
 *
 * tsc 只处理 .ts，不会搬运 .mjs；而 daemon 必须是可直接 spawn 的普通 JS（它跑在独立子进程里，
 * 不经过任何打包器）。所以构建的最后一步是逐字节复制——不做任何改写，避免 daemon 与源码漂移。
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const files = ['framed.mjs', 'reco_child.mjs']

mkdirSync(join(root, 'lib', 'daemon'), { recursive: true })
for (const f of files) {
  copyFileSync(join(root, 'src', 'daemon', f), join(root, 'lib', 'daemon', f))
  process.stdout.write('copied src/daemon/' + f + ' -> lib/daemon/' + f + '\n')
}
