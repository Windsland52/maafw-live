#!/usr/bin/env node
/**
 * maafw-live CLI 启动器。
 *
 * 为什么不让 package.json 的 bin 直接指向 lib/index.js：
 *  - tsc 不会生成 shebang，Windows 下也没有可执行位概念；
 *  - 未构建时要给出可操作的中文提示，而不是一个 MODULE_NOT_FOUND 堆栈。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'lib', 'index.js')

if (!existsSync(entry)) {
  process.stderr.write(
    'maafw-live: 尚未构建。\n' +
      '  请在 maafw-live 目录执行：npm install && npm run build\n',
  )
  process.exit(1)
}

const { main } = await import(new URL('../lib/index.js', import.meta.url))
process.exitCode = await main(process.argv.slice(2))
