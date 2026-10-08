# Changelog

maafw-live 的重要更改记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **`crop --keep-source`：顺手把源帧留在库里**——热缓存路径下，把**本次裁剪实际用的那一帧**（按 `seq`，
  不取最新帧）升格进关键帧库，出处随即从"只有一个随进程消失的 seq"升级为**可复核的 `kf:` 身份**；
  回执多一个 `keptSource`。没加它而出处是热缓存来源时，`crop` **如实警告**（出处无从复核，建议加 `--keep-source`
  或先 `kf promote`）。动机是真机开发里踩到的：先做的五张模板出处**全是 l0-cache**，sha256 之外无从复核——
  契约的模型是「L0 缓存 → 选择性升格 → 从库帧裁 L2」，而中间那一步以前只能人手补。
  实现上**升格必须在裁剪计算之前**：自匹配 + 跨帧验证要 1–2 秒，滚动区小的时候（实测 `l0Roll=2`、流 5fps）
  那一帧早被淘汰——验收里就是这么先失败一次的。
- **`crop --prov-out <dir>`：出处侧车可以写到资源包外**——缺省仍在模板旁（"同生共死"，复制/改名时出处跟着走）；
  给了这个开关就把 `<out>.prov.json` 写到该目录下、保持同名。动机是真机开发时撞到的：模板要进资源包的
  `image/`，而发行打包按 `interface.json` 的 `resource[].path` **整目录拷贝**——侧车（含本机库 UUID）会
  随包发给用户，而它是给开发者的过程资产。配套把不变量从"同一目录"改成**同一相对路径**（契约 §5 已同步：
  建议与 `image/` 同构，例如 `state-plan/provenance/`），并可在项目里加一条对账检查防漂移
  （本仓试验项目加了 `tools/check-provenance.mjs`，挂进它的 `pnpm check`）。验收 +4：K11a–c（落点/模板旁不留/逐字段一致）
  与 CLI 的 C1e。
- **`version --check`：更新检查（只报不换）**——对 registry 查 latest，报出"该升级了"并给出升级命令。
  刻意的取舍：**不自动切换运行时**（agent 长任务跑到一半换版本，比晚一天升级风险大）；**只在交互终端自动查**
  （管道与 agent 调用不付代价）；**限频 24h**（结果缓存到 `~/.maafw-live/version-check.json`）；
  **可关**（`MAAFW_LIVE_NO_UPDATE_CHECK=1`）；**失败一律静默**（离线不影响 `version` 本身）。
  显式 `--check` 不受 TTY/限频约束：查到新版退出 `FINDINGS(3)`，查不到退出 `ENV(4)`（离线要说出来，
  不能假装"已是最新"）。
- **`survey:crop --truth`：裁剪定标的误报/漏报（补上"对外可验证"的那一半）**——`--truth <json>` 吃人工标注的
  元素框（`[{id,label,box:[x,y,w,h],frame?,why?}]`，id = 库内序号后四位），把每个最终框与真值按 IoU 对账：
  **recall** = 被某个最终框覆盖的真值比例（严口径，IoU ≥ `--truth-iou`，默认 0.5），**precision** = 沾到某个
  真值框的最终框比例（松口径"重叠即算"）。两个方向各另报一种口径，并附命中框的**贴合度**（最终框/真值框
  面积比），好把"没找到"/"找到了但框太松"/"框落在没标注的空处"三种失分分开读——只看「位置正确率」时，
  这三种是同一种"通过"。两条分母规则同样钉住：**没有标注的帧不判分**（记 `unscored`）、
  **没有被任何输入框问到的真值不算漏报**（记 `uncovered`，`truthsAsked` 才是 recall 的分母）——
  后者是 `--cases` 只跑一半元素时的坑："没问"不是"没找到"。
  不给 `--cases` 时按 `--truth-pad`（缺省 `6,25%`）从真值框自动生成两档输入：
  每边 +6px（按建议余量给框）与长边 25%（给大框，正是历史上 snap 会偏的那种输入）。
  人工真值**种子集** 6 个元素在 `scripts/truth/1999-720p.json`（判定口径、标注规则、加标注流程见同目录
  README）——这是种子集、要长，首批只覆盖此前真机验证过的元素，不是全集。
  首批数据（4 帧 12 例，离线复跑两次逐例一致）：**recall 100%（6/6）、precision 100%（12/12 沾到真值）、
  严口径 precision 91.7%、命中框面积比中位 1.09（最大 1.83）**。唯一一处"压住了但框不贴合"是「窗中侧写」
  按长边 25% 给框（IoU 0.362、面积 2.76 倍，自洽指标 `positionOk` 对它全绿）；真值还量出「今日奖励」那张
  此前真机用过的框面积是文字的 2.3 倍（IoU 0.39）——"位置正确 + 自匹配 1.0"看不出这两件事。
  拿它复评**上一轮的真机框数据集**（`--cases` + `--truth`，15 例）就看得更清楚：recall **80%**
  ——唯一漏报就是「今日奖励」（两个余量档的最佳 IoU 0.389 / 0.103），而那两张框当时 `positionOk` 全是"对"；
  负控（弹窗下半屏大面积极化模糊）被同时记为**严松两个口径的误报**，`positionOk=false`。
  也就是说：自洽指标能抓"完全找不到自己"，抓不到"框不贴合"。

