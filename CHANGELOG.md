# Changelog

maafw-live 的重要更改记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-08

> 首个发布版本，**同时进 npm registry（`@windsland52/maa-live`，OIDC trusted publishing）与 GitHub Packages**。
> 此前仓库以工作快照推进（下游 MaaTutorial `maafw-debug` 技能的评审核出于快照 `35c4e493`），tag 与 Release
> 都还没有对外；本版发布前把声明与实现逐条对账——消除「声明了但没有」的第三态——并建立发布流程
> （CHANGELOG / CI / tag 触发的发布链）。下游结果契约「以本仓库文档为准」的引用请指向 `v0.1.0`。

### 变更

- **包改名为 `@windsland52/maa-live`（scoped），命令名仍是 `maafw-live`**，并同时发布到两个 registry：
  npm registry（`npm install --global @windsland52/maa-live`，公共通道）与 GitHub Packages（同 scope；安装需带
  PAT，属镜像/内部通道）。scoped 是两边共用的前提——GitHub Packages 要求 scope 与仓库 owner 同名，
  而 npm 包名只能小写。
- **`maafw-live version` 增打命令行名**：scoped 包最容易混的就是"装的名字"与"敲的命令"——现在输出
  `@windsland52/maa-live 0.1.0` 之后另起一行 `command    maafw-live`。装配断言改为按 `package.json`
  自称的名字/版本判定，不写死字面量（顺带补一条"命令名"断言）。
- **发布身份无长期凭据**：npm 侧走 **trusted publishing（OIDC，`id-token: write`）** + `--access public
  --provenance`；GitHub Packages 侧走 `GITHUB_TOKEN`（`packages: write`，GHCR 不支持 trusted publishing，
  也不接受 provenance，故不带 `--provenance`）。两个发布作业都先查该版本是否已存在，存在即跳过——
  部分失败后重跑安全。`release` 作业改为 `needs: [check, publish-npm]`：GHCR 是镜像通道，
  它失败不该挡住 GitHub Release 的创建。
  一次性配置（npm scope 归属、npm 侧 trusted publisher 绑定本仓 `release.yml`、GHCR 靠 `repository`
  字段关联）见 RELEASING.md。

### 新增

- **自带 Agent Skill**（`skills/`，随 npm 包发布）：把**使用动线、纪律、判据与反模式**写成可装载的 skill
  ——四条动线（实时观测 / 识别实测 / 模板资产 / 状态证据留存）、硬护栏、退出码与判定分级、反模式清单、
  真机样例（一次性状态留档后离线裁模板、分辨率空间守卫）。命令面与字段仍以 `docs/` 为唯一出处，skill 不复述协议，
  避免出现第二份。安装：`npx skills add https://github.com/Windsland52/maafw-live --skill maafw-live --global`
  （skill 与 CLI 分开安装，版本关系见 `skills/README.md`）。
- **`skill` 命令：skill 与 CLI 的字节对齐**——`maafw-live skill`（包内副本与逐文件指纹）、
  `--check <安装根目录>`（逐文件 same / different / missing / extra，有漂移退出 `FINDINGS(3)`）、
  `--install <目录>`（离线逐字节写出）、`--print [--format json]`（harness 自取）。
  `extra`（skills CLI 放进来的 agent 元数据）不计漂移；仅行尾不同仍算不同但标注成因。
- **从关键帧库留存帧裁剪 L2 派生图**（`crop --from-kf <完整 ID>`）：库内 L0 直接作裁剪源，**不需要设备、
  也不需要捕获它的那次会话还活着**——这正是「不可复现状态」要模板时的用法。裁剪只读库帧，跨帧验证缺省关
  （留存帧对应的状态通常已不在画面上，`--cross` 显式开）。
- **L2 出处记录**：裁剪产物旁写 `<out>.prov.json`（回执里同时给 `provenance`），记来源帧身份（完整 `kf:` ID
  或热缓存 seq + sha256 + **捕获时**尺寸）、裁剪变换（宽松框 → 裁剪框，无缩放）、自匹配结论；字段是白名单，
  设备地址 / 目标 / daemon 身份不落进 L2（L2 要提交进仓库，契约 §4.1）。
- **模板空间守卫**：源帧捕获时尺寸 ≠ 当前控制器尺寸时警告并退出 `FINDINGS(3)`（改过 `shortSide` / 换过设备
  就会出现），不静默产出可被误用的模板（契约 §5）。
