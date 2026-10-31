# CLI 识别验证路径改进提案 v0

> **状态**：v0 已实现（2026-10-30），实现与验收记录见 §7。
> **起因**：2026-10-30 用 `reco` 验证一条 pipeline 识别条件改动（`expected` 正则）时踩到的摩擦。
> **本版说明**：初版提案被否的条目见 §3；本版只保留能在「CLI 不持久化 + 行为不变」前提下成立的增量。

## 0. 背景：这次实际卡在哪

1. **整节点 JSON 只能走 argv**。Windows 上穿 bash → `cmd.exe`(npm shim) → node，
   `^` 被当转义符吃掉；`expected: "^解锁"` 到进程时已变成 `"解锁"`，三种正则给出相同结果，
   一度被误判成"工具不应用 `expected` 过滤"。（该坑已记入 skill `pitfalls.md` §8.1）
2. **想测"项目里那个节点的真实定义"，只能手工抄 JSON**，而真实定义会叠加资源包覆盖。
3. **miss 原因读不出来**：回执里 `all`（原始）与 `filtered`（过滤后）并列，容易把 `all` 当命中结果。

## 1. 前置缺陷（不修则 `--node-name` 验的不是真节点）

`cmdRecoTest` 只加载**一个**资源目录：

```
src/daemon/framed.mjs:1567   await ensureResource(args.resourceDir)     // 单一 bundle
src/daemon/reco_child.mjs:95 await res.post_bundle(cfg.resourceDir).wait()
```

而 `cmdRun` 已支持整链（`src/daemon/framed.mjs:1173-1179` 的 `buildResource(args.resourceDirs.map(String))`）。

**后果**：overlay 包里的节点改写、只存在于 overlay 的模板、被 `And`/`Or` 按名引用的子节点全部缺失。
只靠 `get_node_data_parsed` + 注入，写在节点 JSON 里的 `expected` 能对上，
但模板仅存于 overlay、或 `roi` 按名引用其它节点时仍会 miss——**看起来对、实际不完整**。

所以 §2.2 是 §2.3 的前置，不能拆开做。

## 2. v0 范围（6 项）

### 2.1 `--node-file` / `--param-file`

```
reco --type OCR --image a.png --param-file a.json
reco --node-file node.json --image a.png
cat a.json | reco ... --param-file -        # stdin 用 `-`，两个 flag 对称支持
```

- **不使用 `@a.json` 语法**：PowerShell 里 `@` 是 splat 前缀，会再踩一次"被 shell 破坏的参数"，
  与「不在工具里猜测/修复被破坏参数」的纪律冲突。
- 文件按 **JSONC** 解析，复用 `src/interface/jsonc.ts:10` 的 `parseJsonc`（pipeline 常带 `//` 注释，
  `JSON.parse` 会误伤）。
- 内容契约不变：`--node` / `--node-file` 都只接受**一个节点**。多节点文件**失败**，报错区分：
  - 文件名值都是节点对象（节点表）→ 提示「这是节点表，用 `--node-name <名字>`」
  - 其它 → 普通解析错误
  > 这条提示只服务于**报错文案**，不构成"pipeline 文件"能力，不改变任何执行路径。
- `--act` 接受 `--node-file` 是 `--node` 的自然延伸（`--act` 仍要求节点带 action）。

### 2.2 `cmdRecoTest` 接完整资源链（含 attach）

- **必须复用 `resolveResourcePaths`**（`src/interface/plan.ts:206`），不要按 `interface.resource.path` 自己拼：
  该函数会把当前控制器的 **`attach_resource_path` 追加在 `resource.path` 之后**，
  源码注释已写明「曾经两条提前 return 把它丢了」（`plan.ts:212-215`）。
  只写 `resource.path` 会让实现的人再丢一次。
- `--image` 不连设备时，控制器仍按 `--controller` 或 `controllers[0]` 参与解析（`offlineResource` 已这么做），
  以便 attach 进来。