### 变更

- **skill 的 §0 写清"项目从哪来不影响本工具"**（`skills/maafw-live/SKILL.md`）：本工具只读 `interface.json`
  里的控制器条目与 `resource[].path`，`resource/` 与 `resource/base/` 这类布局差异都实测能连能跑；
  识别空间由控制器条目（如 `display_short_side`）决定、与目录布局无关，**唯一要守的是别把两套坐标系混起来**。
  自己新建项目时跟随该项目生态的既定布局即可——skill 不指定任何一套脚手架。
- **skill 补一条真机撞出来的反模式**（`skills/maafw-live/references/pitfalls.md`）：
  **识别框默认就是动作框**——`Click` 落点是 target 框内的随机点，没给 `target` 时 target 就是识别框，
  所以"框里有一片空地"就有概率点在空地上（实测：宽 115px 的入口模板右侧 40% 是空地，一次 `run` 的点击
  就这么丢了，而动作回执照样 `Action.Succeeded`——**动作成功 ≠ 点到了东西**）；对策是把模板裁成按钮本体
  （`crop --point` 点图标中心）或显式给 `target`。
- **skill 补「首次上手：一条最短路径」与 `[JumpBack]` 分支的读法**（`skills/maafw-live`，随包发布）：
  SKILL.md 新增 §0 六步表（认清环境 → 连一次 → 先看见 → 实测 → 裁 → 看到就留档），每步带一条"过不了就别往下走"
  的判据，并写明**第 6 步是唯一无法补救的一步**（前四步都能事后重做，唯独"当时那一帧"只有升格过才重做得了）；
  references/examples.md 新增样例 8：带 `[JumpBack]` 的两候选分支真机跑通（一对一错候选，模板全来自留存帧），
  把 `record.nextCandidates` 在分支场景里的读法写死——**序列第一条是任务入口本身、不是一次轮询；
  `polls` 折叠只发生在同一候选连续重复时，多候选交替公告时 `polls` 恒 1、要按条数数轮次；
  `[JumpBack]` 候选带 `jumpBack: true` 且从不折叠；没命中的候选不产生节点记录**——所以"轮询过哪些出口"
  只能从 `nextCandidates` 读、"实际走了哪条"从 `record.nodes` 读，两层合起来才是分支的完整故事。
- **`annotate` 回执新增 `filtered`**：分别记下被门槛拒掉的候选——`conn: {passed, tooSmall, tooLarge, tooNarrow}`、
  `edge: {passed, belowZ, belowMin, singleBlock}`。"某一段没有候选"是内容如此还是被过滤掉，以前只能从结果侧猜。
  首批实测（3 帧）：面积窗下界拒掉约 **97%** 的连通域（通过 27–53、`tooSmall` 1460–1698），
  而 edge 的绝对地板**从不触发**（`belowMin` 全 0）、门槛全在 z 上。
- **清掉三处死代码**（都是"没人引用却一直留着"）：`repl.ts` 的 `replFail`（导出但全仓零引用，
  连带把只剩它一个用处的 `fail` 导入去掉）、`env.ts` 里 `framework` 明细的 `if (maafw)` 内又判
  `!maafw` 的那一支（永远不可达）、`version.ts` 的 `...(explicit ? {} : {})` 空展开。
  死代码本身无害，但它会让"这条分支到底什么时候走"变成需要现场推演的问题。

### 修复

- **重连后帧流静默死掉**（真机验收 R1 抓到的 flaky）：`connect` 会先销毁并重建 Controller，而流循环
  `streamTick` 撞到空控制器时**只 `return`、不再排期**，于是循环死了而 `stream` 状态仍是"在跑"——
  之后 `stream_start` 被"已启动"挡回去，表现为**重连后一帧都不来**（实测：`frame_get` 停在旧 seq/旧尺寸，
  而 `screencap` 一切正常，很容易误判成"设备卡了"）。现在：tick 撞到空控制器会**把流显式停掉**并推
  `stream_stopped` 事件；`connect` 也主动停流并在回执里报 `streamStopped:true`（CLI 会打印一行"帧流已停止…
  要看帧就 stream start 重开"）。验收 R1 补上"重连后必须重开流"这一步并恢复为稳定通过。