- **任务记录补分支可见性**：`record.nextCandidates` 记下框架本轮**宣布过的候选序列**
  （`{seq, name, polls, jumpBack?, anchor?}`，连续重复折叠成 `polls`；上限 50 条，`nextCandidateCount` 给总次数）。
  名字为准了之后再看轮询序列，"轮询了哪些出口、最后走了哪个"就能从记录里读出来，不必靠屏幕猜。
  实测：两节点流程读作 `EnterGallery×1 → GalleryOpened×3`（页面切换期间被轮询三次）。
- **`annotate --from-kf <完整 ID>`：SoM 候选也能在留存帧上离线跑**（不需要设备）。库帧本就是控制器分辨率，
  换算系数为 1（`box` 与 `ctrl` 相同）；候选路径复用与裁剪同一套三层校验（不符即拒）。**库帧路径没有会话事件，
  diff 源如实报在 `sourcesUnavailable`**，不拿别的区域顶替。

### 修复

- **发布前干跑抓到 `bin` 会被 npm 静默删除**：`bin` 写成 `./bin/maafw-live.mjs`（带 `./`）时，
  `npm publish` 报 `bin[maafw-live] script name ... was invalid and removed` 并**删掉这条**——
  照那样发出去，用户装完没有 `maafw-live` 命令。改为相对路径 `bin/maafw-live.mjs`，并从**真正要上传的
  tarball** 里解包复核 `bin` 与文件都在。注意 `npm pack` **不报**这条、只有 `npm publish` 报：
  发布前必须干跑一次 `npm publish --dry-run`（本次就是这么发现的）。
- **`record.nodes[].name` 报任务入口名**：节点记录原先直接取框架 `PipelineNode.*` 通知的顶层 `name`，
  而该字段填的是**任务入口名**——真实两节点流程（`EnterGallery` → `GalleryOpened`）两条记录同名，
  可判别探针（下一节点识别设为永假）也证实第二条跑的是 `ProbeB` 却仍叫 `ProbeA`。
  改为优先取框架内嵌的 `node_details.name`（其次 `action_details` / `reco_details`），并新增
  `nameSource`（`node_details` = 权威 / `entry` = 顶层兜底、未确认）。修完同一流程读作
  `EnterGallery` → `GalleryOpened`，探针读作 `ProbeA` → `ProbeB`。
  诊断入口：env `MAAFW_NOTIFY_DUMP=<file>` 把框架原始通知落盘（默认关）。
- **SoM 候选表的位置偏置**：候选先按源优先级、再按扫描顺序（自上而下）排，原先直接截前 30 个 →
  候选表系统性偏顶部。实测（6 帧 1280×720）：去重后真实规模中位 54、最大 135，默认上限只放出 41%，
  大厅帧 63 个底部候选**一个都没进表**，看上去像"底部没有可点区域"。改为**按横向分带轮转**截断
  （带内保持源优先级），打满的帧分带从 22/6/2、20/10/0 变成 **10/10/10**，覆盖率同步上升
  （大厅 20% → 26.7%）。回执新增 `limit` / `mergedTotal`，不等即表示有截断。
- `tpl_crop` 解码后统一归一化为 RGB：`cropRgb` 按 3 通道步进，控制器交付 RGBA 帧时原先会静默错剪。
- 裁剪警告不再互相覆盖（原先跨帧警告会盖掉自匹配警告）：回执新增 `warns[]`，`warn` 保留为首条。

### 测试

- **分辨率鲁棒性（第三批定标）**：同一画面在 `shortSide 1080`（控制器交付 1920×1080）下复测——
  **裁剪侧与分辨率无关**（同元素 1.5× 坐标，4/4 位置正确、得分 1.0、9 次评估，仅慢 13%：成本由起子进程主导）；
  **SoM 侧上限与分辨率相乘**：候选供给变多（96 vs 720p 中位 54），但固定上限 30 让画面覆盖率从
  中位 19% 掉到 **6.2%**——高分辨率场景候选表是"取样"不是"覆盖"，使用侧要按分辨率调预期。
  采集侧同空间的做法已验：`repl --kind adb --target <addr> --short-side 1080` 一次会话里
  `screencap` + `kf promote latest`。详见 roadmap.local.md 第十六轮。
- **节点名取值回归**（`pickNodeName`，3 条单测）：形状照抄真机抓到的原始通知——`PipelineNode.Starting`
  只有顶层入口名（`nameSource=entry`，如实标未确认）、`PipelineNode.Succeeded` 的内嵌 `node_details.name`
  是真名并压过顶层名、缺字段时退化到 `action_details`/`reco_details` 或可辨认兜底。
