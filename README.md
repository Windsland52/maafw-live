# maafw-live

给 AI agent 的 MaaFramework **实时观测与设备交互底座**：常驻 daemon 提供连续帧流、变化/稳定检测与
环形缓冲；确定性 CLI 以稳定 JSON 输出观测与交互能力，节点和识别参数靠实际运行测量。

解决 AI agent 使用 MaaFramework 的两大痛点：

- **看不到现场。** 此前没有面向模型的实时观测方案，agent 只能「截一帧、猜、再截一帧」。daemon 持续采样：帧流随时可取，画面变化/稳定有事件可订阅，历史帧有环形缓冲兜底。观测以事件与数字交付，像素默认不出 daemon——纯文本模型同样可用，要看画面时再按 seq / ROI 精确获取。
- **写不准识别。** 模板、roi、阈值、wait_freezes/delay 靠猜多半不准，而它们都能实测：识别单测与阈值扫描（`reco`）、模板裁剪（`crop`，裁后自匹配复核——判据为 best 落回裁剪处优先于得分，纯色模板的 CCOEFF_NORMED 得分是噪声）、探色（`color`）、实测节点时长与稳定时间（`timing`）；没有模板时，候选区域编号回画、选号即得坐标（`annotate`）。

CLI 面向 agent、脚本与人：命令是确定性的，输出有稳定 JSON 信封；daemon 协议与客户端不绑定任何
宿主，编辑器插件、自动化平台、CI 都能直接接。连续观测到的帧可选择性地留存为跨工作会话证据——
契约见 [`docs/keyframe-retention-contract-v0.md`](docs/keyframe-retention-contract-v0.md)。

## 三件东西

| 部分 | 位置 | 做什么 |
| --- | --- | --- |
| daemon | `src/daemon/framed.mjs` | 独立子进程，持有 Controller / Resource / Tasker、帧流与环形缓冲；说 JSON 行协议 |
| client | `maafw-live/client` | 可复用客户端：spawn、应答配对、超时硬杀自愈、帧 / 事件 / 原生日志汇聚 |
| CLI | `bin/maafw-live.mjs` | 命令面：探针、设备、输入、识别、会话 |

协议的完整契约（消息形状、命令表、坐标系与稳定性约定）见 [`docs/daemon-protocol.md`](docs/daemon-protocol.md)。

## 安装

```bash
npm install
npm run build
npm link            # 之后可直接 maafw-live --help
```

需要 Node >= 22.13；`@maaxyz/maa-node` 会在安装时按平台取对应的原生包。

## 命令

| 命令 | 说明 |
| --- | --- |
| `maafw-live env` | 探测环境与能力：项目根、pipeline 目录、运行时绑定、外部工具（adb / python / git） |
| `maafw-live version` | 打印 CLI 与依赖版本 |
| `maafw-live probe` | 自检运行时：绑定版本、adb / win32 设备发现数 |
| `maafw-live device` | 列出可连接的设备（adb 设备与 win32 窗口） |
| `maafw-live connect` | 连接设备（进程态；多步操作用 repl） |
| `maafw-live disconnect` | 断开并销毁 Tasker / Controller |
| `maafw-live screencap` | 截一帧并落盘（同时进 L0 缓存，有捕获身份可升格） |
| `maafw-live frame` | 帧流状态与历史帧取用（可带 ROI，按该帧捕获时尺寸换算） |
| `maafw-live run` | 运行 pipeline；项目模式合成 pipeline_override 四级链；`--timeout 0` 不自动停；退出码按任务级 `record.ok` |
| `maafw-live stop` | 停止运行中的任务 |
| `maafw-live click` / `swipe` / `key` / `keys` / `press` / `dbclick` / `scroll` / `move` / `text` | 输入注入（经 maafw 控制器本体；动作边界帧自动入 L0 锚区） |
| `maafw-live reco` | 识别单测（子进程隔离）：`--param`/`--sweep` 阈值扫描，`--node` 整节点透传（V1/V2），`--act` 识别拿框 → 真机执行动作半 |
| `maafw-live color` | 探色：ROI 实测均值 / HSV / 主色，选色后用 reco ColorMatch 出框 |
| `maafw-live crop` | 模板裁剪：宽松框或点 → snap 收紧 → L0 原图裁剪 → 同帧自匹配逐边精修 + 跨帧验证 |
| `maafw-live annotate` | 轻量 SoM：OCR / diff / 连通域 / 边缘密度候选区域 + 编号回画（模型选号 → ctrl 坐标） |
| `maafw-live calibrate` | 变化检测阈值校准：静止画面定噪声地板，推荐 blockThresh / changeGlobal |
| `maafw-live timing` | 跑任务反推 timeout / wait_freezes / delay 建议：节点时长 + 动作后画面稳定时间；`--runs n`（1-10）多次采样取 P50/P95 分布 |
| `maafw-live kf` | 关键帧：status 看 L0 缓存，promote 升格原图进本地库，list / resolve 离线解析 |
| `maafw-live repl` | 交互 / 管道会话：连接一次，命令复用 |