- **`resolveFrame` 对非字符串 id 抛 TypeError**：调用方漏字段时（实测：验收里读 `derivedFrom.id` 为 undefined）
  解析函数抛 `startsWith` 异常，把整条验收打断。它的契约是"如实报状态"，现在非字符串/空 id 一律返回
  `missing` + 说明，并加单测钉住（5 种坏输入）。
- **`crop` 把"资源里没有可加载的 pipeline"误报成"低纹理/不独特"**：自匹配要起识别子进程，而资源包为空时
  子进程会安静地回 `ok:true` + `results: []`（一个 case 结果都没有），旧代码把这句翻译成
  "模板在同帧上都定位不到自己（best 落在 null，得分 0.000）"——**工具的安装问题被说成了内容问题**，
  处置方向正好相反（去修资源 vs 去换框）。实测：真机上 `resource/pipeline/` 还是空的时候连撞两次；
  放一个（哪怕无关的）pipeline 文件后，同框同 roi 的自匹配立刻 1.0。
  现在：子进程回空结果即判定"自匹配没跑起来"，警告直说原因与下一步（先写一个 pipeline 节点或给
  `--resource-dir`），并明确"这次的框**未经自匹配验证**，不要拿它去写 pipeline"；`positionOk` 仍为 `false`。
  验收加 K10 四条（空资源包仍出图、警告如实归因、不再出现"低纹理"、未验证状态如实）。
- **`survey:crop` / `survey:som` 的进度点与末尾汇总会被截断**：`process.exit()` 在 stdout 是管道时
  （`> out.txt`、`| tee`）会丢掉还没落地的缓冲——实测 12 个进度点只冲出 6 个，汇总行也可能一起没。
  改为 `process.exitCode` 让事件循环自然排空（daemon 已 shutdown）。
- **`npm run survey:som` 根本不存在**：`scripts/survey-som.mjs` 在、文档也在教它跑，但 `package.json`
  只定义了 `survey:crop`——照做的 agent 拿到 "Missing script"。补上别名，与 `survey:crop` 对称。
- **`--dry-run` / `--limit` / `--verbose` 是假承诺**：三个都只被解析、全库无人消费（`--dry-run` 说
  "只计算不落盘"，实际照样写模板与帧文件）。现在帮助文本、README 与 `GlobalFlags` 注释统一标为
  **预留未实现**——解析位照留（防后续引入时挂住自动化调用），但不再承诺行为。
- **根目录 13 张设备截图（`maa_som_*` / `maa_screencap_*`，合计 8.1MB）从索引移除**：它们是
  `out` 缺省落 cwd 时代的产物（`6882ac1` 进 11 张、`a8f67d1` 又进 2 张），并给 `.gitignore`
  加上 `maa_*.png`。历史里仍可取回；工作区文件未删。随后这批图**从全部历史中清除**（重写了含它们的
  4 个提交，作者/日期/message 逐字节保留；tag 与已发布版本不受影响，`.git` 从 13.6MiB 降到 395KiB）。
- **`stream_stopped` 是"只发不收"的孤儿消息**：daemon 在控制器被销毁时推它（`framed.mjs`），但客户端
  `DaemonMessageKind` 里没有它、分发链里也没分支——消息被静默丢弃，订阅者收不到、日志也不留痕，
  只能从 `connect` 回执的 `streamStopped` 间接推断。现在：类型联合加 `stream_stopped`、分发链补分支
  （进错误环 + 推给订阅者）、协议文档消息表补一行、`subscribe` 的载荷按种类写进类型注释。
- **`crop --keep-source` 在坏参数上也会升格**：框参数（`--roi` / `--point`）的校验排在取源与升格之后，
  于是"忘了给框"的失败调用照样往关键帧库塞一条留存帧。现在校验提到最前——坏请求不取源、不解码、不升格；
  升格仍在自匹配之前（那条纪律不变）。
- **`survey:crop` 每跑一次漏一个 `%TEMP%` 目录**：自造的资源目录（`maafw-survey-res-*`）从不回收，
  实测本机攒了 14 个。现在 runDir 与自造目录统一回收；清理失败也不再盖掉测量结果（Windows 上
  `close()` 的 kill 有 1.5s 延迟，紧接着 `rmSync` 偶发 EPERM）。
- **`tplCrop` 的 TS 参数类型失真**：`provOut` / `keepSource` 已实装并被 CLI 使用，类型里却没有
  （靠对象展开逃过多余属性检查），`snapTol` / `snapFrac` 也缺——补齐后调用方传错名会被 typecheck 拦住。
