# daemon 协议（maafw-live core）

这份文档是**为了被复用而存在**的：任何宿主（编辑器插件、自动化平台、CI 脚本、
其他语言写的壳）都可以直接跟这个 daemon 说话，而不必依赖本仓库的 CLI 或 TypeScript 客户端。

实现：`src/daemon/framed.mjs`（随包发布为 `lib/daemon/framed.mjs`）。
客户端参考实现：`src/client/daemon.ts`（`@windsland52/maa-live/client` 导出）。

## 传输

    node <daemon>/framed.mjs --child

- **stdin**：每行一条 JSON 请求 `{ id, cmd, ...args }`。
- **stdout**：每行一条 JSON 消息（见下）。**非 JSON 行不是错误**——它是 maa 框架的原生日志，
  照原样收进日志环（识别失败的根因常常只在这里出现）。
- **stderr**：同样是原生日志。
- 不带 `--child` 时该模块无副作用，可直接 import（`__test` 导出纯函数用于无设备回归）。

一进程一会话：**一个 daemon 子进程 = 一个设备会话**（一个 Controller + Resource + Tasker + 帧流）。
同一台设备同一时刻只允许一个所有者；需要多设备就起多个子进程，但占用规则由调用方负责。

## 消息

| 形状 | 方向 | 含义 |
|---|---|---|
| `{ id, cmd, ...args }` | 调用方 → daemon | 请求；`id` 由调用方自增，`-1` 可作一次性通知 |
| `{ kind:'reply', id, ok, data }` | daemon → 调用方 | 应答成功 |
| `{ kind:'reply', id, ok:false, error }` | daemon → 调用方 | 应答失败（业务失败也是这一形状，不抛异常） |
| `{ kind:'frame', meta, preview? }` | daemon → 调用方 | 每接受一帧的元数据；`preview` 是预览帧 PNG 路径 |
| `{ kind:'event', ev }` | daemon → 调用方 | 画面变化/稳定事件与 Tasker 节点消息（按帧序对齐） |
| `{ kind:'stream_error', error }` | daemon → 调用方 | 帧流自身出错（设备掉线等），流可能已停 |
| `{ kind:'stream_stopped', reason }` | daemon → 调用方 | daemon 主动停流（控制器被销毁，如 `connect` 重建）：流已不在跑，要看帧得重新 `stream_start` |

`meta` 至少含 `seq`（帧序，单调递增）、`t`（毫秒时间戳）；差异检测命中时含 `diff`。
`ev.type` 取值：`change` / `stable`（画面）、`run`（节点级消息，含 `node`、`msg`、`id`）。

**像素默认不出 daemon。** 调用方先拿 `frame` 元数据，需要画面时再用 `frame_get` 精确取
（可带 `roi`）。这条是为了让 LLM 的上下文不被像素挤爆，也是面板与模型共用同一份缓冲的原因。

## 命令