- 回执打印实际使用的**资源名 + 整条链（含 attach 段）**，例如
  `resource: 港澳台服  (base + global_jp + tw)`。
- 只给 `--resource-dir` 时按单一 bundle 处理，回执同样打印，让人知道在看哪一层。

### 2.3 `--node-name`：按原名跑，不 dump 注入

```
reco --project . [--resource 港澳台服] --node-name AP_NavUnlockButton --image a.png
reco --resource-dir ./resource/base --node-name AP_NavUnlockButton --image a.png   # 单包也允许
```

- 整链 `post_bundle` 后，用 `context.run_recognition("<name>", image)` 按资源里的**原名**跑
  （`node_modules/@maaxyz/maa-node/dist/context.d.ts:10-14` 支持 `entry: string`）。
- `get_node_data_parsed` 的结果**只放进回执**给人看，不参与识别。
  > 理由：dump 是 `DumpTask`（V2 嵌套 + 缺省全部填满），与手写稀疏 V1 JSON 不是同一份；
  > dump 再注入会让"测的到底是不是真节点"多一层不确定性。
- **允许只配 `--resource-dir` 不配 `--project`**：无 overlay 时 `layer` 仍是 `resource`，
  回执里链就一段。此点写死，免得实现时猜。
- **Custom / agent 节点**：dump 的 `recognition.type === "Custom"`（或含 `custom_recognition`）时，
  直接返回明确的 FINDINGS/USAGE「`reco_test` 不桥接 custom/agent 节点」，
  **不要让它看起来像 miss**。这条不依赖 `--act`，第一天就会碰到。
  **And / Or 里嵌的 Custom 子识别同样算**：dump 是嵌套的（`recognition.param.all_of[…].recognition.type`），
  只判顶层会让嵌套的那种落回 miss 或"识别调用报错"；回执用 `customPaths` 指出命中位置。
- **回执必须标 `layer`**：本命令给的是 `resource`（资源合并结果）；
  `run --project` 还会再叠 interface 的四级 `pipeline_override`（global → resource → controller → task）。
  若 GUI 选项改过同一字段，`--node-name` 与 `run` 对不上是**预期行为**，靠 `layer` 说明，不冒充"真实"。

### 2.4 miss 原因与计数

**按算法 + `hit` 分支，不共用一套 OCR 口径的名字**：

| 条件 | `missReason` |
| :--- | :--- |
| `hit === true` | 不写 |
| 子进程抛异常（`detail` 为 null，如 OCR 模型文件损坏） | `识别调用报错：<原生消息>`——不是未命中 |
| OCR，`all` 为空、链上**没有** OCR 模型 | `OCR 模型不在资源链里（model/ocr 需 det.onnx + rec.onnx + keys.txt）` |
| OCR，`all` 为空、链上有模型 | `roi 内无文字` |
| OCR，`all` 非空、未命中 | `expected 无匹配` |
| TemplateMatch，无分数 / `all` 为空 | 沿用既有 `noConfidence`（模板读不到） |
| TemplateMatch，有分数、未命中 | 不用 expected 口径，沿用 `thresholdSuggestion.lowMatch` |

> **OCR 的两个空结果同形**（实现时补的）：模型没加载时框架不报错，只回 `all: []`、`hit:false`、
> 约 200ms——与"roi 里真的没有字"完全一致。判据放在 `src/runtime/ocr-model.ts`：查链上
> `model/ocr/<model>/` 有没有 `det.onnx` + `rec.onnx` + `keys.txt`（`<model>` 取自节点/参数，缺省空串）。
> 只查存在性、不解析 onnx：回答的是"框架会不会找到它"，不是"模型能不能跑"。
> **判据按框架的合并规则**：`det` 与 `rec` 可以来自不同段，`rec` 与 `keys.txt` 必须同段（`load_deter` /
> `load_recer` 各自遍历 roots）——只看"某一段三件套齐全"会把拆分存放误报成缺模型。
> 第三种空结果也在这条线上：模型文件存在但**损坏**时子进程会捕获异常（实测
> `No graph was found in the protobuf.`），回执 `detail: null`——那要走"识别调用报错"，不能算未命中。
> 逐例行标 `[报错]`、机器侧置 `failed: true`；**退出码本版仍是 0**（§3 冻结了退出码语义，调用方要按
> `missReason` / `failed` 判，别只看码或 `[未中]`）。