- **`pngDecode` 对像素数据长度不作校验，会静默产出全黑图**：IDAT 解压后字节不足时，`line[x]` 取到
  undefined → `NaN & 255` 变成 0，于是"解码没解出东西"和"画面本来就是黑的"长得一模一样——
  观测类工具最不能出的错就是把解码失败当证据。现在解压后断言正好 `h ×（1 + 行字节）`，不符即报错
  （截断的文件本来就在 `inflateSync` 那步抛，这条挡的是"合法 deflate 但字节不够"那一类）。
- **`shutdown` 不回执就退出**：`process.exit(0)` 排在应答之前，于是"最后一条命令没有回执"——
  调用方若真的 `await` 它，只能拿到超时或"daemon 已退出"。现在 shutdown 回 `{ ok:true }`，
  并等这条回执写到 stdout 再退（`process.exit` 不等冲刷，所以用 write 回调兜住）。
- **配额注释说"≤0 视为不设限"，但 env 与 init 都到不了 0**：`S.kfQuota > 0` 的判据本身是有意的
  "0 = 不设限"（单测直接改 `S` 走这条），注释却把不可达的入口写成了用法。改成如实描述：
  代码层 0 = 不设限，但 `MAAFW_KF_QUOTA_BYTES` / `init kfQuotaBytes` 都只认 >0。
- **`accept-emulator` 的 R2e 故障注入在 Linux 上不生效（会假失败）**：原来把 `manifest.json`
  `chmod 0444` 来注入写失败，但 daemon 是 tmp + rename 写入——POSIX 的 rename 只看目录写权限、
  不看目标文件的只读位，于是 Linux 上照样写得进去，"必须写失败"的断言就成了假失败（只有 Windows 有效）。
  改成把 `manifest.json.tmp` 这个路径**占成目录**：POSIX 报 EISDIR、Windows 报 EPERM/EACCES，
  两端都必失败，而且不必再改动库文件本身。真机复跑 R2e/R2e2/R2e3 全过（判据没被削弱）。
- **`accept-emulator` 的临时 runDir 从不回收**：本机实测攒了 15 个 `maafw-acc-*`（每跑一次漏一个）。
  现在 R1–R3 读完后统一回收，并用 `maxRetries` 兜住 Windows 上 close 的 kill 延迟导致的 EBUSY/EPERM。
- **`accept-emulator` 末尾汇总可能被 `process.exit` 截断**：与 survey 脚本同一个坑（stdout 还没冲完
  就退出，管道里尤其明显）。改成 `process.exitCode` 让事件循环自然排空。
- **`tpl_crop` 的非数字入参一路变成 NaN 框**：`roi` / `point` / `pad` 里只要有非数字元素，
  `Number()` 出来就是 NaN，夹取、裁剪、snap 全在 NaN 上跑，最后报出来的失败跟病因无关。
  现在算框之前先校验，直接报 `roi / point / pad 必须是数字`。线上会遇到的形态是 `[0,0,"x",10]`
  这类（JSON 里 NaN 会变 null，而 `Number(null)` = 0 是合法数字，所以只测 NaN 是不够的）。
- **`annotate` 的 TS 类型缺四个测量覆盖**：`somLimit` / `somEdgeZ` / `somEdgeMin` / `somIoU` 在 daemon
  与协议文档里都有、客户端类型里没有（与 `tplCrop` 同一类失真）——补齐并逐字段写明语义。
- **客户端的 `init` 回执被静默丢弃**：spawn 后用 `id:-1` 把 init 发出去就不管，而分发链只认
  pending 表里的 id——回执被当"未知 id"丢掉，于是宿主拿不到 `framesDir` / `daemonId` / `kfQuota`，
  init 失败（例如 runDir 建不出来）也无从得知。现在它是一次真正的**握手**：`client.init()` 返回
  `{ ok, data }` 或 `{ ok:false, error }`，失败另进错误环；同时**不把"对方不回 init"变成致命错误**
  （协议要求每条请求都有应答，但客户端不该因为对方没回一条就全盘不进）。
  `kfQuotaBytes` 也随之可验证地透传（真机探针：`12345` 原样回来）。
- **REPL 的输入命令完全不校验数字参数**（空参 `click` 会在真机上点 (0,0)）：CLI（`input.ts`）每条
  都有 `Number.isFinite` 校验，REPL 一条都没有——`Number(undefined)` = NaN → JSON 里变 `null` →
  daemon `Number(null)` = 0。REPL 复用同一个设备会话，敲错一个坐标就是一次真实输入，这条比 CLI
  更要紧。现在 8 个输入命令都先校验：不合法只打印用法、**一个请求都不发**（用记录型桩 daemon 验过：
  旧代码发的是 `{"kind":"click","x":null,"y":null}`，新代码什么都不发），`--duration` / `--gap` 之类
  的旗标同样走校验，`keys` 与 CLI/daemon 统一成"只保留正整数"。
