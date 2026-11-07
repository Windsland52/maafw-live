# 会话与一次性命令统一方案 v0（设计审查 P0-3）

> 状态：方案稿，未实现。来源：2026-11-07 设计审查 P0-3 + M9A 会话复盘。
> 一句话：**让所有命令只在一份 `Command.run` 上实现**，会话只是"daemon 常驻"的一种部署形态，
> `--session <name>` 决定把命令发给本地新 daemon 还是发给常驻会话的 daemon。

## 0. 现状的三个伤口

1. **一次性命令拿不到会话态**：每条命令新起 daemon 用完即关，L0 热缓存、帧流、事件环、
   在跑任务全在临时进程里。`stop` 停的是自己刚起的空 daemon（回 `exitCode 0`）；`wait` /
   `frame get` / `events` / `kf promote` 恒失败；`disconnect` 为了断开先新连一次。
2. **命名会话丢信封**：`repl --session x --cmd "frame 999" --json` 只回 `{name,pid}`，
   命令结果整条丢；去掉 `--json` 打印 `{"ok":false}` 退出码仍是 0。
   根因：`ServeReply` 只带 `lines[]`（文本行），没有结构化 `CommandResult`。
3. **REPL switch 是第二份实现**（`repl.ts` ~600 行 29 个 case）：已与一次性命令漂移——
   `connect project` 选不了 controller/resource，`run` 不吃 `--option`。两份实现必继续漂。

## 1. 目标形态

```
maafw-live run T --project .                  # 一次性：本地新 daemon（现状不变）
maafw-live run T --session m9a                # 转发：送到常驻会话的 daemon，同一信封同一退出码
maafw-live repl --session m9a --cmd "run T"   # 与上面完全同一条路径，只是入口不同
maa> run T                                    # REPL 行 → tokenize → argv → 同一 Command.run
```

判断"这条命令需不需要会话态"是命令自己声明的，不是用户记的。

## 2. 分四层落地（每层独立提交、独立可回滚）

### L1 客户端注入（地基，~2h）

- `CommandContext` 增 `client?: DaemonClient`。`withDaemon`（唯一 spawn 点）：
  `ctx.client` 有则借用、不关；没有才 spawn。
- REPL / session-serve 进程在启动时建好 `client`，dispatch 时注入——同进程内复用连接。
- 改 `withDaemon` 签名意味着所有 `withDaemon(client => …)` 调用点改成
  `withDaemon(ctx, client => …)`。一次机械的签名改动。

### L2 `--session` 全局旗标 + 结构化回执（核心，~半天）

- **协议 v2**：`ServeRequest` 增 `kind`：`{id, kind:'line', line}`（旧，兼容）/
  `{id, kind:'exec', argv:string[]}`。`ServeReply` 增 `v` 与 `result`：
  `{id, v:2, result: CommandResult}`。旧 `lines[]` 形态保留（REPL 文本糖仍走 line）。
- **session server 侧**：收到 `exec` → `dispatchArgv(argv, ctx{client})` →
  `findCommand(argv[0]).run(ctx)` → 把 `CommandResult` 原样回。串行队列照旧
  （共用一条设备连接，排队是对的）。
- **客户端侧**：`cli.ts` main 在 `parseArgs` 后、`findCommand.run` 前拦 `--session <name>`：
  `readSessionMeta` → `pidAlive(meta.pid)` → `sendToSessionExec(meta, argv, budget)` →
  拿到的 `CommandResult` 直接作为本进程输出（exitCode / data / human 全套）。
  - meta 存在、pid 死了：用 `meta.connectArgs` **自动重起**（死会话自愈，不必让用户手动复活）。
  - meta 不存在：退 2 + `先起会话：maafw-live repl --session <name> --project <dir>`。
  - 转发预算 = `max(命令自身预算, 60s)`；`--timeout` 原样透传进 argv。
- **`repl --cmd --json` 修复（白得）**：`--cmd` 的每行走 tokenize→dispatchArgv→CommandResult，
  信封里放 `result` 字段；`--json` 输出 `{name, pid, results: CommandResult[]}`。
  human 路径把 `result.human` 打出来（与交互式同文本）。

