# maafw-run

MaaFramework 的 Node 工具链：**设备运行时（daemon）+ 可复用客户端 + CLI**。

面向 agent、脚本与人：命令是确定性的，输出有稳定 JSON 信封；daemon 协议与客户端不绑定任何宿主，
编辑器插件、自动化平台、CI 都能直接接。

## 三件东西

| 部分 | 位置 | 做什么 |
| --- | --- | --- |
| daemon | `src/daemon/framed.mjs` | 独立子进程，持有 Controller / Resource / Tasker、帧流与环形缓冲；说 JSON 行协议 |
| client | `maafw-run/client` | 可复用客户端：spawn、应答配对、超时硬杀自愈、帧 / 事件 / 原生日志汇聚 |
| CLI | `bin/maafw-run.mjs` | 命令面：探针、设备、输入、识别、会话 |

协议的完整契约（消息形状、命令表、坐标系与稳定性约定）见 [`docs/daemon-protocol.md`](docs/daemon-protocol.md)。

## 安装

```bash
npm install
npm run build
npm link            # 之后可直接 maafw-run --help
```

需要 Node >= 22.13；`@maaxyz/maa-node` 会在安装时按平台取对应的原生包。

## 命令

| 命令 | 说明 |
| --- | --- |
| `maafw-run env` | 探测环境与能力：项目根、pipeline 目录、maa-node、框架版本、git / adb / python |
| `maafw-run version` | 打印 CLI 与依赖版本 |
| `maafw-run probe` | 自检运行时：绑定版本、adb / win32 设备发现数 |
| `maafw-run device` | 列出可连接的设备（adb 设备与 win32 窗口） |
| `maafw-run connect` | 连接设备（进程态；多步操作用 repl） |
| `maafw-run disconnect` | 断开并销毁 Tasker / Controller |
| `maafw-run screencap` | 截一帧并落盘 |
| `maafw-run frame` | 帧流状态与历史帧取用（可带 ROI） |
| `maafw-run run` | 运行 pipeline，节点事件按帧序对齐 |
| `maafw-run stop` | 停止运行中的任务 |
| `maafw-run click` / `swipe` / `key` / `text` | 输入注入（经 maafw 控制器本体） |
| `maafw-run reco` | 识别单测（子进程隔离）与阈值扫描 |
| `maafw-run repl` | 交互 / 管道会话：连接一次，命令复用 |

`env` 是前置命令：动手前先问它「现在有什么」，而不是各自写一遍环境检测。它有一条硬要求——
**自身永远不能因为环境残缺而失败**，缺依赖都是探测结果，不是错误。

## 连接：优先 `--project`

两种连法：

- `--project <dir>`（推荐）：读项目 `interface.json` 的 `controller[]` —— 控制器类型、窗口类名与标题
  正则、截图与输入方法、识别缩放（`display_short_side`）全部按项目声明来。**不猜设备**：猜错不只是连错
  窗口，还会把 roi 与模板图的坐标系一起猜错。
- `--kind win32|adb|gamepad [--target ...]`：手动指定，窗口可用标题片段或 hwnd。

连接是**进程态**的：命令退出即断开。多步操作走 `repl`（连接一次、命令复用，也能被管道驱动）：

```bash
maafw-run repl --project ./my-maa-project
maa> stream start --fps 10
maa> frame get --roi 0,0,200,120
maa> click 100 200
maa> run StartUp --timeout 60000
maa> quit

printf "probe\nquit\n" | maafw-run repl      # 脚本 / agent 用法
```

## 坐标系（最容易出错的一条）

识别与输入共用**控制器分辨率空间**：默认按项目的 `display_short_side` 缩放（缺省短边 720）。
`roi`、模板图与 `click` 坐标都在这一空间。只有显式传 `--short-side` / `--long-side` / `--raw`
才会改变它——那意味着项目里所有 roi 与模板都要按新尺寸重算。

## 复用 daemon

```js
import { spawnDaemon } from "maafw-run/client"

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
| 0 | 正常完成，未发现问题 |
| 1 | 命令自身失败（未预期异常、IO 错误） |
| 2 | 参数 / 用法错误 |
| 3 | 跑完了，但发现了问题（校验不通过、存在待处理项） |
| 4 | 前置环境缺失 |
| 130 | 用户中断 |

关键是 **1 与 3 的区分**：1 是「没跑成」，3 是「跑成了但有问题」。校验器发现 3 个悬空引用不是执行失败，
但也不该返回 0 让调用方以为一切正常。

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
  commands/           命令面（index 是注册表；env / runtime / input / reco / repl / version）
bin/maafw-run.mjs     启动器（未构建时给人话提示，而不是堆栈）
docs/                 协议契约
scripts/              回归与构建辅助
```

**加一个新命令**：在 `src/commands/` 写一个导出 `Command` 的文件，在 `commands/index.ts` 注册。
选项解析、cwd 校验、错误兜底、JSON 输出都由入口统一处理。注册表只放能跑通的命令，未实现的域列在
`--help` 的路线图里——挂空壳会让失败原因从「没这个命令」变成「没实现」，也会让 help 撒谎。

## 回归

```bash
npm run verify      # 装配级回归：全部通过真实子进程断言外部契约
```

断言的是**外部契约**（stdout / stderr / 退出码），不是内部函数——消费方看到的正是前者，内部重构不该
影响它。最要紧的两条：信封字段集与文档逐字一致；`--json` 时 stdout 必须是纯 JSON。

## 依赖

| 依赖 | 用途 |
| --- | --- |
| `@maaxyz/maa-node` | 官方 Node 绑定：设备连接、截图、识别、输入。原生能力全走它，不走旁路 |
| 领域内核（core） | 版本对账、schema 推导、pipeline 节点图、interface.json 规划。当前以 `file:` 引用兄弟目录，发布后改为常规依赖 |

core 的使用是**惰性**的：不可用时 `env` 会退回直接探测，保证探针本身永远可用。

## 路线图

| 域 | 子命令 |
| --- | --- |
| 静态知识 | `validate`、`graph`、`lookup`、`project` |
| pipeline 改写 | `node rename`、`node edit`、`node prune`、`migrate`、`interface sync` |
| 资产 | `template audit`、`template crop` |
| 时序 | `timing`（从帧流与节点事件反推 delay / timeout） |
| 日志 | `log analyze`、`log query`、`evidence build`、`evidence query` |
