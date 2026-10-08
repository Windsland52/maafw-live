#!/usr/bin/env node
/**
 * 验收（离线，**不需要设备**）：从关键帧库留存帧裁出 L2 派生图。
 *
 * 这条动线的存在理由（契约 §1"留得住"/§2 图像分级）：不可复现状态在观测到的那一刻就该升格，
 * 等回头要模板时，那次捕获的 L0 早已不在进程态热缓存里——但它在库里以"文件 + 登记记录"存在，
 * 而库内 L0 就是原图本体。所以从库帧裁剪必须满足：
 *
 *  - **不需要设备**：留存帧是本机持久文件；设备此刻在哪个画面都与这次裁剪无关。
 *  - **L0 永不修改**：裁剪只读库帧，L2 落在别处（契约 §2）。
 *  - **身份可复核**：裁剪前校 sha256 与像素尺寸——解析与读取之间被替换的字节不许当依据。
 *  - **L2 带出处**：`<out>.prov.json` 记来源 + 裁剪变换，且不带设备来源（契约 §5 / §4.1）。
 *
 * 覆盖：
 *  K1 库帧可作裁剪源：源身份是完整 kf ID、尺寸取自像素、seq 为 null（不是热缓存帧序）
 *  K2 自匹配闭环在库帧上照跑（位置正确 + 得分）
 *  K3 L2 出处落盘、与回执一致、transform 记录真实裁剪框
 *  K4 L0 原图字节与库目录均未被改动（只读源）
 *  K5 未连接设备：空间比对如实报 null（不冒称已核对当前控制器尺寸）
 *  K6 库帧路径缺省不做跨帧验证（留存帧对应的状态通常已不在画面上）
 *  K7 解析后文件被替换 → 拒绝（sha256 第二道确认）
 *  K8 库记录尺寸与像素不一致 → 拒绝
 *  K9 prov:false 不写侧车
 *  C1 CLI 一行命令走通（--from-kf + --project，全程无设备），退出 0 且信封带 provenance
 *  C2 --from-kf 与 --seq 互斥 → 退出 2
 *  C3 库存无此 ID → 退出 3（FINDINGS）且错误码 KF_MISSING
 *  S1 库帧离线候选（annotate --from-kf）：源身份、控制器坐标、diff 源如实报不可用
 *  S2 候选路径复用同一套三层校验（替换后拒绝）
 *  S3 CLI 级 annotate --from-kf 走通；与 --seq 互斥
 *
 * 前置：npm run build（本脚本走 lib/ 与 bin/，与已发布的运行路径一致）。
 * 用法：node scripts/accept-crop-fromkf.mjs
 * 耗时：每次裁剪会起若干识别子进程做自匹配（十几次），整套约 1-3 分钟。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnDaemon } from '../lib/client/daemon.js'
import { __test } from '../lib/daemon/framed.mjs'

const { pngEncodeRGB } = __test
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BIN = path.join(ROOT, 'bin', 'maafw-live.mjs')
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`) }
}

/** 1280x720 的类 UI 画面：深底 + 若干结构化面板 + 逐像素噪声（模板要有纹理才定位得到自己） */
function scenePng() {
  const w = 1280, h = 720
  const rgb = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const n = ((x * 7 + y * 13) % 23) - 11
      rgb[i] = 24 + Math.floor((y * 40) / h) + n
      rgb[i + 1] = 28 + Math.floor((x * 30) / w) + n
      rgb[i + 2] = 36 + n
    }
  }
  const panel = (px, py, pw, ph, r, g, b) => {
    for (let y = py; y < py + ph; y++) {
      for (let x = px; x < px + pw; x++) {
        const i = (y * w + x) * 3
        const stripe = ((x - px) % 9 < 2 && (y - py) % 7 < 3) ? 60 : 0
        rgb[i] = Math.min(255, r + stripe + ((x * 3 + y) % 17))
        rgb[i + 1] = Math.min(255, g + stripe + ((x + y * 5) % 13))
        rgb[i + 2] = Math.min(255, b + stripe + ((x * 11 + y * 2) % 19))
      }
    }
  }
  panel(120, 160, 200, 96, 90, 150, 210)   // 目标面板（ROI 覆盖它）
  panel(600, 90, 260, 150, 190, 90, 120)
  panel(420, 430, 300, 140, 80, 190, 130)
  return pngEncodeRGB(rgb, w, h)
}