- **SoM 候选测量仪器** `npm run survey:som`（`scripts/survey-som.mjs`，离线）：报各源候选数、保留/合并总数、
  是否打满上限、横向分带分布、画面覆盖率与候选面积分布；`--limit` 可放开上限看被截掉的部分，
  `--edge-z` / `--edge-min` / `--iou` 可对边缘门槛与合并 IoU 做 A/B。配套 `annotate` 新增
  `somLimit` / `somEdgeZ` / `somEdgeMin` / `somIoU` **测量用覆盖**（默认仍是生产常数，行为不变）。
  首批 6 帧数据（roadmap.local.md 第九/十/十三轮）：4/6 帧打满、去重后真实规模中位 54、默认上限只放出 41%，
  并据此修掉了候选表的位置偏置（见「修复」）；edge 门槛与合并 IoU 经 A/B **确认保持不动**。
- **裁剪参数测量仪器** `npm run survey:crop`（`scripts/survey-crop.mjs`，离线，不需要设备）：以关键帧库留存帧为  数据集、网格 ROI 批量跑 `tpl_crop`，输出 snap 触发率、**snap 真起作用率**（最终框≠原宽松框）、**塌陷率**、
  自匹配位置正确率、得分/评估次数/耗时分布，按帧分组汇总，可 `--json` / `--out` 落盘；
  `--cases <json>` 可换成**用例文件模式**（真实 UI 目标 + 同一元素的多档余量）。
  配套 `tpl_crop` 新增 `snapTol?` / `snapFrac?` **测量用覆盖**（默认仍是生产常数，行为不变）——定标靠 A/B。
  第一批数据（36 例网格）结论：默认常数在位置正确率上优于"更敏感"档（91.7% vs 83.3%），
  **塌陷是症状不是失败**；第二批（15 例真实 UI 目标）结论：位置正确 14/15、**框每边留 6–10px 最稳**，
  余量给到元素尺寸 60–80% 时 snap 会偏而 `positionOk` 不报警。详见 roadmap.local.md 第八/十五轮。
- 新单测 `test/unit-crop-kf.mjs`（7 条）：库帧三重校验（文件在 / sha256 对 / 像素尺寸与库记录一致）、
  L2 出处字段与白名单（整条库记录递进来也不带设备来源）。
- 新验收 `npm run accept:crop`（`scripts/accept-crop-fromkf.mjs`，26 条，**离线不需要设备**）：
  库帧裁剪、出处落盘、L0 不可变、空间比对如实为 null、替换与尺寸不符各自拒绝、CLI 一行命令走通。
  该脚本需 maa-node 加载资源，不进 CI（与 `accept` 同属需要原生绑定的验收）。

### 新增（首批实现）

- **daemon + 客户端 + CLI 三件套**：常驻 daemon 持有 Controller / Resource / Tasker 与连续帧流
  （fps / scale / maxFrames 可调）、环形缓冲与原生日志环，JSON 行协议不绑定宿主；可复用客户端
  `maafw-live/client`（spawn、应答配对、超时硬杀自愈）；确定性 CLI 输出稳定 JSON 信封（`--json`）
- **变化检测**：分块亮度差 + 全局位差率双阈值，change / stable 事件按帧序对齐；`calibrate` 静止
  画面定噪声地板，推荐 blockThresh / changeGlobal
- **观测与像素按需取用**：帧元数据先行，`frame` 按 seq / ROI（控制器分辨率坐标，按该帧捕获时
  尺寸换算）精确取图；像素默认不出 daemon，纯文本模型可用
- **运行与输入**：`run` 运行 pipeline（项目模式合成 pipeline_override 四级链，`--timeout 0`
  不自动停，任务级 `record.ok` 定退出码，节点事件按帧序对齐）；`stop`；输入注入十原语
  （click / swipe / key / keys / press / dbclick / scroll / move / text，经 maafw 控制器本体，
  动作边界帧自动入 L0 锚区）
- **识别实测**：`reco` 子进程隔离单测（`--param` / `--sweep` 阈值扫描、`--node` V1/V2 整节点
  透传、`--act` 识别拿框 → 真机执行动作半链路）；`color` 探色；`crop` 模板裁剪（snap 收紧 +
  同帧自匹配逐边精修 + 跨帧验证，位置正确优先于得分）；`annotate` 轻量 SoM 候选区域编号回画；
  `timing` 实测节点时长与稳定时间反推 timeout / wait_freezes / delay 建议（`--runs` 取 P50/P95
  分布）