- **一次性命令的截帧临时文件从不回收**：`crop` / `annotate` / `color` 每次自动截一帧喂 L0，落盘的
  那份用完就不管了——本机实测攒了 **42 张 / 53.71 MB**。现在收口成 `seedObservation()`：截帧只为
  产生一次观测，daemon 收到时已把像素读进缓冲，落盘那份用完即删（失败也不抛，命令自己会报
  "先 screencap / stream"）。真机跑完三个命令，临时目录计数不变。
- **`timing --override` 与 `run --override` 对非对象值处理不一致**：`run` 有守卫（原样替换），
  `timing` 直接展开 `fields`——字符串会被摊成 `{0:'a',1:'b'}`、`null` / 数字静默变成空对象，
  等于把用户写的节点悄悄丢掉；而 `override.ts` 里的四级链本来就有正确守卫，同一判据三处各写一份。
  现在合并收口成唯一的 `mergeOverride()`，三条路径共用。
- **嵌套 option 自引用会栈溢出**：`case.option` 允许再列 option，A → B → A 这种自引用让递归停不下来，
  整条 `run` 被 RangeError 打断。现在记一条可行动的警告并跳过重复那一步，链上其他覆盖照常生效。
- **客户端写 stdin 的同步抛（EPIPE）没兜住**：daemon 在 spawn 与写入之间就死掉时，`write` 会同步抛
  `ERR_STREAM_DESTROYED`——`init` 的契约是"失败如实回报、不抛"，却会因此 reject；`call` 也会甩出
  一条看不懂的原生错误。两处都改成可读的失败（`init 发送失败` / `daemon 请求发送失败`）。
- **`reco` 没有离线库帧入口**（`crop` / `annotate` 都有 `--from-kf`）：以 `--image kf:…:0011` 喂库帧 ID
  （SKILL 与 roadmap 里都这么记过）会被当**文件路径** → `ENOENT`。现在 `--from-kf <kf:…>`（配
  `--frames-dir`）是一等入口，`--image kf:…` 作为等价写法一并认；daemon 的 `reco_test` 新增 `kfSource`
  分支（与 `crop`/`annotate` 共用同一套三层校验），并与 `--seq` / `--act` 明确互斥。
- **"识别跑了但拿不到分数"以前和"普通未命中"长得一模一样**：两者都打 `[未中]`，只是前者没有阈值建议行
  ——而这两件事的处置方向相反（前者是模板/资源**当时读不到**，后者才是画面不匹配）。现在人类输出直说
  "识别未返回任何置信度…别当成画面不匹配去调阈值"，JSON 信封加 `noConfidence: true`。
  **这正是 roadmap 那条"未解释的间歇"的签名**（当年现场：8 连未中、~222ms、无置信度行），
  并已用"模板文件不存在"确定性地复现该签名（`detail.best` 空、`all` 空、~226ms）——那一批不是
  "画面变了"，是输入当时读不到。
- **`reco_test` 写出的工作图从不回收**：会话缓冲帧路径（`--seq`）与新的库帧路径都会把工作图写到
  `%TEMP%/maa_reco_*.png` 却不管了。现在用完即删（A/B：关掉清理时真机实测 `0 → 1`，开着时 `0 → 0`）。
  与 CLI 侧截帧泄漏同一类，只是位置在 daemon。
- **`--resource <名|路径>` 会丢掉 `controller.attach_resource_path`**：不传 `--resource` 时附加路径
  会追加（v2.2.0："在 `resource.path` 加载完成后，额外加载"），可传了就走进两条**提前 return** 的分支，
  附加路径直接消失。它是**控制器的属性**、与选中哪个资源条目无关，所以三条分支都该追加。真实项目实测
  （MaaEnd，8 个控制器声明了附加路径）：`--resource 官服` 修复前只加载 1 条路径、`resource_adb` 丢失，
  修复后 2 条齐全——这类项目里附加包正是控制器专属的图像/模型，丢了就是"识别找不到模板"。
- **被导入文件里的 `import` 被静默吞掉**：`import` 不可嵌套——被引用文件由 `interface_import.schema.json`
  约束（MaaFW 5.14.2 @ `8061d5b`：顶层只有 `task`/`option`/`pretask`/`global_option`/`setting`/`preset`，
  且 `additionalProperties: false`；协议文档 3.3 的 `import` 节也没有嵌套写法）。此前我们既不展开也不报，
  于是"拆出去的二级文件"整份消失得无影无踪。现在记一条 problem 并说明（与 `controller`/`resource`
  不可导入的处理一致），提示作者改成平铺。

### 测试