/** 最小项目：interface.json + 资源目录（自匹配要加载资源，离线解析走这一份声明） */
function makeProject(root) {
  const dir = path.join(root, 'project')
  fs.mkdirSync(path.join(dir, 'res', 'pipeline'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'res', 'pipeline', 'dummy.json'), JSON.stringify({
    Dummy: { recognition: 'ColorMatch', lower: [0, 0, 0], upper: [255, 255, 255], action: 'DoNothing' },
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'interface.json'), JSON.stringify({
    interface_version: 2,
    name: 'accept-crop-fromkf',
    controller: [{ name: 'C1', type: 'Adb' }],
    resource: [{ name: 'R1', path: 'res' }],
    task: [{ name: 'T1', entry: 'Dummy' }],
  }, null, 2))
  return dir
}

/** 建一个最小库：manifest + l0/0001.png（内容是真画面，尺寸即"控制器分辨率"） */
function makeLib(root, name, { shaOverride, dims } = {}) {
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, 'l0'), { recursive: true })
  const png = scenePng()
  const file = 'l0/0001.png'
  fs.writeFileSync(path.join(dir, file), png)
  const libId = '11111111-2222-4333-8444-55555555555' + String(name.length % 10)
  const rec = {
    id: 'kf:' + libId + ':0001',
    file, sha256: shaOverride ?? sha(png),
    session: { daemon: 'accept-crop-fromkf', gen: 1, kind: 'adb', target: 'sim' },
    capturedAt: '2026-10-05T10:00:00.000Z',
    captureSeq: 7, ctrlW: dims?.w ?? 1280, ctrlH: dims?.h ?? 720,
    smallW: 480, smallH: 270, scale: 0.375, source: 'explicit', note: null,
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schema: 1, libraryId: libId, next: 2, frames: [rec] }, null, 2))
  return { dir, png, rec, kfSource: { id: rec.id, path: path.join(dir, file), sha256: rec.sha256, ctrlW: rec.ctrlW, ctrlH: rec.ctrlH, captureSeq: rec.captureSeq, capturedAt: rec.capturedAt } }
}