| cmd | 参数 | 返回要点 |
|---|---|---|
| `init` | `runDir`、`kfQuotaBytes?`（字节，>0 生效；缺省 1GiB，env `MAAFW_KF_QUOTA_BYTES` 亦可覆盖；env `MAAFW_NOTIFY_DUMP=<file>` 把框架原始通知逐行 JSON 落盘，用于诊断"记录字段到底是谁填的"，默认关） | `{ ok, previewPath, daemonId, framesDir, kfQuota }`；设定预览帧落盘路径与关键帧库磁盘配额。应在 spawn 后立刻发一次——本仓客户端把它当**握手**（`client.init()`）：回执里的 framesDir / daemonId / kfQuota 对宿主可见，无应答或失败会如实回报并进错误环，不再被静默丢弃 |
| `probe` | — | `{ version, adb, win32, errors[] }`：绑定版本与设备发现数 |
| `device_list` | `kind: all\|adb\|win32` | 设备数组：`{ kind, id, name, cls?, adbPath? }` |
| `connect` | `kind: adb\|win32\|gamepad`，`target`，可选 `screencap`/`mouse`/`keyboard`/`gamepadType`（枚举名），可选 `shortSide`/`longSide`/`rawSize` | `{ ok, session, streamStopped? }`；`session` 含 `kind/target/name/cls/method/resolution/warns`。**会先销毁已有 Controller**——因此若上一轮在跑帧流，本次连接会**显式停掉它并回 `streamStopped:true`**，同时向订阅者推一条 `stream_stopped`（要看帧就重新 `stream_start`；旧行为是流循环静默死掉而状态仍报"在跑"） |
| `disconnect` | — | `{ ok }`；停流、销毁 Tasker/Controller。adb 的 destroy 偶发阻塞 → 客户端超时后硬杀自愈 |
| `screencap` | `out` | `{ ok, path, bytes }` 或 `{ error }` |
| `stream_start` | `fps`(1-30)、`scale`(160-1280)、`maxFrames`(20-600)；可选 `l0Roll`/`l0Anchor`/`l0Bytes`/`blockThresh`/`changeGlobal`（L0 与变化检测调优） | `{ ok, fps, scale, maxFrames }` |
| `stream_stop` / `stream_status` | — | 状态含 `running, fps, scale, maxFrames, seq, ring, events, full, session` |
| `frame_get` | `seq?`（缺省最新）、`roi?: [x,y,w,h]`、`out?`、**`src?: auto\|full\|ring`**（缺省 `auto`） | `{ ok, path, bytes, w, h, seq, t, diff, ctrlW, ctrlH, source, sourceResolution, degraded, requested?, warn? }`。`roi` 是**控制器分辨率坐标**，与 pipeline 里的 roi 同空间。<br>**带 `roi` 时**：`auto` 先从该 seq 的 L0 全分辨率原图 1:1 裁（`source:"l0-full"`、`sourceResolution:1`），L0 已淘汰才退环形缓冲小图（`source:"l1-ring"`）并**附 warn**；`full` 只要原图，淘汰即报错——**绝不拿一张缩小图冒充**；`ring` 强制小图（显式选择，不附警告）。<br>**不带 `roi`（整帧）时**：**只有显式 `full` 才是 L0 原图**；`auto` / `ring` 一律给环形缓冲那一帧（既有契约，`sourceResolution` 如实标注）——整帧小图是缺省行为而非降级，**不警告、不判 findings**，否则最普通的 `frame get`（不带 roi）会时不时退 3。<br>**`degraded`** 是**相对"调用方要什么"**的判断，不是"分辨率 < 1"：带 `roi` 的 `auto` 退成小图才算降级（`true` + warn，CLI 退出 3）；显式 `ring` 与整帧小图都是预期行为（`false`）。消费方按这个字段决定要不要报警，别拿 `sourceResolution` 自己反推。<br>**⚠ 行为变更（0.2.0 → 未发布）**：**仅**带 `roi` 的缺省路径由"必走 L1 小图"变为"有 L0 就用控制器分辨率原图"；不带 `roi` 的整帧行为**未变**。依赖 `w/h` 恒为小图尺寸的消费方请显式传 `src=ring`，或改读 `sourceResolution` |
| `frame_diff` | `a`、`b`（两个缓冲 seq）、`rois: [[x,y,w,h],…]`（控制器分辨率） | `{ ok, a, b, dtMs, rois[{roi,meanDiff,maxDiff,pixels}], ranked, sourceResolution, note }`。**回答"这一步究竟改了哪几块 / 哪几格"**——帧流事件只给整帧 bbox，而离散网格（棋盘 / 背包 / 技能格）要的是每格变了多少。`ranked` 按 `meanDiff` 降序给 roi；`meanDiff` 是 0..255 的平均亮度差，**判"变了/没变"的闸门要先用静止画面实测**（同 calibrate 的思路），不当普适常数用 |
| `wait` | `mode: stable\|change`、`timeout?`（ms，200–120000，默认 10000）、`quiet?`（ms，默认 600）、`roi?`、`threshold?`（默认 3） | `{ ok, mode, satisfied, waitedMs, seq, quietMs, roi?, threshold?, lastRoiMeanDiff?, warn? }`。**状态谓词：等到条件成立再往下读，取代调用方硬睡时钟**。判据复用帧流同一套（最近 `quietMs` 内有无 `change` 事件 + 可选 ROI 内逐帧均值差 `>= threshold` 记为"在动"），不另立阈值口径。**超时不是命令失败**：`ok:true` + `satisfied:false`（CLI 退出码 3）——"没等到"是观测结果。环形缓冲一帧都没有时**直接报错**，不空转到超时再给"画面持续变化"这种假原因。`change` 的回看窗口含命令开始前 `quietMs` 内的事件，所以紧接 `click` 之后的 `wait change` 可能秒满足——它说的是"**动了**"，不说明"到了目标界面"；到了哪一屏要用识别或留存帧复核 |
| `l0_status` | — | `{ ok, seq, roll, anchor, bytes, framesDir, library }`：L0 滚动区/锚区条目与字节用量（两区共享帧只计一次）、关键帧库用量与配额 |
| `kf_promote` | `seq`（数字）或 `latest:true` | `{ ok, id, record, path, sha256, idempotent? }`；捕获身份在接受请求时固定，L0 已淘汰则失败（不改取新帧冒充）；同一捕获重试幂等返回原对象。契约见 [keyframe-retention-contract-v0.md](keyframe-retention-contract-v0.md) |
| `tpl_crop` | `roi:[x,y,w,h]` 或 `point:[x,y]` + `pad?`、`resourceDir`（自匹配要加载资源）、`seq?`（缺省最新 L0 原图）、**`kfSource?`**（关键帧库留存帧：`{id,path,sha256,ctrlW,ctrlH,captureSeq,capturedAt}`，与 `seq` 二选一）、`out?`、`cross?`（`false` 关跨帧验证；库帧路径缺省关，`true` 才做）、`prov?`（`false` 不写 L2 出处侧车）、**`provOut?`**（出处侧车改写到该目录下、保持同名；缺省写在模板旁——用于"模板进资源包、出处留包外"的项目，此时不变量是同一相对路径而非同一目录）、**`keepSource?`**（热缓存路径下，把**本次裁剪实际用的那一帧**升格进关键帧库，出处随即带上可复核的 `kf:` 身份；不取最新帧。来源本就是 `kfSource` 时无意义）、**`snapTol?`/`snapFrac?`**（snap 收紧阈值的**测量用覆盖**，默认即生产常数 90 / 0.12；定标时 A/B 用）、**`edge?`**（**边缘收紧那一路，默认 `false`**：`true` 时把"局部对比度"判据也放进候选池，常数可再覆盖 `edgeZ?`（环上对比度 p90 的倍数，默认 2）/`edgeMin?`（绝对地板，默认 24）/`edgeFrac?`（行/列命中比例门槛，默认 0.02）。**定标结论：不采用为默认**——在 `scripts/truth/1999-720p.json`（12 例）上它单独用 IoU 均值只有 0.50–0.59，而背景差分是 0.804；边缘判据找到的是**元素内部结构**（文字笔画/图标细节）而不是元素范围，所以"取更紧者"会把框收进元素内部（实测 0005 物品卡片 0.866 → 0.449，严口径 precision 91.7% → 83.3%）。旋钮留着是为了可复跑这张对照表） | `{ ok, path, seq, source, provPath, provenance, spaceCheck, box, loose, tighten, snapped, score, positionOk, selfMatchBox?, cross?, tries, w, h, ctrlW, ctrlH, keptSource?, warn?, warns? }`；snap 收紧 + 同帧自匹配逐边精修，判据**位置正确优先于得分**（纯色模板的 CCOEFF_NORMED 得分是噪声）。`kfSource` 路径**不需要设备**，裁剪前校 sha256 与像素尺寸（不符即拒），`seq` 为 `null`；`source.kind` 是 `kf` / `l0-cache`；`spaceCheck` 是源帧空间与当前控制器尺寸的比对（未连接时为 `{current:null,match:null}`）；`provenance` 同时写 `<out>.prov.json`（契约 §5）。**`tighten`** 是贴合度信号：`{from:[w,h], to:[w,h], areaRatio, grew, looseMatch?}`——`grew:true` 表示"收紧反而放大"（背景差分没收到元素边界，留白仍在）并会带一条警告；`looseMatch` 是宽松框自己的自匹配结果，**有才带**（池内提前命中就会跳过它）。**别拿"宽松框 vs 最终框的得分"判贴合度**：自匹配是自洽指标，实测同一元素在 40×61 / 80×80 / 120×120 三种窗口下都是 1.0 且都落回自己——几何比例才分辨得出 |
| `color_probe` | `roi?: [x,y,w,h]`（控制器分辨率，缺省全帧）、`seq?` | `{ ok, seq, roi?, pixelRoi, count, mean, hsv, dominant, space }` |
| `annotate` | `resourceDir?`（OCR 候选源需要）、`seq?`（会话内环）、**`kfSource?`**（关键帧库留存帧，与 `seq` 二选一：控制器分辨率、**不需要设备**）、`out?`、**`roi?: [x,y,w,h]`**（只保留落在该区域内的候选，**在取上限之前过滤**——区域内的候选只跟自己竞争）、**`somScale?: full\|small`**（检测面；缺省 `full`）、**`somLimit?`/`somMaxAreaRatio?`/`somEdgeZ?`/`somEdgeMin?`/`somIoU?`**（候选上限、巨框剔除阈值、边缘 z 门槛、边缘绝对地板、合并 IoU 的**测量用覆盖**，默认 30 / 0.12 / 1.2 / 2000 / 0.6） | `{ ok, out, seq, source, detectionSource, count, limit, mergedTotal, sources, filtered, availability, sourcesUnavailable?, small, ctrl, candidates[] }`；候选 = OCR / 连通域 / 边缘密度 / diff 区域（IoU>0.6 去重合并），`candidates[].ctrl` 是控制器坐标，另带 `areaRatio`（控制器空间面积占比，供排序：越小越像小按钮）与 OCR 的 `score`。<br>**检测面分辨率决定小目标能不能被找到**：缺省优先用同一 seq 的 **L0 全分辨率原图**做检测（`detectionSource:"l0-full"`），L0 已淘汰才退降级小图（`"l1-ring"` + `source.degraded` 与说明）。**为什么必须这样**：实测主页面顶部一个 42×55 的图标，在 480 宽的 L1 上四个源一个都没探到（合并池仅 30 条、零截断却仍然没有它），在 1280 宽原图上连通域一次就命中——**漏报的根因是分辨率，不是上限**。代价是耗时上升（单次约 20–40 秒），要旧行为给 `somScale:"small"`。<br>**上限截断按横向分带轮转，带内再按来源轮转**（旧行为是带内保持源优先级，OCR 几十条会把 conn/edge 挤光，而图标类目标恰多来自 conn/edge）。`mergedTotal` 是去重后的真实规模，与 `count` 不等即表示有截断。`filtered` 是被门槛拒掉的计数（`conn: {passed,tooSmall,tooLarge,tooNarrow}`、`edge: {passed,belowZ,belowMin,singleBlock}`）。<br>**`availability` 是"看起来有结果 ≠ 有结果"的护栏**：`{limit, mergedTotal, truncated, dropped:{tooSmall,tooBig,duplicated}, maxAreaRatio, roi?, byBand[{band,yFrom,yTo,inPool,inTable}], outResolution, detectionResolution}`——分带三列一起读才分得清"这一带真没有"与"这一带被门槛/上限拿掉了"。**注意 `tooSmall` 的 8px 门槛在检测面空间**：检测面从 480 升到 1280 后，同一门槛在控制器空间相当于松了约 2.7×，跨检测面的 `dropped`/`filtered` 数字不可直接比（`detectionResolution` 就是用来对冲这件事的）。库帧路径 `seq` 为 `null`、`small` 与 `ctrl` 同为帧尺寸（换算系数 1），且 **diff 源不可用**（没有会话事件，如实报在 `sourcesUnavailable`，不拿别的区域顶替） |
| `calibrate` | `frames?`（6-60，默认 24）、`interval?`（ms，默认 300） | `{ ok, frames, block, global, recommended{blockThresh,changeGlobal}, apply, warn? }`；静止画面定噪声地板 |
| `run` | `entry`、`resourceDir` 或 `resourceDirs[]`、`override?`、`agents?`（PI 声明的 agent 桥接）、`timeoutMs?`（缺省 30000，下限 500；`0` 不自动停，停止权交调用方） | `{ ok, record }`；`record.nodes[]` 含每节点 `id/name/nameSource/status/ms/seq/msgs`，`startSeq/endSeq` 用于把节点事件对回帧序，`record.retention` 是任务边界帧。`name` 取自框架的 `node_details.name`（`nameSource: "node_details"` = 权威）；框架在 `PipelineNode.*` 顶层填的是**任务入口名**，所以完成前该字段可能是 `entry` 兜底值（`nameSource: "entry"` = 未确认，此时别拿它当"跑了哪个节点"）。`record.nextCandidates` 是框架本轮**宣布过的候选序列**（`{seq, name, polls, jumpBack?, anchor?}`，连续重复折叠成 `polls` 计数，上限 50 条；`nextCandidateCount` 是公告总次数）——分支可见性用它，配合节点名即可还原"轮询了哪些出口、最后走了哪个"。超时内置 `post_stop`，防 JumpBack 死循环 |
| `run_stop` | — | `{ ok }` |
| `input` | `kind: click\|dbclick\|press\|swipe\|key\|keys\|scroll\|move\|text\|app\|touch_down\|touch_move\|touch_up` + 对应参数（见下） | `{ ok, kind, ms, retention, path?, viaCount?, stepMs? }`；`retention.before/.after` 是动作边界帧，自动入 L0 锚区。**after 帧统一在 `job.wait()` 之后抓**，所以它含动作落地后的画面（手势类尤其要紧：要验的是"抬手之后变成什么样"） |
| `reco_test` | `resourceDir`、`type`、`image` / `seq` / **`kfSource?`**（关键帧库留存帧：`{id,path,sha256,ctrlW,ctrlH,captureSeq,capturedAt}`，控制器分辨率、**不需要设备**，与 `image`/`seq` 三选一）、`param?`、`sweep?{key,min,max,step}`、`node?`（整节点 JSON 透传，V1/V2 由框架解析）、`act?`（配 `node`：识别拿框 → 真机执行动作半）、`templateImage?`（调用方裁好的模板，不写资源目录） | `{ ok, type, meta, results[] }`；`meta.source` 是 kf ID / 文件路径 / `seq`（库帧路径如实报 kf 身份）。`act` 时含 `reco/action/stage/retention`。除 `act` 外在**一次性子进程**里执行：beta 绑定遇到无效模板会原生崩溃，子进程炸掉只损失一次测试。**识别跑了但一个置信度都没带回来**（`results[].detail.detail.best` 空、`all` 为空）与"分数低的未命中"是两种形态：前者是模板/资源当时读不到，别当画面不匹配处置 |
| `shutdown` | — | 停流 + 断开 + 退出进程；回执 `{ ok:true }` **先落地再退**（`process.exit` 不冲 stdout，而调用方在等这条应答） |