外加 `rawCount` / `filteredCount`（从 `detail.detail.{all,filtered}` 派生）。

> **坑**：现有 `noConfidence = th === null && results.length > 0`（`src/commands/reco.ts:232`）
> 在 **OCR 命中**时也为 true（OCR 无数值分，`suggestThreshold` 返回 `null`）。
> 派生时**必须先看 `hit` / `results[].ok`**，否则命中也会被标成"无置信度"。

> 更正初版：`hit=false 但 box 非零` 这条是编的。本仓既有注释明确 miss 时 box 全零。

### 2.5 `env` 对账：比的是**正在运行的那份** maa-node

- 今天 `src/commands/env.ts:120` 是 `resolveMaaNode(cwd) ?? resolveMaaNode(selfDir())`：
  **优先 cwd 的 node_modules**，全局安装时实际加载的是包自带那份，却可能报出 cwd 的版本。
- 改为分别报告 `self`（CLI 实际加载）与 `cwd`（不同则并列），再把 `self` 与项目 pin
  （`package.json` / `requirements.txt`；`uv.lock` 仅作辅证）比对给 warning。
- **不读 `interface.json` 的 `interface_version`**：它是 Project Interface 版本（当前 2），与 maa-node 无关。

### 2.6 同一组能力进 REPL；`--image` 不连设备

- `repl` 的 `reco` 目前只有 `[k=v …] [--image] [--seq] [--from-kf] [--resource-dir] [--sweep]`
  （`src/commands/repl.ts:49`），**没有 `--node`**。本仓硬约束是 CLI/REPL 判据同源，
  `--node-file` / `--node-name` 要一并进 REPL。
- **`--image` 走离线路径**：`src/commands/reco.ts:124` 的 `offline = kfSource !== undefined`
  只认 `--from-kf`，于是 `--project --image` 会 `ensureSession` 连设备；而同文件 `:203`
  又把 `--image` 当「离线评估」标注。**这是工具自身的口径分叉**，应按"给了静态图就不需要设备会话"统一。
- **此约束只作用于一次性命令**：REPL 已有会话时继续用，不为静态图去 `disconnect`。

## 3. 明确不做（含理由）

| 不做 | 理由 |
| :--- | :--- |
| `@file` 语法 | PowerShell splat 冲突，与"不猜被 shell 破坏的参数"冲突 |
| 持久化「当前资源」（`resource use`） | `src/runtime/session.ts:19` 明确「持久化选择由面板负责，CLI 不做持久化」；且与用户级 `~/.maafw-live` 撞名，并让 agent 场景的命令不可复现 |
| cwd 在项目里自动探测资源 | 与"行为不变"冲突；cwd 碰巧在某个 Maa 项目里会让 OCR 模型/模板静默换源。快速层继续显式 `--resource-dir`；真实层显式 `--project`。`--resource` 已存在于 `CONNECT_OPTIONS`（`src/commands/runtime.ts:19-29`） |
| `--matrix` | 输入形状、与 `--node`/`--param`/`--sweep`/`candidates` 的互斥、N 上限、信封形状都未定义，无法验收。另：`--sweep` 并非只能扫 `threshold`（`src/daemon/framed.mjs:1632` 是 `sweep.key \|\| 'threshold'`），缺的是**离散变体**；daemon 侧 `candidates` 已存在（`:1605-1613`），先考虑复用 |
| 改 `resource[0]` fallback 语义 | "多资源且未指定就报错"会让最常用路径变重；保持现状，仅把链名打进回执 |
| **reco 未命中的退出码** | **已知文档/实现冲突**：README `:181`、`src/protocol.ts:31` 都写 miss → FINDINGS(3)，而实现与 `test/unit-reco-cli.mjs:82,93` 钉的是 `ok:true` → 0，测试注释自陈「识别类命令的退出码语义不在本次修复面内」。本版**不动**（改退出码是调用方可见的行为变更，需单独评估），但 §2.4 不能让差异变大；列入 §5 待修 |