const listFiles = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort()
const ROI = [100, 140, 240, 136]   // 比目标面板略大的宽松框（snap 有收紧余地）

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maafw-cropkf-'))
  const outDir = path.join(root, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const project = makeProject(root)
  const c = spawnDaemon({ runDir: path.join(root, 'run') })
  const crop = (lib, extra = {}) => c.call('tpl_crop', {
    kfSource: lib.kfSource, roi: ROI, resourceDir: path.join(project, 'res'),
    out: path.join(outDir, 'tpl.png'), ...extra,
  }, 240000)

  try {
    console.log('K 组：库帧 → L2 派生图（离线，无设备）')
    const lib = makeLib(root, 'libA')
    const before = {
      sha: sha(fs.readFileSync(path.join(lib.dir, lib.rec.file))),
      files: listFiles(lib.dir),
    }
    const r = await crop(lib)
    check('K1a 库帧裁剪成功', r.ok === true, JSON.stringify(r).slice(0, 300))
    if (r.ok !== true) throw new Error('后续用例依赖一次成功的裁剪：' + JSON.stringify(r))
    check('K1b 源身份是完整 kf ID', r.source?.kind === 'kf' && r.source?.id === lib.rec.id, JSON.stringify(r.source))
    check('K1c seq 为 null（不是热缓存帧序）', r.seq === null, 'seq=' + JSON.stringify(r.seq))
    check('K1d 尺寸取自像素（与库记录一致）', r.ctrlW === 1280 && r.ctrlH === 720 && r.source.ctrlW === 1280, `${r.ctrlW}x${r.ctrlH}`)
    check('K2a 自匹配位置正确', r.positionOk === true, 'best=' + JSON.stringify(r.selfMatchBox ?? null) + ' score=' + r.score)
    check('K2b 自匹配得分高', Number(r.score) >= 0.9, 'score=' + r.score)
    check('K2c 模板尺寸 = 裁剪框尺寸', r.w === r.box[2] && r.h === r.box[3], `${r.w}x${r.h} vs ${JSON.stringify(r.box)}`)
    check('K2d 裁剪框落在宽松框内（snap/精修不越界）', r.box[0] >= ROI[0] && r.box[1] >= ROI[1] &&
      r.box[0] + r.box[2] <= ROI[0] + ROI[2] && r.box[1] + r.box[3] <= ROI[1] + ROI[3],
      JSON.stringify(r.box) + ' vs ' + JSON.stringify(ROI))

    const provPath = path.join(outDir, 'tpl.png.prov.json')
    check('K3a L2 出处落在模板旁边', r.provPath === provPath && fs.existsSync(provPath), String(r.provPath))
    const prov = JSON.parse(fs.readFileSync(provPath, 'utf8'))
    check('K3b 侧车与回执一致（一份事实两处可见）', JSON.stringify(prov) === JSON.stringify(r.provenance))
    check('K3c 出处记来源身份', prov.derivedFrom?.kind === 'kf' && prov.derivedFrom?.id === lib.rec.id &&
      prov.derivedFrom?.sha256 === lib.rec.sha256, JSON.stringify(prov.derivedFrom))
    check('K3d 出处记真实裁剪变换（无缩放、无重采样）',
      prov.transform?.op === 'crop' && prov.transform?.resize === false && prov.transform?.scale === 1 &&
      JSON.stringify(prov.transform?.crop) === JSON.stringify(r.box) &&
      JSON.stringify(prov.transform?.loose) === JSON.stringify(r.loose),
      JSON.stringify(prov.transform))
    check('K3e 出处不带设备来源（本地来源留在库 manifest）',
      !/127\.0\.0\.1|sim|accept-crop-fromkf/.test(JSON.stringify(prov)), JSON.stringify(prov.derivedFrom))
    check('K4a L0 原图字节未被改动', sha(fs.readFileSync(path.join(lib.dir, lib.rec.file))) === before.sha)
    check('K4b 库目录没多出文件（裁剪产物不落库）',
      JSON.stringify(listFiles(lib.dir)) === JSON.stringify(before.files), listFiles(lib.dir).join(','))
    check('K5 未连接设备：空间比对如实为 null（不冒称已核对）',
      r.spaceCheck?.current === null && r.spaceCheck?.match === null, JSON.stringify(r.spaceCheck))
    check('K6 库帧路径缺省不做跨帧验证', r.cross === undefined, JSON.stringify(r.cross))

    /* K7 解析之后文件被替换：sha 层必须拦下，不许拿新字节当依据 */
    const tampered = makeLib(root, 'libB')
    fs.writeFileSync(path.join(tampered.dir, tampered.rec.file), scenePng().subarray(0, 20000))
    const r7 = await crop(tampered, { out: path.join(outDir, 'tpl7.png') })
    check('K7 解析后文件被替换 → 拒绝', r7.ok === false && /sha256/.test(String(r7.error)), JSON.stringify(r7).slice(0, 200))

    /* K8 库记录尺寸与像素不同源 */
    const wrongDims = makeLib(root, 'libC', { dims: { w: 1920, h: 1080 } })
    const r8 = await crop(wrongDims, { out: path.join(outDir, 'tpl8.png') })
    check('K8 库记录尺寸≠像素尺寸 → 拒绝', r8.ok === false && /不一致/.test(String(r8.error)), JSON.stringify(r8).slice(0, 200))

    /* K9 prov:false 不写侧车（回执里也不给路径） */
    const r9 = await crop(lib, { out: path.join(outDir, 'tpl9.png'), prov: false })
    check('K9 prov:false 不写侧车', r9.ok === true && r9.provPath === null && !fs.existsSync(path.join(outDir, 'tpl9.png.prov.json')),
      JSON.stringify({ provPath: r9.provPath }))

    /* K10 空资源包（没有任何 pipeline）：自匹配起不来，必须**如实归因到资源**而不是"低纹理/不独特"。
     * 这两件事的处置完全相反（去修资源 vs 去换框），混在一起会把人引到错的路上。
     * 实测来源：真机上 resource/pipeline/ 还是空的时候，crop 报了"低纹理"（见 roadmap 第十九轮）。 */
    const emptyRes = path.join(root, 'empty-res')
    fs.mkdirSync(emptyRes, { recursive: true })
    const r10 = await crop(lib, { resourceDir: emptyRes, out: path.join(outDir, 'tpl10.png') })
    const w10 = [...(r10.warns ?? []), ...(r10.warn ? [r10.warn] : [])].join(' | ')
    check('K10a 空资源包仍出图（裁剪本身不需要资源）', r10.ok === true && fs.existsSync(path.join(outDir, 'tpl10.png')),
      JSON.stringify(r10).slice(0, 200))
    check('K10b 警告如实说"自匹配没跑起来"', /自匹配没跑起来/.test(w10), w10)
    check('K10c 不再把它归因成"低纹理/不独特"', !/低纹理/.test(w10), w10)
    check('K10d 如实报未经验证（positionOk=false、无 best）',
      r10.positionOk === false && r10.selfMatchBox === undefined, JSON.stringify({ p: r10.positionOk, b: r10.selfMatchBox }))

    /* K11 出处落点可改：provOut 把侧车写到指定目录（同名、自动建目录）——模板进资源包、
     * 出处留包外的项目靠它（框架会把资源包整目录打包发给用户；出处是过程资产）。
     * 不变量从"同一目录"变成"同一相对路径"。 */
    const provDir = path.join(root, 'prov-out')
    const r11 = await crop(lib, { out: path.join(outDir, 'tpl11.png'), provOut: provDir })
    check('K11a 出处落在指定目录下（同名）',
      r11.provPath === path.join(provDir, 'tpl11.png.prov.json') && fs.existsSync(r11.provPath), String(r11.provPath))
    check('K11b 模板旁不再有侧车', !fs.existsSync(path.join(outDir, 'tpl11.png.prov.json')),
      JSON.stringify(listFiles(outDir).filter((f) => f.includes('tpl11'))))
    check('K11c 回执 provenance 与文件逐字段一致',
      JSON.stringify(JSON.parse(fs.readFileSync(r11.provPath, 'utf8'))) === JSON.stringify(r11.provenance))

    console.log('C 组：CLI 一行命令（--from-kf，全程无设备）')
    const cliOut = path.join(outDir, 'cli.png')
    const cli = spawnSync(process.execPath, [
      BIN, 'crop', '--from-kf', lib.rec.id, '--frames-dir', lib.dir,
      '--roi', ROI.join(','), '--project', project, '--out', cliOut, '--json',
    ], { encoding: 'utf8' })
    let env = null
    try { env = JSON.parse(cli.stdout) } catch { /* 下面断言会报出来 */ }
    check('C1a CLI 退出 0（无警告）', cli.status === 0, `status=${cli.status} ${String(cli.stderr).slice(0, 200)}`)
    check('C1b 信封 data 带 provenance 与侧车路径',
      env?.data?.provenance?.derivedFrom?.id === lib.rec.id && fs.existsSync(cliOut + '.prov.json'),
      JSON.stringify(env?.data?.provPath))
    check('C1c 未连接设备也能解析项目资源（离线解析 interface.json）',
      env?.data?.source?.kind === 'kf' && env?.data?.spaceCheck?.current === null, JSON.stringify(env?.data?.source))
    check('C1d written 列出模板与出处两个文件',
      Array.isArray(env?.written) && env.written.includes(cliOut) && env.written.includes(cliOut + '.prov.json'),
      JSON.stringify(env?.written))

    /* C1e CLI 的 --prov-out：出处写到指定目录（并且 written 里如实列出它） */
    const cliProvOut = path.join(root, 'cli-prov')
    const cli2Out = path.join(outDir, 'cli2.png')
    const cli2 = spawnSync(process.execPath, [
      BIN, 'crop', '--from-kf', lib.rec.id, '--frames-dir', lib.dir,
      '--roi', ROI.join(','), '--project', project, '--out', cli2Out, '--prov-out', cliProvOut, '--json',
    ], { encoding: 'utf8' })
    let env2 = null
    try { env2 = JSON.parse(cli2.stdout) } catch { /* 下面断言会报出来 */ }
    check('C1e CLI --prov-out：出处落在指定目录、模板旁没有',
      cli2.status === 0 && env2?.data?.provPath === path.join(cliProvOut, 'cli2.png.prov.json') &&
      fs.existsSync(env2?.data?.provPath) && !fs.existsSync(cli2Out + '.prov.json'),
      `status=${cli2.status} provPath=${env2?.data?.provPath}`)

    const clash = spawnSync(process.execPath, [
      BIN, 'crop', '--from-kf', lib.rec.id, '--seq', '3', '--roi', ROI.join(','), '--resource-dir', path.join(project, 'res'), '--json',
    ], { encoding: 'utf8' })
    let clashEnv = null
    try { clashEnv = JSON.parse(clash.stdout) } catch { /* ignore */ }
    check('C2 --from-kf 与 --seq 互斥 → 退出 2 / BAD_ARGUMENTS',
      clash.status === 2 && clashEnv?.error?.code === 'BAD_ARGUMENTS', `status=${clash.status} code=${clashEnv?.error?.code}`)

    const missing = spawnSync(process.execPath, [
      BIN, 'crop', '--from-kf', 'kf:99999999-0000-4000-8000-000000000009:0001', '--frames-dir', lib.dir,
      '--roi', ROI.join(','), '--resource-dir', path.join(project, 'res'), '--json',
    ], { encoding: 'utf8' })
    let missEnv = null
    try { missEnv = JSON.parse(missing.stdout) } catch { /* ignore */ }
    check('C3 库内无此 ID → 退出 3 / KF_MISSING（本机不可复核，不代表从未观测）',
      missing.status === 3 && missEnv?.error?.code === 'KF_MISSING', `status=${missing.status} code=${missEnv?.error?.code}`)

    console.log('R 组：reco 的离线库帧入口（--from-kf / --image kf:，同样不需要设备）')
    /* 模板故意不存在：这正是 roadmap 那条"未解释的间歇"的签名——识别跑了但拿不到任何置信度 */
    const recoNode = JSON.stringify({
      recognition: { type: 'TemplateMatch', param: { template: 'NoSuchTemplate.png', roi: [0, 0, 40, 40], threshold: 0.85 } },
    })
    const r1 = spawnSync(process.execPath, [
      BIN, 'reco', '--node', recoNode, '--from-kf', lib.rec.id, '--frames-dir', lib.dir,
      '--resource-dir', path.join(project, 'res'), '--json',
    ], { encoding: 'utf8' })
    let r1env = null
    try { r1env = JSON.parse(r1.stdout) } catch { /* 下面断言会报出来 */ }
    check('R1a --from-kf 离线跑通：退出 0、1 例、源身份是库帧（无设备）',
      r1.status === 0 && r1env?.data?.results?.length === 1 && r1env?.data?.meta?.source === lib.rec.id,
      `status=${r1.status} meta=${JSON.stringify(r1env?.data?.meta)}`)
    check('R1b 拿不到分数 → 第三形态标记（与"分数低的未命中"分开）',
      r1env?.data?.noConfidence === true && r1env?.data?.results?.[0]?.ok === false,
      JSON.stringify({ noConfidence: r1env?.data?.noConfidence, ok: r1env?.data?.results?.[0]?.ok }))
    const r1plain = spawnSync(process.execPath, [
      BIN, 'reco', '--node', recoNode, '--from-kf', lib.rec.id, '--frames-dir', lib.dir,
      '--resource-dir', path.join(project, 'res'),
    ], { encoding: 'utf8' })
    check('R1c 人类输出把第三形态说清楚（别让人当成"画面不匹配"去调阈值）',
      /未返回任何置信度/.test(r1plain.stdout) && !/模板与该画面不匹配/.test(r1plain.stdout),
      String(r1plain.stdout).slice(-240))

    const r2 = spawnSync(process.execPath, [
      BIN, 'reco', '--node', recoNode, '--image', lib.rec.id, '--frames-dir', lib.dir,
      '--resource-dir', path.join(project, 'res'), '--json',
    ], { encoding: 'utf8' })
    let r2env = null
    try { r2env = JSON.parse(r2.stdout) } catch { /* ignore */ }
    check('R2 --image kf:… 是等价入口（SKILL / roadmap 记过的写法）',
      r2.status === 0 && r2env?.data?.meta?.source === lib.rec.id, `status=${r2.status}`)

    const r3 = spawnSync(process.execPath, [
      BIN, 'reco', '--node', recoNode, '--from-kf', lib.rec.id, '--frames-dir', lib.dir, '--seq', '3',
      '--resource-dir', path.join(project, 'res'), '--json',
    ], { encoding: 'utf8' })
    let r3env = null
    try { r3env = JSON.parse(r3.stdout) } catch { /* ignore */ }
    check('R3 --from-kf 与 --seq 互斥 → 退出 2 / BAD_ARGUMENTS',
      r3.status === 2 && r3env?.error?.code === 'BAD_ARGUMENTS', `status=${r3.status}`)

    console.log('S 组：库帧离线候选（annotate --from-kf，同样不需要设备）')
    const somOut = path.join(outDir, 'som.png')
    const s1 = await c.call('annotate', { kfSource: lib.kfSource, out: somOut }, 120000)
    check('S1a 库帧候选成功并落盘', s1.ok === true && fs.existsSync(somOut), JSON.stringify(s1).slice(0, 200))
    check('S1b 源身份是 kf、seq 为 null（不是会话内帧）',
      s1.source?.kind === 'kf' && s1.source?.id === lib.rec.id && s1.seq === null, JSON.stringify(s1.source))
    check('S1c 有候选且每个带控制器坐标',
      Array.isArray(s1.candidates) && s1.candidates.length > 0 &&
      s1.candidates.every((x) => Array.isArray(x.ctrl) && x.ctrl.length === 4),
      'count=' + s1.count)
    check('S1d 库帧本就是控制器空间：换算系数为 1（box 与 ctrl 相同）',
      JSON.stringify(s1.candidates[0].box) === JSON.stringify(s1.candidates[0].ctrl),
      JSON.stringify(s1.candidates[0]))
    check('S1e 如实报 diff 源不可用（没有会话事件，不拿别的区域顶替）',
      typeof s1.sourcesUnavailable?.diff === 'string' && s1.sources?.diff === 0, JSON.stringify(s1.sourcesUnavailable))

    const kfTampered = makeLib(root, 'libS')
    fs.writeFileSync(path.join(kfTampered.dir, kfTampered.rec.file), scenePng().subarray(0, 20000))
    const s2 = await c.call('annotate', {
      kfSource: kfTampered.kfSource, out: path.join(outDir, 'som2.png'),
    }, 120000)
    check('S2 解析后文件被替换 → 拒绝（与裁剪同一套三层校验）',
      s2.ok === false && /sha256/.test(String(s2.error)), JSON.stringify(s2).slice(0, 200))

    const somCli = spawnSync(process.execPath, [
      BIN, 'annotate', '--from-kf', lib.rec.id, '--frames-dir', lib.dir, '--out', path.join(outDir, 'cli-som.png'), '--json',
    ], { encoding: 'utf8' })
    let somEnv = null
    try { somEnv = JSON.parse(somCli.stdout) } catch { /* 下面断言会报出来 */ }
    check('S3a CLI --from-kf 退出 0 且带 source/candidates',
      somCli.status === 0 && somEnv?.data?.source?.kind === 'kf' && somEnv?.data?.count > 0,
      `status=${somCli.status} ${String(somCli.stderr).slice(0, 160)}`)
    check('S3b written 列出回画 PNG', Array.isArray(somEnv?.written) && somEnv.written.includes(path.join(outDir, 'cli-som.png')))

    const somClash = spawnSync(process.execPath, [
      BIN, 'annotate', '--from-kf', lib.rec.id, '--seq', '2', '--out', path.join(outDir, 'cli-som2.png'), '--json',
    ], { encoding: 'utf8' })
    let clashSom = null
    try { clashSom = JSON.parse(somClash.stdout) } catch { /* ignore */ }
    check('S3c --from-kf 与 --seq 互斥 → 退出 2 / BAD_ARGUMENTS',
      somClash.status === 2 && clashSom?.error?.code === 'BAD_ARGUMENTS', `status=${somClash.status}`)
  } finally {
    try { c.close() } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

await main()
console.log(`\nK/C/R/S 组：${pass} 过 / ${fail} 败`)
/* 用 exitCode 让 stdout 自然排空：process.exit 在管道里会丢掉还没落地的汇总与 FAIL 行
 * （survey 脚本与 accept-emulator 踩过同一个坑——失败行丢了就看不出是哪条失败） */
process.exitCode = fail ? 1 : 0