- `stream_stopped` 推送分发 1 条（`test/unit-client-stream.mjs` + 桩 daemon `test/fixtures/`）：
  无设备、无 maa-node 也能跑——真 daemon 只在控制器销毁时推这条，而缺口在客户端这一侧。
- `tpl_crop` 坏参数不升格 1 条（`test/unit-crop-kf.mjs`）：用合法 L0 原图 + 临时 runDir，
  旧顺序会在 `runDir/frames` 下落库，所以这条用例有牙齿——单测总数 94 → 96。
- `pngDecode` 拒收像素数据不足 1 条（`test/unit-framed.mjs`）：自造"结构合法、IDAT 字节不够"的 PNG，
  并配一张同尺寸给足字节的对照，确认拒的是长度而不是别的东西。
- `shutdown` 回执 1 条（`test/unit-daemon-shutdown.mjs`）：裸协议 spawn 真 daemon 子进程，
  断言"先收到 `{ok:true}`、进程再退 0"——客户端把 shutdown 当"发了就不管"，所以这条只有裸协议看得见；
  shutdown 路径不碰 maa 绑定（`loadMaa()` 懒加载），CI 里也不需要设备。单测总数 96 → 98。
- `tpl_crop` 非数字入参 1 条（`test/unit-crop-kf.mjs`）：NaN、非数字字符串、非数字 pad 三种形态都要
  报用法错误、且不碰库——单测总数 98 → 99。
- **公开导出 `@windsland52/maa-live/image` 补 9 条单测**（`test/unit-image.mjs`）：尺寸、只缩不放
  （小图返回同一个 Buffer）、长边收敛与比例、maxSide 下限 16、裁剪像素逐点一致、越界夹紧语义
  （原点夹进画布、尺寸再夹边界——与 daemon `frame_get` 同源）、**RGBA 源归一化成 RGB**（自造
  colorType 6，`pngEncodeRGB` 只出 RGB，不测这条等于没测）、data URL 互转与坏输入返回 null。
- **客户端协议面 3 条**（`test/unit-client-protocol.mjs` + 桩 daemon）：init 握手回执可读、
  对方不回 init 时如实回报并留痕（沉默桩）、`stream_stopped` 订阅与错误环。两个桩都不需要设备与
  maa-node——这些缺口的本体都在客户端一侧。（原 `unit-client-stream.mjs` 并入本文件。）
- **override 合并 2 条**（`test/unit-interface.mjs`）：`mergeOverride` 的对象浅合并 + 非对象值原样
  替换（字符串 / null / 数字 / 数组四种形态）、嵌套 option 自引用只记警告不栈溢出（两条都做了 A/B：
  关掉守卫各自立刻变红）——单测总数 110 → 112。
- **REPL 输入校验的真机验证**：空参 `click` 只打印用法（记录型桩 daemon 确认零请求）；合法
  `click 620 520` 落到设备（`ok:true, ms=272`，带回前后 retention 帧）。
- **interface 解析 2 条**（`test/unit-interface.mjs`）：`resolveResourcePaths` 四条分支（缺省 /
  `--resource <名>` / `--resource <路径>` / 未指定控制器）都带上 `attach_resource_path`；
  被导入文件里的 `import` 记 problem 且不展开（两条都做了 A/B，各自关掉守卫立刻变红）——
  单测总数 112 → 114。
- **单测夹具写错了字段名**：三处 `interface.json` 夹具写 `version: 2`，而 PI v2 要的是
  `interface_version: 2`（`version` 是项目版本号，字符串）——于是每个夹具都白挂一条
  "缺少 interface_version" 的 problem，跟用例要验的东西混在一起。改对之后补了一条守卫断言：
  夹具自身必须是合法 PI 文件（断言里明写"字段名是 interface_version，不是 version"）。
- **`accept:crop` 新增 R 组 5 条**（离线、不需要设备、进 CI）：`reco --from-kf` 跑通且源身份是库帧、
  第三形态标记（`noConfidence`）、人类输出把第三形态说清楚、`--image kf:…` 等价入口、
  与 `--seq` 互斥 → **43 → 48 条**（汇总标签同步为 K/C/R/S）。顺带把这个脚本里同一处
  `version: 2` 夹具字段名改对。
- **对 roadmap 待办 1（reco 成批翻面）的复现尝试与形态签名**（离线、两条路线各 10 连跑）：
  旧路线（`kf resolve` 出文件）与新路线（`--from-kf`，daemon 每次新写一张临时 PNG——正是它怀疑的
  杀软场景）共 **20 次全部命中**（box 恒为 `58,162,40,61`、score 1、222–241ms），**未复现**。
  同时把四种形态的签名钉死：命中 / 分数低的未命中（都打分数行）→ 资源没加载（**0 例**、无 `[命中]`
  行）→ **拿不到分数**（`[未中]` + **无分数行** + `detail.best` 空 + `all` 空 + ~226ms，当年那次就是
  这一种）；后者现在自报家门。