### L3 REPL switch → argv 翻译（消灭第二实现，~半天，最大风险层）

- `runReplLine(line)` → `tokenize` → **`replToArgv(tokens)`**（纯函数，别名表）→ `dispatchArgv`。
- 需要别名/升格的命令：
  | REPL 写法 | argv | 备注 |
  |---|---|---|
  | `connect project d` | `connect --project d` | 直接映射 |
  | `connect win32 <t>` | `connect --kind win32 --target <t>` | |
  | `wait stable/change` | `wait --mode stable/change` | |
  | `frame get/status` | `frame get/status` | 已是子命令 |
  | `stream start/stop/status` | **升格为真 Command** `stream` | daemon 侧 `stream_*` 已有 |
  | `logs [n]` | **升格为真 Command** `logs` | 读 `client.events.logs` 尾部 |
  | `kf list/promote/…` | `kf …` | 对齐 kf.ts 子命令表 |
  | 手势 `click/swipe/key/…` | 同名 input 命令 | 已同名 |
- REPL 保留的本地糖：`help` / `quit` / `exit` / 命令名建议（suggestHead）/ 提示符。
- **判据**：switch 全部 case 删掉后，REPL 行为通过 `unit-session-named` + 交互冒烟验证。
  漂移从结构上消失——因为不再存在第二份实现。

### L4 会话必需命令的空会话闸门（~1h）

`Command` 增 `requiresSession?: boolean`。命中条件：无 `--session`、非 REPL 上下文
（即一次性 daemon）→ 退 2（USAGE）+ `这条命令需要会话态，用 --session <name> 或 repl`。

| 命令 | 一次性形态为什么没意义 |
|---|---|
| `stop` | 停的是刚起的空 daemon，回 ok 误导 |
| `disconnect` | 为断开先新连一次 |
| `wait` | 预热截图不进环 → 恒 NO_FRAME；就算有帧也没流 |
| `frame get` | 环恒空 → 恒 NO_FRAME |
| `events`（无 --watch） | 恒空 |
| `kf promote` | 本进程 seq=0 → 恒失败 |
| `logs`、`stream` | 新 Command，只有会话态才有环可停/日志可读 |

## 3. 语义边界（先写死，免得实现时再猜）

1. **`run --session x` 按 Ctrl-C**：中断的是转发方 CLI，**任务在会话里继续跑**
   （signal-guard 装在本地 run 路径；会话内 run 由 server 进程持有）。
   停任务用 `maafw-live stop --session x`。这是"任务属于会话"语义的自然结果。
2. **watch 类命令经会话转发**：占用串行队列直到返回（`run --watch 60s` 期间后续命令排队）。
   转发预算按命令 `--timeout` 透传；文档写清"会话内 watch 会阻塞队列"，
   需要并行观察就开第二个会话或直接在会话外用 `events --watch`。
3. **异步 `run`（post_task 返回后事件后到）**：完成事件落 `unclaimed`，
   随下一条命令的回执回来——现有机制已支持，转发的 `run` 同样走这条。
4. **`requiresSession` 命令在 REPL 内**：天然有 client，直接跑，闸门不拦。

## 4. 验收

- `maafw-live run 8bitEntry --session m9a --json`：exitCode/data 与直接 `run` 同形。
- `maafw-live repl --session m9a --cmd "frame get" --json`：data 含真实 frame 结果（不再只有 name/pid）。
- `maafw-live stop --json`（无会话）：退 2 + requiresSession 提示。
- `repl` 内 `run X --option k=v`：生效（漂移修复点）。
- `repl --session m9a` 死会话自愈：kill serve pid 后下一条 `--session` 命令自动重起。
- `unit-session-named` 全过；新增 dispatchArgv / replToArgv / requiresSession 闸门单测。

## 5. 不做什么

- 不做多 daemon 路由（一会话一设备一 daemon 的模型不动）。
- 不做 REPL 与一次性的 help 统一（usage 文本已是同一份）。
- 不动 daemon 协议（`framed.mjs` handlers 不变），只动客户端与会话 IPC 层。