`input` 的参数：`click{x,y,contact?,pressure?}`、`dbclick{x,y,gap?}`、`press{x,y,duration?,contact?,pressure?}`、
`swipe{x1,y1,x2,y2,duration?,contact?,pressure?,via?}`、`key{code}`（Android KeyEvent 码）、
`keys{codes,hold?}`（数组或逗号/加号分隔）、`scroll{dx,dy}`（格数，建议 120 的倍数）、
`move{dx,dy}`（相对移动，Win32/MacOS）、`text{text}`、`app{action:start\|stop,intent}`、
`touch_down{x,y,contact?,pressure?}` / `touch_move{x,y,contact?,pressure?}` / `touch_up{contact?}`。
全部经 maafw 控制器本体注入，不直接调 adb。

**`swipe` 的 `via`**：中途路径点（`[[x,y],…]` 或 `"x,y;x,y"`）。给了它就走
`touch_down → 逐点 touch_move → touch_up`，也就是**一条笔画画出折线**（回执带 `path`/`viaCount`/`stepMs`）；
不给则走原生 `post_swipe`（只有两个端点，只能画直线）。**为什么需要**：连线 / 谱曲 / 拖拽排序这类玩法
要求"按住 → 经过若干点 → 抬起"，且**中途不能抬手**——一旦抬手就是新笔画，很多玩法会把新笔画当成
另一次操作或直接静默忽略。需要跨多条命令维持同一次按压时，用裸原语
`touch_down` / `touch_move` / `touch_up` 自己拼序列。