- **`unit-client-protocol` 的一条断言是时序竞态**（CI 在 Node 24 · ubuntu 上第一次抓到）：桩 daemon 在
  init 回执之后紧接着会推 `stream_stopped`，那条**按设计**会进错误环，于是"握手成功时错误环必须为空"
  这条断言本身不成立——本机（Node 22 / Windows）恰好每次都排在它后面。改成只钉"握手没被记成失败"
  （`/^init 失败/`），与推流通知无关，时序上不可能再红。这也是这次 push 唯一抓到的红：
  **`accept:crop` 在 Linux（Node 22.13 · ubuntu）与 Windows 两腿上都是绿的**——原生绑定在 ubuntu 上能跑，
  这条 CI 门禁值得留着。
- **补上两块结构性测试盲区**（都不需要设备，也不再依赖手工验证）：
  - `test/unit-repl-input.mjs` + **记录型桩 daemon**（`MAA_DAEMON` 指过去 + 管道喂 stdin）：REPL 的输入
    校验必须**只打印用法、零请求**——空参/非数字 `click`、`keys` 全非法、非法 `--duration`、参数不够的
    `swipe` 都算；同时合法 `click 620 520` / `scroll 0 -120` 必须照发。断言直接看桩收到的请求清单，
    所以"发没发出去"是可证的，不是从 stdout 猜的。
  - `test/unit-client-timeout.mjs` + **两阶段桩 daemon**（先卡死，放行标记出现后才应答）：调用超时 →
    **硬杀** daemon → 下次调用自动重生（`stats().restarts === 1`）。"硬杀"不靠 sleep 猜，而是轮询
    `stats().alive` 直到转 false——本仓刚在 CI 上被"靠时序的断言"坑过一次，这里刻意不重复。
  - 两条都做了 A/B：取修复前的 `repl.ts`（`4af7d49^`）→ **0 过 2 败**；把客户端的 `kill()` 改瞎 →
    断言"超时后必须硬杀 daemon"变红。**单测总数 114 → 117。**
- **真实项目核对**：拿本机 6 个 `interface.json`（MaaEnd / M9A / MST / maa-daily-lab /
  ArknightsAutoOperator / 官方 sample）跑只读探针，只有 MaaEnd 用 `attach_resource_path`（8 个控制器）；
  对它做了修复前后的 A/B——`--resource 官服` 由「1 条路径」变「2 条（含 `resource_adb`）」。
- **真机验收改动前后各跑一遍**（MuMu v5 / `adb 127.0.0.1:16384`）：`npm run accept` **27 过 / 0 败**，
  两遍一致；确认 R2e 换成"占目录"注入后判据仍成立，且临时 runDir 不再新增（跑前 15 / 跑后 15）。
- **`accept:crop` 挂进 CI**：它离线、不需要设备，却会真的起 daemon 与识别子进程（自匹配）——
  是唯一覆盖 client 的 spawn / 应答配对的验收。此前不进 CI 的理由是"需 maa-node 加载资源"，
  而 `@maaxyz/maa-node` 的平台包（含 `linux-x64`）本来就是 `npm ci` 装的，值得让 CI 说话。
  先只挂 CI（两个 OS）：它要是只在 ubuntu 上红，那是"服务器侧安装"的真实发现；
  确认绿过之后再决定是否同步到 release 的 check 作业（那条在 ubuntu 上跑且会挡住发版）。
- 验收新增/变更：`accept:crop`（离线）43 条——加 K11a–c（`--prov-out` 落点、模板旁不留、逐字段一致）与
  CLI 的 C1e；`accept`（真机，不进 CI）**27 条**——加 R4a–f（`--keep-source`：出处升级为 kf、`keptSource`
  与出处同 ID、落点、**该 ID 在本库可解析**，以及不加时的 `l0-cache` + 可行动警告），并修好 R1 重连流程。
- `resolveFrame` 非字符串 id 单测 1 条（5 种坏输入）——单测总数 92 → 93。
- 更新检查 6 条单测：数值段比较（`0.9.10 > 0.9.9`）、预发布低于同号正式版、24h 限频与坏缓存回落、
  scoped 名的 packument URL 编码、环境开关。
- 过滤器计数 2 条单测 + 一条实测记录：`passed` 必须等于实际返回框数；并钉住"`dev` 掩码是偏离局部均值，
  同色大块只留边缘环"与"`tooNarrow` 在合成形状上几乎不可达"这两个**实现语义**，免得后人当成 bug 去改。
