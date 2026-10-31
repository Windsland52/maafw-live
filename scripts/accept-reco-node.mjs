#!/usr/bin/env node
/**
 * 验收（离线，无设备）：`reco` 按**资源里的原名**跑（--node-name）与**整条资源链**生效。
 *
 * 为什么必须真 daemon：`--node-name` 这条路在 daemon 里把 resourceDirs[] 交给一次性子进程
 * `post_bundle`（resource.path[] 按声明序叠加，末尾追加控制器的 attach_resource_path），再由框架
 * `run_recognition(节点名)` 跑。桩 daemon 只能钉住判据与回执字段，**钉不住"链是怎么叠起来的、
 * 同名节点谁覆盖谁、attach 段在不在链里"**——这三件事只有真 post_bundle 跑一次才成立。
 * 因此这里每个用例都是真 CLI → 真 daemon → 真识别子进程，只是输入换成合成 PNG（无设备）。
 *
 * 覆盖的不变量：
 *  I1 整链 = resource.path[] 按声明序叠加 + attach 段，回执 labels 能自证在看哪一层（A1）
 *  I2 同名节点后声明的（overlay）覆盖先声明的（base），dump 与实际识别结果都跟着变（A1）
 *  I3 单包（--resource-dir）只加载一个包，overlay 不参与（A2）
 *  I4 attach 段进链：只在 attach 包里的节点能按原名跑到（A3），单包跑不到（A4）
 *  I5 节点找到了但识别是 Custom → RECO_CUSTOM_NODE，不能报成"找不到"（A5）
 *  I6 给的是节点表（多节点）→ BAD_ARGUMENTS，并提示改走 --node-name（A6）
 *  I7 --node-file 按 JSONC 读：`//` 注释与尾随逗号都吃（A7）
 *  I8 链里确实没有该节点 → RECO_NODE_MISSING，并给可行动的 hint（A8）
 *  I9 OCR 空结果先查模型：链上没有 `model/ocr` 三件套时，原因指向模型而不是 roi（A9）
 *  I10 近邻节点名来自真实 node_list：拼错一个字能建议回正确名字（A10）
 *  I11 等价性：nodeDump 落文件再 `--node-file`，hit / box 与 `--node-name` 一致（A11）
 *  I12 And 里嵌的 Custom 子识别同样走 RECO_CUSTOM_NODE，不落回 miss（A12）
 *  I13 参数值 / 引用名里的 "Custom" 不是识别类型位，不能被认成 Custom 子识别（A13）
 *
 * 临时项目建在系统临时目录、结束递归删除；不写仓库目录、不连设备。
 *
 * 用法：node scripts/accept-reco-node.mjs   （或 npm run accept:reco-node；无参数）
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { __test } from '../lib/daemon/framed.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'bin', 'maafw-live.mjs')

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  — ' + detail : '')) }
}
const j = (v) => {
  if (v === undefined) return 'undefined'
  try { return JSON.stringify(v) } catch { return String(v) }
}

/** 一次性 CLI：--json 时 stdout 是纯 JSON 信封，stderr 留给 human 输出（错误 + hint） */
function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error) throw r.error
  let env = null
  try { env = JSON.parse(r.stdout) } catch { /* 非 --json 时没有信封 */ }
  return { code: r.status, env, out: r.stdout ?? '', err: r.stderr ?? '' }
}
const reco = (args) => run(['reco', ...args, '--json'])

/** 断言失败时的定位信息：退出码 / error / 关键回执字段，不糊整份 data */
function diag(r) {
  const d = r.env?.data
  const tail = r.code !== 0 && r.err.trim() ? r.err.trim().split(/\r?\n/).slice(-2).join(' / ') : ''
  return 'exit=' + r.code +
    ' error.code=' + j(r.env?.error?.code) +
    (r.env?.error?.message ? ' error.message=' + j(r.env.error.message) : '') +
    ' layer=' + j(d?.layer) +
    ' source=' + j(d?.resource?.source) +
    ' labels=' + j(d?.resource?.labels) +
    ' paramSource=' + j(d?.paramSource) +
    ' recognition=' + j(d?.nodeDump?.recognition?.type) +
    ' results[0].ok=' + j(d?.results?.[0]?.ok) +
    (tail ? ' stderr=' + j(tail) : '') +
    (r.env === null ? ' stdout=' + j(r.out.slice(0, 200)) : '')
}

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
const writeJson = (file, value) => write(file, JSON.stringify(value, null, 2) + '\n')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-accept-reco-'))
const RES = path.join(dir, 'resource')
const BASE = path.join(RES, 'base')
const OVERLAY = path.join(RES, 'overlay')
const ATTACH = path.join(RES, 'attach')
const PNG = path.join(dir, 'white8.png')
const NODETABLE = path.join(dir, 'nodetable.json')
const ONENODE = path.join(dir, 'onenode.json')