## 坐标系（最容易出错的一条）

识别与输入共用**控制器分辨率空间**：默认按 interface.json 的 `display_short_side`（缺省短边 720）
缩放。`roi`、模板图、`click` 坐标全在同一空间。只有显式传 `shortSide`/`longSide`/`rawSize`
才会改变它——那意味着项目里所有 roi 与模板都要按新尺寸重算。

## 落盘约定（`out` 类参数）

会产出文件的命令（`screencap` / `frame_get` / `tpl_crop` / `annotate`）都接受 `out` 指定路径。
**不传 `out` 时落在 daemon 的 run 目录下 `out/`（一次性命令给的是临时目录），不写调用方的 cwd**——
调用方的 cwd 通常就是项目仓库，而这些命令本质是"看/量"，产物只是顺便落盘（实测踩过两次：
`maa_frame_*.png`、`maa_som_*.png` 进了仓库根）。要留住产物就显式给 `out`。

## 稳定性约定

- 命令**只增不改**：参数名与返回字段名一律不重命名，删字段等于静默破坏所有消费者。
- 新增命令请同时更新本文件与 `src/client/daemon.ts` 的类型。
- 帧元数据与事件的字段同样只增不改（面板与 timing 反推都按字段名读取）。

## 复用示例

    import { spawnDaemon } from '@windsland52/maa-live/client'

    const c = spawnDaemon({ runDir: '/tmp/maa-run' })
    try {
      const info = await c.call('probe')
      await c.call('connect', { kind: 'win32', target: '记事本' })
      await c.call('stream_start', { fps: 10 })
      c.subscribe('event', (ev) => console.log(ev))
      const shot = await c.call('frame_get', { roi: [0, 0, 200, 120] })
      console.log(shot.path)
    } finally {
      c.close()
    }

CLI 侧的等价物是 `maafw-live repl`（一次连接、多步操作），以及 `maafw-live probe|device|connect|run|click|reco` 等一次性命令。