- 真值判定 10 条单测（`test/unit-survey-truth.mjs`）：IoU 的退化情形（零面积、贴边、被包含）、两侧刻意不同的
  口径与各自的"另一种口径"、多对多（recall 记真值、precision 记最终框）、无标注帧只记 `unscored` 不冒充误报、
  没被输入框问到的真值只记 `uncovered` 不进 recall 分母（精度侧照常参与）、真值文件校验与**空间不符拒绝打分**、
  余量档位按长边换算并夹在帧内。

### 文档

- `RELEASING.md` 补三条实测坑：registry 传播延迟（实测 2–3 分钟，期间 `npm view`/安装全是 404，
  **不是发布失败**）、本机 npm 缓存会掩盖新版本（`ETARGET`，要 `--prefer-online`）、
  发布前必须本地干跑 `npm publish --dry-run`（`bin` 路径那类问题只有 publish 报）。
- **文档里的包名写错**：`README.md` / `docs/daemon-protocol.md` / `docs/keyframe-retention-contract-v0.md`
  都写 `maafw-live/client`，而包名是 `@windsland52/maa-live`（registry 上 `maafw-live` 不存在）——
  照抄示例必 `ERR_MODULE_NOT_FOUND`。全部改为 `@windsland52/maa-live/client`。
- **契约 §7 标注现状**：`reco` 参数丢失与 CLI 退出码两条早已修复，表头却仍写"均已证实、待实机复现"；
  同时删掉已被移除的"单次 run 超时上限 300s"（现为缺省 30s、`0` 不自动停，见 `daemon-protocol.md`）。
- **skill 里两条跑不通的命令**：`workflows.md` 让在 REPL 里跑 `l0 status` 与 `calibrate`，而 REPL 只有
  `kf status`、`calibrate` 是一次性 CLI 命令——改成实际可用的形态。
- `kf promote` 的 usage 写 `[--seq n]`，实际只吃位置参数（strict 解析下 `--seq 42` 直接退 2）——改为
  `<seq>|latest`。

## [0.1.1] - 2026-10-08

> **首个经 CI + OIDC 发布的版本**：npm registry 走 trusted publishing（带 provenance），
> 同一份 tarball 同时进 GitHub Packages，并由工作流创建 GitHub Release。
> 0.1.0 是本地发布（无 provenance）、其 tag 的发布工作流因 action 版本写错未能运行——详见下节。

### 修复

- **`env` 在缺少某个探测目标的机器上会整条失败**（CI 的 Windows runner 必现，本地因 adb/python 齐全
  而一直没暴露）：`.cmd` / `.bat` 被直接交给 `execFile` 时，新版 Node 会**同步抛 EINVAL**
  （CVE-2024-27980 的修复），而 `src/exec.ts` 里那次 `.cmd` 重试没有兜住同步抛，于是 Promise 直接
  reject，`Promise.all` 炸掉——`env` 以 `UNEXPECTED: spawn EINVAL` 退出，连"缺 adb"这个诚实结论都
  没机会说出来。这违反了该模块自己写的不变量「永不抛异常」。
  现在：`once()` 把同步抛也收敛成结果对象；`.cmd` 改为**先用 `where` 解析可执行路径、再经 `ComSpec` 执行**
  （`cmd /d /s /c ""<path>" <args>"` + `windowsVerbatimArguments`，实测唯一能跑通的拼法），
  并优先取带可执行扩展名的匹配（`where npm` 会先列出无扩展名的 POSIX 壳）。
  顺带避开 `shell: true` 的两个坑：给 shell 传参会触发 `DEP0190` 弃用警告，且"命令不存在"会退化成
  "cmd 跑起来了但退出 1"（本地化报错，判不准）。新增 `test/unit-exec.mjs` 5 条把契约钉住。
- **发布工作流引用了不存在的 action 版本**：`actions/upload-artifact@v8` 不存在（该 action 最新 v7，
  `download-artifact` 才是 v8），导致 `check` 作业在 "Set up job" 就失败、发布链根本起不来。改为 `@v7`。
- **装配回归的诊断信息**：`env --json` 若整条失败，现在会把 `error.code/message` 与 stderr 直接打进
  回归输出——这次 CI 只显示三条 data 断言红，得翻日志才知道是 `spawn EINVAL`。

## [0.1.0] - 2026-10-08

> 首个发布版本，**本地发布到 npm registry（`@windsland52/maa-live`，无 provenance）**；同一 tag 的发布
> 工作流因 `upload-artifact@v8` 不存在而未能运行，故 GitHub Release 由人工补建、GitHub Packages 的
> 0.1.0 未发。首个经 CI + OIDC 发布的版本是 0.1.1。
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

[Unreleased]: https://github.com/Windsland52/maafw-live/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Windsland52/maafw-live/releases/tag/v0.1.1
[0.1.0]: https://github.com/Windsland52/maafw-live/releases/tag/v0.1.0