- **关键帧留存契约 v0**：L0 原图缓存（滚动区 + 锚区、字节配额）、输入 / run 边界帧自动入锚区、
  `kf promote` 升格本地库（捕获身份固定、幂等重试、sha256 校验、磁盘配额）、`kf:` 引用离线解析；
  契约与验收记录见 `docs/keyframe-retention-contract-v0.md`
- **interface.json（ProjectInterface v2）解析**：控制器规划（控制器类型 / 窗口匹配 / 截图与输入
  方法 / 识别缩放）、资源路径四级 override 链、import 合并、preset 默认值；**agent 完整桥接**
  （项目声明 agent 时 run 自动 spawn agent 子进程并经 maa.Client 接入，maa-node 与 agent 侧
  maa 库须同版本）
- **测试面**：纯函数单测（变化检测 / L0 淘汰 / snap 收紧 / SoM 候选 / interface 链 / 库配额 /
  timing 分布）、装配级回归 `npm run verify`（断言 stdout / stderr / 退出码外部契约）、离线与
  模拟器两套契约验收脚本
- **发布流程**（对齐 create-maa-project / MaaEvidenceKit）：本 CHANGELOG 为 release notes 唯一
  来源；`RELEASING.md` 记录流程；`.github/workflows/ci.yml` 跑 push / PR 回归；tag 触发
  `.github/workflows/release.yml` 校验（tag 与 package.json 版本一致、CHANGELOG 段落存在、全量
  回归、npm pack）后创建 GitHub Release——notes 由 `scripts/release-notes.mjs` 从 tag 树的
  CHANGELOG 提取，tarball 挂为附件。全程只用内置 `GITHUB_TOKEN`，无凭据配置，不经 npm registry

### 修复（发布前对账）

- 退出码 **130（用户中断）删除**：仅有常量声明、无信号发射点（Ctrl-C 由 shell 兜底）。下游不应
  再写 130 分支
- README 退出码表第 3 行只列真实触发条件：「校验不通过 / 存在待处理项」在本仓库无生产者。现列：
  run 的调用级失败（未连接 / 资源缺失 / 已有任务在跑）、reco 识别未命中（含 `--act` 单测失败）、
  crop / color / annotate / calibrate 的失败或警告、kf manifest / promote 失败、device 未发现
  设备。1 与 3 的核心区分不变：1 = 没跑成（含任务失败 `record.ok=false`），3 = 跑成了但有问题
- `--help` 删除过期路线图：timing 与关键帧留存均已实现却被列为「尚未实现」。help 只描述现状
- `docs/daemon-protocol.md` 与实现对齐（该文件是下游引用的唯一协议出处）：
  - `run` 的 `timeoutMs` 硬上限残留（≤300000）改为真实语义：缺省 30000、下限 500、`0` 不自动停
  - `input` 补全 10 种 kind（此前缺 dbclick / press / keys / scroll / move）与 `retention` 返回
    （动作边界帧，自动入 L0 锚区）
  - `reco_test` 补 `node` / `act` / `templateImage` 参数与 `act` 的返回形状
  - `frame_get` 返回补 `ctrlW/ctrlH`，并注明 `w/h` 是缓冲小图尺寸
  - 补 6 个从未入表的命令：`l0_status`、`kf_promote`、`tpl_crop`、`color_probe`、`annotate`、
    `calibrate`（含 kf promote 语义：身份接受时固定、L0 淘汰即失败、重试幂等）

### 变更（首批）

- `--no-interactive` 与 `--yes` 措辞降级：两者当前均无门控（本工具没有交互式提问与确认步骤），
  照传即可——保留解析是防后续版本引入交互时挂住自动化调用
- 许可证 BSD-3-Clause → **MIT**，并补上此前缺失的 LICENSE 文件（快照只有 package.json 声明、
  无许可文本）；去掉的仅是「不得用作者名义背书」条，对下游使用无影响
- 本地工作区文档移出 `docs/`（根目录 `roadmap.local.md`，入 `.gitignore`）：`files` 白名单目录
  会压过 ignore 规则，留在 `docs/` 内会进 npm 包

[Unreleased]: https://github.com/Windsland52/maafw-live/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Windsland52/maafw-live/releases/tag/v0.1.0
