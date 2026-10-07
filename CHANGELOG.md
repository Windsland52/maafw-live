# Changelog

maafw-live 的重要更改记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-10-07

首个发布版本。此前仓库以工作快照推进（下游 MaaTutorial `maafw-debug` 技能的评审核出于快照
`35c4e493`，未发布）；本版发布前把声明与实现逐条对账——消除「声明了但没有」的第三态——并建立
发布流程（CHANGELOG / CI / tag 触发的发布链）。下游结果契约「以本仓库文档为准」的引用请指向
`v0.1.0`。

### 新增

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

### 变更

- `--no-interactive` 与 `--yes` 措辞降级：两者当前均无门控（本工具没有交互式提问与确认步骤），
  照传即可——保留解析是防后续版本引入交互时挂住自动化调用
- 许可证 BSD-3-Clause → **MIT**，并补上此前缺失的 LICENSE 文件（快照只有 package.json 声明、
  无许可文本）；去掉的仅是「不得用作者名义背书」条，对下游使用无影响
- 本地工作区文档移出 `docs/`（根目录 `roadmap.local.md`，入 `.gitignore`）：`files` 白名单目录
  会压过 ignore 规则，留在 `docs/` 内会进 npm 包

[Unreleased]: https://github.com/Windsland52/maafw-live/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Windsland52/maafw-live/releases/tag/v0.1.0