## 4. 互斥与作用域（写死，避免实现时吵）

| 组合 | 行为 |
| :--- | :--- |
| `--node` / `--node-file` / `--node-name` | 三者**互斥**，同时给报参数错误 |
| `--node` 与 `--param` | 今天已被忽略（节点透传优先）；保持不变，但回执要能看出用的是哪个来源 |
| `--param` 与 `--param-file` | 互斥 |
| `--param` / `--param-file` / `--sweep` | **只作用于 `--type` 路径**；与任一节点来源同给时报参数错误（比今天"静默忽略"更明确） |
| `--act` | 只接受 `--node` / `--node-file`，且节点必须带 action |

## 5. 建议的验收

- **资源链生效**：构造 overlay 包（`base` + `overlay`），overlay 内改写某节点的 `expected`、且模板只在其内；
  确认 `--node-name` 用的是 overlay 版本。这是 §1 缺陷的回归测试。
- **attach 生效**：带 `attach_resource_path` 的项目，链末段必须出现在回执里。
- **等价性**：同图同节点，`--node-file <dump 出来的 JSON>` 与 `--node-name` 应得相同 `hit`/`box`。
  > 初版写的"与内联手写 JSON 必须相等"是错的：手写的是稀疏 V1，本来就不该相等——
  > 那正是这条命令存在的理由。
- **多节点文件**：`--node-file` 指向节点表必须失败，且报错给出 `--node-name` 提示。
- **`--image` 不连设备**：断网/无设备时 `reco --project --image` 仍应成功；REPL 内不清断会话。
- **`env` 版本**：全局安装且 cwd 有不同版本 node_modules 时，`self` 与 `cwd` 都要出现且可区分。
- **协议**：`reco_test` 新增 `resourceDirs[]`、回执新增 `resource` / `layer` / `nodeDump`，
  属信封只增不改，需同步更新 `docs/daemon-protocol.md`。

## 6. 未覆盖面（本版明确留白）

- `--act` + `--node-name`：`run` 会桥接 agent 子进程，`reco_test` 不会（见 §2.3 的 Custom 处理）。
- 离散变体对比（原 `--matrix` 的合理内核）。
- **`crop` / `annotate` 仍只用 `paths[0]`**：本提案不碰。记在这里，避免有人"顺手"改到识别验证之外。
- reco 未命中退出码与文档契约的对齐（见 §3 末条）。

## 7. 实现与验收（v0，2026-10-30）

- **落点**：`src/daemon/framed.mjs` + `src/daemon/reco_child.mjs`（资源链、`nodeName`/`nodeDump`）、
  `src/commands/reco.ts` + `src/commands/repl.ts`（参数面与回执）、`src/runtime/reco-verdict.ts`
  （miss 原因与计数，CLI/REPL 同源）、`src/runtime/node-source.ts`（JSONC 文件 / stdin、节点表识别）、
  `src/runtime/session.ts`（`offlineResource` 返回整条链）、`src/commands/env.ts`（§2.5）。
- **§4 的一处取舍**：第 1 行写"`--node` 与 `--param` 保持不变（忽略）"，第 3 行写"与任一节点来源同给
  时报参数错误"。按第 3 行实现（更明确的错），回执另给 `paramSource` 说明用的是哪个来源。