`env` 是前置命令：动手前先问它「现在有什么」，而不是各自写一遍环境检测。它有一条硬要求——
**自身永远不能因为环境残缺而失败**，缺依赖都是探测结果，不是错误。

它按**应用开发者视角**探测：写 Maa 应用的人不需要 clone 框架源码，所以默认结果里没有框架源码项。
只有显式给 `--checkout <MaaFramework 源码目录>`（或环境变量 `MAAFW_CHECKOUT`）时才追加一项版本
对账（native 绑定 vs checkout 里的 schema），供框架开发与静态校验使用。

## 连接：优先 `--project`

两种连法：

- `--project <dir>`（推荐）：读项目 `interface.json` 的 `controller[]` —— 控制器类型、窗口类名与标题
  正则、截图与输入方法、识别缩放（`display_short_side`）全部按项目声明来。**不猜设备**：猜错不只是连错
  窗口，还会把 roi 与模板图的坐标系一起猜错。
- `--kind win32|adb|gamepad [--target ...]`：手动指定，窗口可用标题片段或 hwnd。

连接是**进程态**的：命令退出即断开。多步操作走 `repl`（连接一次、命令复用，也能被管道驱动）：

```bash
maafw-live repl --project ./my-maa-project
maa> stream start --fps 10
maa> frame get --roi 0,0,200,120
maa> click 100 200
maa> run StartUp --timeout 60000
maa> quit

printf "probe\nquit\n" | maafw-live repl      # 脚本 / agent 用法
```

## 坐标系（最容易出错的一条）

识别与输入共用**控制器分辨率空间**：默认按项目的 `display_short_side` 缩放（缺省短边 720）。
`roi`、模板图与 `click` 坐标都在这一空间。只有显式传 `--short-side` / `--long-side` / `--raw`
才会改变它——那意味着项目里所有 roi 与模板都要按新尺寸重算。

## 复用 daemon

```js
import { spawnDaemon } from "maafw-live/client"

const c = spawnDaemon({ runDir: "/tmp/maa-run" })
try {
  await c.call("connect", { kind: "win32", target: "记事本" })
  await c.call("stream_start", { fps: 10 })
  c.subscribe("event", (ev) => console.log(ev))
  const shot = await c.call("frame_get", { roi: [0, 0, 200, 120] })
  console.log(shot.path)
} finally {
  c.close()
}
```

一个 daemon 子进程 = 一个设备会话。**像素默认不出 daemon**：先拿帧元数据，需要画面时再按 seq / ROI
精确取——这是为了让模型上下文不被像素挤爆。

## 全局约定

### JSON 信封

`--json` 时 stdout 只输出信封，可被管道直接解析：

```jsonc
{
  "schemaVersion": 1,
  "command": "env",
  "ok": true,
  "exitCode": 0,
  "root": "/path/to/project",
  "written": [], "removed": [], "skipped": [], "pending": [],
  "suggestedCommands": [], "warnings": [],
  "data": { },
  "error": null
}
```

**信封字段只增不改。** 消费方按字段名读取，改名等于静默破坏所有调用方。

### 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 正常完成，未发现问题（run 的任务级 `record.ok=true`） |
| 1 | 命令自身失败（未预期异常、IO 错误）；**run 的任务失败**（`record.ok=false`，含超时被停止） |
| 2 | 参数 / 用法错误 |
| 3 | 跑完了，但发现了问题（校验不通过、存在待处理项；run 的**调用级**失败——未连接 / 资源缺失 / 已有任务在跑） |
| 4 | 前置环境缺失 |
| 130 | 用户中断 |

关键是 **1 与 3 的区分**：1 是「没跑成」（含任务失败），3 是「跑成了但有问题」。任务级结果看
JSON 信封的 `data.record.ok`，不是外层 `ok`——外层只代表调用完成。

### 全局选项