try {
  /* ── 最小 Maa 项目（ProjectInterface v2）：base + overlay 叠加，attach 由控制器追加 ── */
  writeJson(path.join(dir, 'interface.json'), {
    interface_version: 2,
    controller: [{
      name: 'win',
      type: 'Win32',
      win32: { class_regex: '^x$', window_regex: '^y$' },
      attach_resource_path: ['resource/attach'],
    }],
    resource: [{ name: 'demo', path: ['resource/base', 'resource/overlay'] }],
    task: [],
  })
  writeJson(path.join(BASE, 'pipeline', 'base.json'), {
    BaseDirect: { recognition: 'DirectHit' },
    CustomProbe: { recognition: 'Custom', custom_recognition: 'NoSuchReco' },
    /* And 里嵌一个 Custom 子识别：能力边界在嵌套层同样成立，不能落回 miss */
    NestedCustom: {
      recognition: 'And',
      all_of: [{ recognition: 'DirectHit' }, { recognition: 'Custom', custom_recognition: 'NoSuchReco' }],
    },
    /* 名字碰巧是 Custom 的**参数值**（OCR 要认的文字）：不是 Custom 识别，不能被认成子识别 */
    ExpectedCustomText: { recognition: 'OCR', expected: 'Custom' },
  })
  /* 同名改写：overlay 段里 BaseDirect 换成 ColorMatch——用来证明"后声明的覆盖先声明的" */
  writeJson(path.join(OVERLAY, 'pipeline', 'overlay.json'), {
    BaseDirect: { recognition: 'ColorMatch', lower: [0, 0, 0], upper: [255, 255, 255], count: 1 },
  })
  /* 只在 attach 段里的节点——用来证明 attach 确实进了资源链 */
  writeJson(path.join(ATTACH, 'pipeline', 'attach.json'), {
    AttachOnlyProbe: { recognition: 'DirectHit' },
  })
  /* 节点表（多节点）：--node-file 应当拒绝并提示 --node-name */
  writeJson(NODETABLE, {
    A: { recognition: 'DirectHit' },
    B: { recognition: 'DirectHit' },
  })
  /* JSONC：pipeline 里常见的 // 注释 + 尾随逗号，必须读得动 */
  write(ONENODE,
    '{\n' +
    '  // JSONC：pipeline 文件常带注释\n' +
    '  "recognition": "DirectHit", // 尾随逗号也合法\n' +
    '}\n')
  /* 8x8 全白：ColorMatch 落在 [0,0,0]..[255,255,255] 内，DirectHit 不看像素 */
  const W = 8
  const H = 8
  fs.writeFileSync(PNG, __test.pngEncodeRGB(Buffer.alloc(W * H * 3, 255), W, H))

  /* ── ① 项目整链 + 同名覆盖 ─────────────────────────────────────────── */
  console.log('① --project 整链（base + overlay + attach），overlay 同名节点覆盖 base')
  const a1 = reco(['--project', dir, '--node-name', 'BaseDirect', '--image', PNG])
  const d1 = a1.env?.data
  check('A1a 退出 0', a1.code === 0, diag(a1))
  check("A1b data.layer === 'resource'", d1?.layer === 'resource', diag(a1))
  check("A1c resource.labels 深等于 ['base','overlay','attach']（整链，attach 在末尾）",
    j(d1?.resource?.labels) === j(['base', 'overlay', 'attach']),
    diag(a1) + ' paths=' + j(d1?.resource?.paths))
  check("A1d paramSource === 'node-name'（测的是项目里那份，不是手写节点）",
    d1?.paramSource === 'node-name', diag(a1))
  check("A1e nodeDump.recognition.type === 'ColorMatch'（overlay 覆盖生效）",
    d1?.nodeDump?.recognition?.type === 'ColorMatch', diag(a1))
  check('A1f results[0].ok === true（覆盖后的 ColorMatch 真跑通）',
    d1?.results?.[0]?.ok === true, diag(a1))

  /* ── ② 单包：overlay 不参与 ────────────────────────────────────────── */
  console.log('② --resource-dir resource/base 单包：同名节点回到 base 定义')
  const a2 = reco(['--resource-dir', BASE, '--node-name', 'BaseDirect', '--image', PNG])
  const d2 = a2.env?.data
  check('A2a 退出 0', a2.code === 0, diag(a2))
  check("A2b nodeDump.recognition.type === 'DirectHit'（单包，overlay 不参与）",
    d2?.nodeDump?.recognition?.type === 'DirectHit', diag(a2))
  check("A2c labels 只有 ['base'] 且 source === 'resource-dir'",
    j(d2?.resource?.labels) === j(['base']) && d2?.resource?.source === 'resource-dir', diag(a2))

  /* ── ③ attach 段进链 ──────────────────────────────────────────────── */
  console.log('③ attach 段是否进链：同一节点，整链跑得到 / 单包跑不到')
  const a3 = reco(['--project', dir, '--node-name', 'AttachOnlyProbe', '--image', PNG])
  const d3 = a3.env?.data
  check('A3a 退出 0（只在 attach 包里的节点，按原名跑得到）', a3.code === 0, diag(a3))
  check('A3b results[0].ok === true', d3?.results?.[0]?.ok === true, diag(a3))

  const a4 = reco(['--resource-dir', BASE, '--node-name', 'AttachOnlyProbe', '--image', PNG])
  check('A4a 退出 3（FINDINGS：跑成了，但链里没这个节点）', a4.code === 3, diag(a4))
  check("A4b error.code === 'RECO_NODE_MISSING'",
    a4.env?.error?.code === 'RECO_NODE_MISSING', diag(a4))

  /* ── ④ 能力边界：Custom 不是 miss ─────────────────────────────────── */
  console.log('④ --project 遇到 Custom 识别：报能力边界，不报成 miss')
  const a5 = reco(['--project', dir, '--node-name', 'CustomProbe', '--image', PNG])
  check('A5a 退出 3', a5.code === 3, diag(a5))
  check("A5b error.code === 'RECO_CUSTOM_NODE'（不是 RECO_NODE_MISSING）",
    a5.env?.error?.code === 'RECO_CUSTOM_NODE', diag(a5))

  /* ── ⑤ --node-file 的两种拒绝/接受 ────────────────────────────────── */
  console.log('⑤ --node-file：节点表要拒绝并指向 --node-name；JSONC 要读得动')
  const a6 = reco(['--node-file', NODETABLE, '--resource-dir', BASE, '--image', PNG])
  check('A6a 退出 2（参数错误）', a6.code === 2, diag(a6))
  check("A6b error.code === 'BAD_ARGUMENTS'", a6.env?.error?.code === 'BAD_ARGUMENTS', diag(a6))
  /* --json 只出信封（stdout 保持纯 JSON），提示语在 human 模式的 stderr 上：
   * 同一命令再跑一次不带 --json，验"给到人的提示确实指向 --node-name"。 */
  const a6h = run(['reco', '--node-file', NODETABLE, '--resource-dir', BASE, '--image', PNG])
  check('A6c stderr 含 --node-name（提示改走按原名跑）',
    /--node-name/.test(a6h.err), 'exit=' + a6h.code + ' stderr=' + j(a6h.err.trim()))

  const a7 = reco(['--node-file', ONENODE, '--resource-dir', BASE, '--image', PNG])
  const d7 = a7.env?.data
  check('A7a 退出 0（// 注释与尾随逗号都读得动）', a7.code === 0, diag(a7))
  check('A7b results[0].ok === true（DirectHit 真跑通）',
    d7?.results?.[0]?.ok === true, diag(a7))
  check("A7c paramSource === 'node-file'", d7?.paramSource === 'node-file', diag(a7))

  /* ── ⑥ 查无此节点：明确结论 + 可行动 hint ─────────────────────────── */
  console.log('⑥ --project 查无此节点：RECO_NODE_MISSING，hint 指向资源名/链')
  const a8 = reco(['--project', dir, '--node-name', 'NoSuchNode', '--image', PNG])
  check('A8a 退出 3', a8.code === 3, diag(a8))
  check("A8b error.code === 'RECO_NODE_MISSING'",
    a8.env?.error?.code === 'RECO_NODE_MISSING', diag(a8))
  /* hint 只出现在 human 输出的 stderr 上：跑一次同一命令（不带 --json）把它记下来给人看 */
  const a8h = run(['reco', '--project', dir, '--node-name', 'NoSuchNode', '--image', PNG])
  const hintLine = a8h.err.split(/\r?\n/).find((l) => l.includes('hint:'))
  console.log('  （hint）' + (hintLine ? hintLine.trim() : 'human stderr 里没有 hint 行'))

  /* ── ⑦ OCR 的空结果先查模型 ────────────────────────────────────────── */
  console.log('⑦ OCR 空结果：链上没有 model/ocr 时，原因指向模型而不是"roi 里没有字"')
  const a9 = reco(['--type', 'OCR', '--project', dir, '--image', PNG, '--param', '{"expected":"x"}'])
  const d9 = a9.env?.data
  check('A9a 退出 0（OCR 跑完了，只是未命中）', a9.code === 0, diag(a9))
  check('A9b missReason 指向 "OCR 模型不在资源链里"',
    /OCR 模型不在资源链里/.test(String(d9?.missReason)), diag(a9) + ' missReason=' + j(d9?.missReason))
  check('A9c rawCount === 0（空结果确实是空结果）', d9?.rawCount === 0, diag(a9))

  /* ── ⑧ 近邻节点名：真 node_list 上的编辑距离 ───────────────────────── */
  console.log('⑧ --node-name 拼错一个字：近邻建议来自真实 node_list（不是桩里塞的 candidates）')
  const a10 = reco(['--project', dir, '--node-name', 'BaseDirec', '--image', PNG])
  const d10 = a10.env?.data
  check('A10a 退出 3', a10.code === 3, diag(a10))
  check("A10b error.code === 'RECO_NODE_MISSING'",
    a10.env?.error?.code === 'RECO_NODE_MISSING', diag(a10))
  check("A10c 回执 candidates 含 'BaseDirect'（编辑距离 1）",
    j(d10?.candidates).includes('BaseDirect'), diag(a10) + ' candidates=' + j(d10?.candidates))
  const a10h = run(['reco', '--project', dir, '--node-name', 'BaseDirec', '--image', PNG])
  check('A10d human hint 指向 BaseDirect',
    /最接近的节点名：BaseDirect/.test(a10h.err),
    'stderr=' + j(a10h.err.trim().split(/\r?\n/).slice(-2).join(' / ')))

  /* ── ⑨ dump 再 --node-file 与 --node-name 等价 ─────────────────────── */
  console.log('⑨ 等价性：把 nodeDump 落成文件再 --node-file，hit / box 与 --node-name 一致')
  const byName = reco(['--project', dir, '--node-name', 'BaseDirect', '--image', PNG])
  const dump = byName.env?.data?.nodeDump
  check('A11a 取到 nodeDump', !!dump && typeof dump === 'object', diag(byName))
  const dumpFile = path.join(dir, 'dump-node.json')
  fs.writeFileSync(dumpFile, JSON.stringify(dump, null, 2))
  const byFile = reco(['--node-file', dumpFile, '--resource-dir', BASE, '--image', PNG])
  const d11 = byFile.env?.data
  const r11 = d11?.results?.[0]
  const r11n = byName.env?.data?.results?.[0]
  check('A11b --node-file 跑 dump 退出 0', byFile.code === 0, diag(byFile))
  check('A11c hit 相同', r11?.ok === r11n?.ok, diag(byFile) + ' byName ok=' + j(r11n?.ok) + ' byFile ok=' + j(r11?.ok))
  check('A11d box 相同',
    j(r11?.detail?.box) === j(r11n?.detail?.box),
    diag(byFile) + ' byName box=' + j(r11n?.detail?.box) + ' byFile box=' + j(r11?.detail?.box))

  /* ── ⑩ And 里嵌的 Custom 也是能力边界 ─────────────────────────────── */
  console.log('⑩ And 里嵌 Custom 子识别：同样报能力边界，不落回 miss')
  const a12 = reco(['--project', dir, '--node-name', 'NestedCustom', '--image', PNG])
  const d12 = a12.env?.data
  check('A12a 退出 3', a12.code === 3, diag(a12))
  check("A12b error.code === 'RECO_CUSTOM_NODE'（不是 miss / 不是调用报错）",
    a12.env?.error?.code === 'RECO_CUSTOM_NODE', diag(a12))
  check('A12c 回执 customPaths 指向嵌套位置',
    j(d12?.customPaths).includes('all_of'), diag(a12) + ' customPaths=' + j(d12?.customPaths))

  /* ── ⑪ 参数值里的 "Custom" 不是 Custom 识别 ─────────────────────────── */
  console.log('⑪ OCR 的 expected 恰好是 "Custom"：不能被认成 Custom 子识别')
  const a13 = reco(['--project', dir, '--node-name', 'ExpectedCustomText', '--image', PNG])
  const d13 = a13.env?.data
  check('A13a 退出 0（OCR 正常跑完，只是未命中）', a13.code === 0, diag(a13))
  check('A13b 没有 RECO_CUSTOM_NODE（参数值不是识别类型位）',
    a13.env?.error?.code !== 'RECO_CUSTOM_NODE', diag(a13))
  check('A13c missReason 指向 OCR 模型缺失',
    /OCR 模型不在资源链里/.test(String(d13?.missReason)), diag(a13) + ' missReason=' + j(d13?.missReason))
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\nreco --node-name / 整条资源链：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