- **§5 验收的落点**：六条各自有单测钉住 —— `test/unit-reco-cli.mjs`（资源链/attach、互斥、离线性、
  `--node-name` 回执、miss 原因）、`test/unit-repl-reco.mjs`（REPL 同源）、`test/unit-reco-verdict.mjs`
  （原因与计数纯函数）、`test/unit-env-runtime.mjs`（§2.5 的 self/cwd/pin）。
  资源链与 overlay 覆盖另用**真 daemon 离线**跑过（`--project` + `--node-name` + `--image`，无设备）：
  base 定义 `DirectHit`、overlay 改写成 `ColorMatch` → dump 报 `ColorMatch`（overlay 生效）；
  只存在于 attach 段的节点在整链下可识别、单包下报 `RECO_NODE_MISSING`。
- **超出 §2.3 字面要求的一处**：`--node-name` 查无节点时给**近邻节点名**（资源 `node_list` + 编辑距离）。
  §2.3 只写了"查无此节点"要区别于 miss，没要求这条；加它是因为"拼错一个字"和"节点不在这层"的处置
  完全不同，而正确名字就在资源里。
- **REPL 同源**：`repl reco` 与一次性命令共用同一份判据（`describeMisses`、`suggestThreshold`、
  `readNodeFile` / `readParamFile`），并有 `--param-file`；`-`（stdin）在 REPL 里直接拒绝（stdin 是命令流）。
- **可重复验收**：`npm run accept:reco-node`（`scripts/accept-reco-node.mjs`）用真 daemon 离线起
  base + overlay + attach 的最小项目，钉住 overlay 覆盖、attach 进链、Custom 与查无节点两种失败、
  近邻节点名（真 `node_list` 上的编辑距离）、OCR 模型缺失、And 内嵌 Custom、参数值里的 `"Custom"`
  不算识别类型，以及 §5 的等价性——把 `nodeDump` 落成文件再 `--node-file` 跑一遍，`hit` / `box`
  与 `--node-name` 一致。
- **实现期修掉的两处口径**：REPL 的 `reco` 类型是位置参数，选项 / k=v 打头时回缺省 `TemplateMatch`
  （旧写法会把 `--param-file` 当成类型）；`--node-file` 的"节点表"判定要求至少一个值带 `recognition`，
  免得把缺字段的单节点（`{"action":{…}}`）误报成节点表。
- **review 后修的五处**（都不改主链路，但会改结论）：
  - 资源链探针**一律用一次性 `Resource`**（单包也走），加载完销毁、逐段点名失败段：原先单包走
    `ensureResource`，会把这一段叠进 REPL 长活会话的 `S.res`，之后 `run --resource-dir <别的包>` 就带着
    上一轮的 bundle 跑（`buildResource` 注释记的正是这个残留）。
  - OCR 模型判据按**合并规则**（见 §2.4 注）：`det` 与 `rec` 可跨段，`rec` 与 `keys` 必须同段。
  - `env` 的 pin 对账：release 线与 **归一化后的** qualifier 都比（`5.15.0b1` 与 `5.15.0-beta.1` 是同一
    pre-release 的两种拼写，算一致；而正式版 `5.14.2` 与同线预发布 `5.14.2b1` 是两份不同构建，要报）；
    两处声明都读，**精确优先于范围**，不让 `package.json` 的范围声明顶掉 Python 侧精确 pin。
  - 调用报错这一形态：逐例标 `[报错]`、`failed: true`，一次性 CLI 与 REPL 都单独点名"这不是未命中"；
    同一回执里报错与真未命中并存时两行都给（退出码仍按 §3 不动）。
  - And / Or 嵌套的 Custom 子识别也走 `RECO_CUSTOM_NODE`，回执 `customPaths` 指出位置；dump 里 V1
    字符串形态（`recognition: "Custom"`）同样不漏判——但只认**识别类型位**上的字符串（`recognition` /
    `type`），`expected: "Custom"` 这类参数值不会误报。
- **未做**：真机上的 `--act` 回归（本机无设备），见 §6；`reco` 未命中 / 调用报错的**退出码**语义（§3 冻结）；
  `run --resource-dir` 的资源生命周期（仍走 `ensureResource`，长活会话里上一轮 bundle 会残留——与本次探针
  修的是同一类问题，但要单独改 `run`，不在 v0 面内）。
