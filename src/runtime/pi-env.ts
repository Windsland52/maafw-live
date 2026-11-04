/**
 * agent 子进程的 `PI_*` 环境变量（PI v2.5.0 起）。
 *
 * 为什么需要这一层：项目里的 agent 常用 `PI_CONTROLLER` / `PI_RESOURCE` / `PI_CLIENT_MAAFW_VERSION`
 * 决定"选哪套资源、用哪种语言、能不能跑"。不注入时它们**不报错**——直接落到 agent 自带的默认值，
 * 于是任务"跑通了，但不是同一个东西"。协议用规范性"应"要求 Client 注入，同时允许逐项缺省，
 * 所以这里只填拿得到值的项：拿不到就不写，不编默认值。
 *
 * 出处：MaaFramework 5.14.2 `3.3-ProjectInterfaceV2协议` 环境变量表
 * （pinned commit 8061d5bcaa3f07afcc1008795913663f64de46c8）。5.14.2 共 8 个变量；
 * `PI_USER_DATA_DIR` 是 PI v2.11.0 / MaaFW 5.15.0 才引入的，本仓锁 5.14.2，**不要**加。
 *
 * 已知偏差：本工具不解析 i18n 的 `$` 键，所以 `PI_CONTROLLER` / `PI_RESOURCE` 里的
 * label / description 可能是原始 `$key` 而不是展示文本（协议要求已解析）。项目没配
 * `languages` 时不存在这个问题；i18n 落地后这里要跟着改。
 */
import type { LoadedInterface } from '../interface/load.js'
import { cliPackage, maaNodeVersion } from '../pkg.js'

/**
 * 本工具**实际兑现**的 PI 能力版本。
 *
 * 不写"最新"：这个值给 agent 判特性用，谎报会让它以为没实现的行为存在。
 * 当前兑现到 v2.5.0：option 四级链 / preset / import / `attach_resource_path` /
 * option 适用性过滤都在；pretask（v2.7）已实现，但 **v2.6 的 resource.hash 一致性校验
 * 还没有**，按版本序不能跳过它去报 v2.7。hash 落地后**必须**一起抬这个值。
 */
const PI_INTERFACE_VERSION = 'v2.5.0'

/** 本 CLI 的人类输出固定中文、没有 UI 语言切换——按协议示例的 `zh_cn` 形态如实报。 */
const PI_CLIENT_LANGUAGE = 'zh_cn'

export interface PiEnvInput {
  loaded: LoadedInterface
  controllerName: string | null
  resourceName: string | null
}

/** 生成要注入 agent 子进程的环境变量；返回空对象表示本次没有可注入的项。 */
export function buildAgentEnv(i: PiEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    PI_INTERFACE_VERSION,
    PI_CLIENT_NAME: 'maafw-live',
    PI_CLIENT_VERSION: cliPackage().version,
    PI_CLIENT_LANGUAGE,
  }
  const maafw = maaNodeVersion()
  if (maafw) env.PI_CLIENT_MAAFW_VERSION = maafw
  /* 顶层 version 是**项目**版本（不是 interface_version=2） */
  if (i.loaded.projectVersion) env.PI_VERSION = i.loaded.projectVersion
  const c = i.controllerName ? i.loaded.controllers.find((x) => x.name === i.controllerName) : undefined
  if (c && c.raw !== undefined) env.PI_CONTROLLER = JSON.stringify(c.raw)
  const r = i.resourceName ? i.loaded.resources.find((x) => x.name === i.resourceName) : undefined
  if (r && r.raw !== undefined) env.PI_RESOURCE = JSON.stringify(r.raw)
  return env
}