`--json` / `--dry-run` / `--yes` / `--no-interactive` / `--no-color` / `--cwd <dir>` / `--limit <n>` /
`--verbose` / `-h` / `-V`。其中 `--no-interactive` 与 `--no-color` 是自动化场景的硬要求：交互式提问
会让工具调用永久挂住，ANSI 转义会混进 JSON。

## 代码结构

```
src/
  index.ts            入口：解析 → 分发 → 输出。领域逻辑一律不许进来
  protocol.ts         信封 / 命令契约 / 退出码
  flags.ts            全局选项与默认值
  exec.ts             外部命令执行（永不抛异常）
  usage.ts            帮助文本
  pkg.ts              读取自身包信息
  daemon/
    framed.mjs        设备 daemon（独立子进程；逐字节发布，不经打包器）
    reco_child.mjs    识别单测的一次性子进程（崩溃隔离）
  client/daemon.ts    可复用的 daemon 客户端
  runtime/
    actions.ts        动作层：把 daemon 命令包成有类型 / 超时 / 默认值的函数
    session.ts        一次性命令如何先连接再干活
  interface/          interface.json（ProjectInterface v2）的窄解析：控制器规划与资源路径
  commands/           命令面（index 是注册表；env / runtime / input / reco / repl / version）
bin/maafw-live.mjs     启动器（未构建时给人话提示，而不是堆栈）
docs/                 协议与留存契约
scripts/              回归与构建辅助
```

**加一个新命令**：在 `src/commands/` 写一个导出 `Command` 的文件，在 `commands/index.ts` 注册。
选项解析、cwd 校验、错误兜底、JSON 输出都由入口统一处理。注册表只放能跑通的命令，未实现的能力列在
`--help` 的路线图里——挂空壳会让失败原因从「没这个命令」变成「没实现」，也会让 help 撒谎。

## 回归

```bash
npm test           # 纯函数单测：变化检测/L0 淘汰/snap 收紧/SoM 候选/interface 四级 override 链/库配额
npm run verify     # 装配级回归：全部通过真实子进程断言外部契约
node scripts/accept-kf-offline.mjs      # 契约验收（离线）：库读侧——同 ID 跨库、manifest 各类坏法、半写
node scripts/accept-emulator.mjs --target 127.0.0.1:16384   # 契约验收（需模拟器在线）：改分辨率旧帧 ROI、升格路径、磁盘失败注入
```

断言的是**外部契约**（stdout / stderr / 退出码），不是内部函数——消费方看到的正是前者，内部重构不该
影响它。最要紧的两条：信封字段集与文档逐字一致；`--json` 时 stdout 必须是纯 JSON。单测与验收脚本
补的是另一层：信封级回归测不到的数值行为与契约语义（验收记录见
[`docs/keyframe-retention-contract-v0.md`](docs/keyframe-retention-contract-v0.md) §9）。

## 依赖

| 依赖 | 用途 |
| --- | --- |
| `@maaxyz/maa-node` | 官方 Node 绑定：设备连接、截图、识别、输入。原生能力全走它，不走旁路 |

interface.json 的解析与控制器规划内建在 `src/interface/`（无外部依赖）。

## 路线图

已落地的大件：**关键帧留存与引用**（L0 原图缓存
滚动区 + 锚区、输入 / run 边界帧、升格与本地关键帧库、离线帧解析；契约与验收用例在
[`docs/keyframe-retention-contract-v0.md`](docs/keyframe-retention-contract-v0.md)）、PI v2 解析补齐
（import 合并、pipeline_override 四级链、preset 默认值）、**agent 完整桥接**（run 时 spawn agent
子进程并经 `maa.Client` 接入；注意 maa-node 与 agent 侧 maa 库须同版本，协议握手要求）、
变化检测双阈值（分块亮度差 + 事件携带变化区域 bbox、阈值校准命令）、输入原语补齐、探色、
节点级单测（reco `--act`）、模板裁剪（crop，位置优先判据 + 跨帧验证）、轻量 SoM（annotate）与
timing 反推（节点时长 + 动作后稳定时间 → delay/timeout 建议，`--runs n` 取分布：P95 × 余量，失败 run 不计入建议）。

不在本包范围（各有归属）：

| 域 | 归属 |
| --- | --- |
| 静态知识（validate / graph / lookup / project） | MaaLLMWiki 技能 |
| pipeline 改写（node / migrate / interface） | maafw-pipeline 技能 + agent 对文件的直接编辑 |
| 模板资产（template audit / crop） | pipeline 编写动线；裁剪派生物（L2）在留存契约内 |
| 日志与诊断证据（log / evidence） | MaaEvidenceKit + maa-evidence 技能 |
