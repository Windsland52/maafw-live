---
name: maafw-live
description: 用 maafw-live 做 MaaFramework 应用的实时观测、识别实测、模板资产制作与状态证据留存——常驻 daemon 帧流、变化/稳定事件、历史帧按 seq/ROI 取用、reco 识别单测与阈值扫描、crop 模板裁剪（含从关键帧库留存帧离线裁剪）、kf 升格与离线解析、color 探色、annotate 候选区域编号、calibrate 噪声地板、timing 时长反推。Use when working on a MaaFW application with a device attached for deterministic observation, recognition measurement, template assets, or retention of a state that cannot be reproduced (including cropping templates offline from a keyframe library frame), or when running pipeline tasks and needing per-node evidence.
---

# maafw-live 使用动线

定位：**活设备上的动词与观测证据**——连接、截图、输入、运行任务、识别实测、留存关键帧。
不判断业务上完成了哪个状态；事后日志/诊断证据归 [MaaEvidenceKit](https://github.com/Windsland52/MaaEvidenceKit)（`maa-evidence`）；
字段与协议语义归 MaaLLMWiki 的版本锁定原文。

本事只写**动线、纪律、判据与反模式**：命令面与返回字段查
[daemon-protocol.md](https://github.com/Windsland52/maafw-live/blob/main/docs/daemon-protocol.md)、
留存与引用语义查[留存契约](https://github.com/Windsland52/maafw-live/blob/main/docs/keyframe-retention-contract-v0.md)、
CLI 命令与退出码查 [README](https://github.com/Windsland52/maafw-live/blob/main/README.md)
（npm 包内这三份就在 `skills/` 旁边的 `docs/` 与 `README.md`）。
三处是唯一出处，本 skill 不复述——复述出来的第二份迟早对不上。

## 硬护栏

1. **单会话单控制器**（红线）。一次性命令每次都 spawn 自己的 daemon，连接是进程态；它与你已开的面板/REPL
   并存 = 同一台设备上两个控制器互扰。交互探索用 `repl`（连一次、命令复用），验证用一次性命令，**不并发**。
2. **走框架链路**。识别输入与点击都必须来自框架截图链路（本工具 / 框架 API），不用 adb、外部截图工具或手工
   截屏——分辨率与像素空间一旦不同源，模板与 roi 全部作废。
3. **声明图像空间**。`roi`、模板图、`click` 坐标都在**控制器分辨率空间**（按项目 `display_short_side` 缩放，
   缺省短边 720）。历史帧按**该帧捕获时尺寸**换算，不按当前全局尺寸。源帧空间 ≠ 当前控制器空间时必须当回事：
   工具会警告（退出 3），不要拿这种模板去写 pipeline。
4. **判定分级**。调用成功（命令跑完）/ 任务成功（`data.record.ok`，**不是**退出码、也不是信封外层 `ok`）/
   业务验收（行为符合预期）。三层互不顶替；一次跑通 ≠ 稳定，验收要重复并含冷启动。
   读 `record.nodes[]` 认 `nameSource`：`node_details` 是框架给的权威节点名，可以据此判断走了哪条分支；
   `entry` 是顶层兜底（框架在节点完成前只报入口名），**未确认**——这种条目要用屏幕或留存帧复核。
5. **看到即升格**。L0 原图是进程态有界缓存，FIFO 淘汰，**淘汰即不可升格**。不可复现状态（一次性弹窗、
   当日签到、活动入口）必须在看到的那一刻 `kf promote`，攒到最后只会剩下没有证据。
6. **实测优先、一次一个变量**。参数、ROI、阈值、模板都实测（`reco` / `crop` / `color` / `timing`）；
   识别未命中**不是**调低阈值的理由——得分 < 0.5 说明模板与画面不匹配，该换模板/换识别方式。
7. **像素默认不出 daemon**。先拿元数据（`seq` / `hash` / `diff` / `w/h`），需要画面时再按 `seq` / `roi`
   精确取。这是为了让模型上下文不被像素挤爆——不要把整帧读进上下文当习惯。
8. **边界外的事交出去**。静态知识/校验归 MaaLLMWiki 技能；pipeline 改写归 maafw-pipeline；
   修复性诊断归 maafw-debug；事后日志证据归 maa-evidence。

## 0. 开工自检

```bash
maafw-live version && maafw-live env && maafw-live probe   # 版本 / 环境 / 运行时与设备发现数
maafw-live device --kind adb                                # 目标在不在
```

`env` 自身**永远不因环境残缺而失败**：缺依赖是探测结果，不是错误——读它的 warnings，别把它当门禁用。

连接优先 `--project <dir>`：控制器类型、窗口正则、截图/输入方法、识别缩放全跟项目声明走。**不猜设备**：
猜错不只是连错窗口，还会把 roi 与模板的坐标系一起猜错。手动连法（`--kind adb --target 127.0.0.1:16384`）
只在项目不可用或调试连接本身时用。

> 注意：`--short-side` / `--long-side` / `--raw` 只在**手动**连法下生效；它们改变识别空间，
> 意味着项目里所有 roi 与模板都要按新尺寸重算。

## 1. 动线 A：先看见（实时观测）

```bash
maafw-live repl --project ./my-maa-project     # 多步操作用它；也能被管道驱动
maa> stream start --fps 10                     # 帧流常驻：元数据 + 变化/稳定事件 + 环形缓冲
maa> frame get --roi 640,300,220,80 --out roi.png
```

- **事件告诉你"何时变"，不保证"都采到"**：低频阶段的一次性弹窗仍可能漏采。漏采的状态就是没有证据，
  按未知处理，不要用"现在的画面"冒充"当时的画面"。
- 变化检测阈值先实测：静止画面 `calibrate` 定噪声地板，再按它给的 `blockThresh` / `changeGlobal` 起流。
- 没有模板、不知坐标时用 `annotate`：OCR/diff/连通域/边缘候选 + 编号回画，选号即得控制器坐标；
  它和 `crop --point`（点选路径）互为降级。**读表先看两件事**：`mergedTotal` 与 `count` 是否相等
  （不等 = 表被上限截断；截断按横向分带轮转，某带为 0 就是供给真没有），以及目标那一带有没有候选。
  候选按源理解：OCR 贴文字、连通域偏亮连通区、边缘密度看梯度——都没有就走点选。
- 事后（没设备 / 状态已消失）仍可在**库帧**上跑：`annotate --from-kf <完整 ID>`。该路径没有会话事件，
  **diff 源不可用**（工具如实报 `sourcesUnavailable`）；要看"哪里变了"得用实时会话。
- 探色用 `color`（ROI 实测均值/HSV/主色），选完色再 `reco --type ColorMatch` 出框——不要让模型"报色值"。

## 2. 动线 B：识别实测（别猜参数）

```bash
# 整节点透传（V1 扁平 / V2 嵌套都原样交给框架解析）
maafw-live reco --node '{"recognition":"TemplateMatch","template":"tpl.png","roi":[640,300,220,80]}' \
  --resource-dir ./resource/base --image frame.png

maafw-live reco --type TemplateMatch --image frame.png --resource-dir ./resource/base \
  --sweep '{"key":"threshold","min":0.6,"max":0.95,"step":0.05}'
```

- 图像来源三条：`--image <png>`（离线文件）、`--seq`（缓冲帧，需 `repl` 里先 `stream start`）、
  `--act`（当前画面 + 真机执行动作半）。
- **读结果只认 `hit`**：miss 时框架仍会回 detail 对象，别把"有 detail"当命中。
- 阈值起点 = 实测最高置信度 − 0.1（留余量）；得分随场景会掉，换场景要复测。
- `--act` 是"识别拿框 → 用框真机执行动作"的半链路，验证 target 框语义与落点；它会**真的动设备**。
  判据两层：识别 `hit` + 动作 `success`，且**落点在命中框内**；动作边界帧在 `retention.before/after`，
  取"点之前/点之后"的画面用它，不要事后重截冒充。识别未命中时动作半不执行（`stage=recognition`）。
- 一次只改一个变量，改完立刻复测并留记录；多处同改后结果变化无法归因。

## 3. 动线 C：模板资产（crop）

```bash
maafw-live crop --roi 640,300,220,80 --project ./my-maa-project --out tpl.png      # 宽松框
maafw-live crop --point 700,340 --pad 24 --project ./my-maa-project --out tpl.png  # 点 + 外扩
```

输入可以粗糙（宽松框或一个点），工具做三件事：**snap 收紧** → **从控制器分辨率原图裁** → **同帧自匹配
逐边 ±2px 精修**。产物是 L2 派生图，旁边写 `<out>.prov.json` 出处（来源帧身份 + 裁剪变换 + 自匹配结论）。

判据（不合就换框，别硬交）：

- **位置正确优先于得分**：模板在同帧上都找不到自己（best 落在别处）说明它不独特——纯色/大面积同色区域的
  CCOEFF_NORMED 得分是噪声，得分高也可能位置错。
- 连接真机时会自动做**跨帧验证**（另抓一帧再匹配）；得分大幅衰减或位置漂移 → 模板对动态区域敏感，慎用。
- 只从**控制器分辨率原图**裁；绝不从降采样小图裁，也绝不上采样冒充原图。

## 4. 动线 D：不可复现状态 → 留存 → 离线裁模板

这是留存契约要支撑的核心动线：**观察到的那一刻留档，事后（换天、没连设备、状态已消失）还能裁出模板**。

```bash
# ① 看到状态：当场升格（repl 里 stream/输入/run 之后立刻做）
maa> screencap /tmp/state.png      # 或任意一次输入/任务边界帧，都会进 L0
maa> kf promote latest --note "活动弹窗"

# ② 事后（可以完全离线，不需要设备）
maafw-live kf list                                        # 看库里有什么、完整 ID
maafw-live crop --from-kf kf:<库UUID>:0142 --roi 570,118,140,58 \
  --project ./my-maa-project --out assets/tpl_popup.png   # → L2 + .prov.json
maafw-live kf resolve kf:<库UUID>:0142                    # available / missing / corrupt / unsupported
```

- 库帧就是 **L0 原图本体**（控制器分辨率、捕获时刻整帧），不是预览小图：升级的只是存在状态
  （进程态热缓存 → 库内文件），图的级别不变。
- `--from-kf` 缺省**离线**（不连设备）、缺省**不做**跨帧验证：留存帧对应的状态通常已不在画面上，
  拿当前帧比只会得到假警告；状态可复现时显式给 `--cross`。
- 裁剪前工具会校 sha256 与像素尺寸，不符即拒——不许把"另一个字节"当依据。
- 出处侧车随模板一起提交进仓库；**设备地址与目标不落进 L2**，它们留在本地 manifest。
- 裁出的模板就是 pipeline 素材：PNG 放进项目资源的 `image/`，节点写 `template` + `roi`，`run` 一发看
  `record.ok` 与节点状态（样例见 [references/examples.md](references/examples.md) 样例 5）。
- `missing` 只表示**本机**不可复核，不表示历史从未观测；L0 已淘汰时只能导 L1 参考帧，
  按契约它**不作 state 证据本体**。

## 5. 结果怎么读

| 退出码 | 含义 | 典型 |
| :--- | :--- | :--- |
| 0 | 正常完成，未发现问题 | 识别命中、裁剪通过 |
| 1 | 命令自身失败 / **run 的任务失败** | `data.record.ok=false`（含超时被停止） |
| 2 | 参数、用法错误 | 缺 `--roi`、`--from-kf` 与 `--seq` 同给 |
| 3 | **跑成了，但发现了问题** | 识别未命中、裁剪警告（低纹理/跨帧不稳/空间不一致）、kf 帧不可解析 |
| 4 | 前置环境缺失 | 缺 maa-node、缺设备、资源未解析 |

`--json` 时 stdout 只有信封（字段只增不改）。**业务失败不一定让调用失败**：外层 `ok` 只代表调用完成，
任务级结果看 `data.record.ok`。逐条消费注意见 [references/pitfalls.md](references/pitfalls.md)。

## 6. 反模式（照着犯的代价都写在 references/pitfalls.md）

- 边看边猜坐标：截一帧 → 猜 roi → 再截一帧。有帧流与编号候选，坐标应当**测**出来。
- 攒证据：等这一段做完再升格关键帧——那时 L0 早已淘汰。
- 拿 L1 小图裁模板或当状态证据。
- 用当前画面冒充"当时那次捕获"（升格已淘汰的 seq 必须**如实失败**，工具会拒绝帮你作弊）。
- 同一台设备上并发跑两个控制器（面板 + 一次性命令）。
- 把 `reco` 未命中当"阈值太高"直接调低，而不是先问"目标在不在帧里"。
- 用退出码 0 判定任务成功。
- 在节点事件回调里发任何控制器任务（截图/点击）——与框架识别回路抢控制器会触发原生崩溃。

## 7. 故障与降级

| 情形 | 处置 |
| :--- | :--- |
| 连不上 / 找不到设备 | `device` 看目标是否在列表；项目模式检查 `interface.json` 的 controller 声明与窗口正则 |
| 一次性命令的缓冲是空的 | `seq` 恒为 0、环内无历史：帧序对齐与历史帧只在 `repl` / 客户端订阅路径有效 |
| 资源未解析 / 缺模板 | `--resource-dir` 显式给，或修项目的 `resource[]` 声明 |
| 工具不可用 | **硬要求不随工具变**：像素空间一致 + 裁后自匹配复核 + 不猜参数；换工具要在结论里说明缺了哪项能力 |

## 参考

- [references/workflows.md](references/workflows.md)：四条动线的命令级细节、参数选择与实测经验值
  （末尾 **Z. 经验值速查**：框余量、判据链、耗时、候选上限/IoU/edge 的默认值与"改没改、为什么"）。
- [references/pitfalls.md](references/pitfalls.md)：真实教训与消费注意（含 daemon 协议易踩点）。
- [references/examples.md](references/examples.md)：真机样例——一次性状态留档后离线裁模板、分辨率空间守卫、
  两节点流程与 `record` 读法。

两件与本 skill 自身有关的事：

- **副本是否与 CLI 同源**：`maafw-live skill --check <安装根目录>` 逐文件比对（`same` / `different` /
  `missing` / `extra`，有漂移退出 `FINDINGS(3)`）；怀疑手里的 skill 比 CLI 旧就先跑它。
- **要动工具里的常数**：先量再改——`npm run survey:crop`（裁剪：snap 行为、位置正确率、成本）与
  `npm run survey:som`（候选：各源数量、上限截断、分带、覆盖率），都离线、不需要设备。
