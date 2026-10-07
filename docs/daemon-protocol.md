# daemon 协议（maafw-live core）

这份文档是**为了被复用而存在**的：任何宿主（编辑器插件、自动化平台、CI 脚本、
其他语言写的壳）都可以直接跟这个 daemon 说话，而不必依赖本仓库的 CLI 或 TypeScript 客户端。

实现：`src/daemon/framed.mjs`（随包发布为 `lib/daemon/framed.mjs`）。
客户端参考实现：`src/client/daemon.ts`（`maafw-live/client` 导出）。

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

`meta` 至少含 `seq`（帧序，单调递增）、`t`（毫秒时间戳）；差异检测命中时含 `diff`。
`ev.type` 取值：`change` / `stable`（画面）、`run`（节点级消息，含 `node`、`msg`、`id`）。

**像素默认不出 daemon。** 调用方先拿 `frame` 元数据，需要画面时再用 `frame_get` 精确取
（可带 `roi`）。这条是为了让 LLM 的上下文不被像素挤爆，也是面板与模型共用同一份缓冲的原因。

## 命令

| cmd | 参数 | 返回要点 |
|---|---|---|
| `init` | `runDir`、`kfQuotaBytes?`（字节，>0 生效；缺省 1GiB，env `MAAFW_KF_QUOTA_BYTES` 亦可覆盖） | `{ ok, previewPath, daemonId, framesDir, kfQuota }`；设定预览帧落盘路径与关键帧库磁盘配额。应在 spawn 后立刻发一次 |
| `probe` | — | `{ version, adb, win32, errors[] }`：绑定版本与设备发现数 |
| `device_list` | `kind: all\|adb\|win32` | 设备数组：`{ kind, id, name, cls?, adbPath? }` |
| `connect` | `kind: adb\|win32\|gamepad`，`target`，可选 `screencap`/`mouse`/`keyboard`/`gamepadType`（枚举名），可选 `shortSide`/`longSide`/`rawSize` | `{ ok, session }`；`session` 含 `kind/target/name/cls/method/resolution/warns`。**会先销毁已有 Controller** |
| `disconnect` | — | `{ ok }`；停流、销毁 Tasker/Controller。adb 的 destroy 偶发阻塞 → 客户端超时后硬杀自愈 |
| `screencap` | `out` | `{ ok, path, bytes }` 或 `{ error }` |
| `stream_start` | `fps`(1-30)、`scale`(160-1280)、`maxFrames`(20-600)；可选 `l0Roll`/`l0Anchor`/`l0Bytes`/`blockThresh`/`changeGlobal`（L0 与变化检测调优） | `{ ok, fps, scale, maxFrames }` |
| `stream_stop` / `stream_status` | — | 状态含 `running, fps, scale, maxFrames, seq, ring, events, full, session` |
| `frame_get` | `seq?`（缺省最新）、`roi?: [x,y,w,h]`、`out?` | `{ ok, path, bytes, w, h, seq, t, diff, ctrlW, ctrlH }`。`roi` 是**控制器分辨率坐标**，与 pipeline 里的 roi 同空间；`w/h` 是缓冲小图尺寸，`ctrlW/ctrlH` 是控制器分辨率 |
| `l0_status` | — | `{ ok, seq, roll, anchor, bytes, framesDir, library }`：L0 滚动区/锚区条目与字节用量（两区共享帧只计一次）、关键帧库用量与配额 |
| `kf_promote` | `seq`（数字）或 `latest:true` | `{ ok, id, record, path, sha256, idempotent? }`；捕获身份在接受请求时固定，L0 已淘汰则失败（不改取新帧冒充）；同一捕获重试幂等返回原对象。契约见 [keyframe-retention-contract-v0.md](keyframe-retention-contract-v0.md) |
| `tpl_crop` | `roi:[x,y,w,h]` 或 `point:[x,y]` + `pad?`、`resourceDir`（自匹配要加载资源）、`seq?`（缺省最新 L0 原图）、`out?`、`cross?`（false 关闭跨帧验证） | `{ ok, path, seq, box, loose, snapped, score, positionOk, selfMatchBox?, cross?, tries, w, h, ctrlW, ctrlH, warn? }`；snap 收紧 + 同帧自匹配逐边精修，判据**位置正确优先于得分**（纯色模板的 CCOEFF_NORMED 得分是噪声） |
| `color_probe` | `roi?: [x,y,w,h]`（控制器分辨率，缺省全帧）、`seq?` | `{ ok, seq, roi?, pixelRoi, count, mean, hsv, dominant, space }` |
| `annotate` | `resourceDir?`（OCR 候选源需要）、`seq?`、`out?` | `{ ok, out, seq, count, sources, candidates[] }`；候选 = OCR / 连通域 / 边缘密度 / diff 区域（IoU>0.6 去重合并，上限 30），`candidates[].ctrl` 是控制器坐标 |
| `calibrate` | `frames?`（6-60，默认 24）、`interval?`（ms，默认 300） | `{ ok, frames, block, global, recommended{blockThresh,changeGlobal}, apply, warn? }`；静止画面定噪声地板 |
| `run` | `entry`、`resourceDir` 或 `resourceDirs[]`、`override?`、`agents?`（PI 声明的 agent 桥接）、`timeoutMs?`（缺省 30000，下限 500；`0` 不自动停，停止权交调用方） | `{ ok, record }`；`record.nodes[]` 含每节点 `id/name/status/ms/seq/msgs`，`startSeq/endSeq` 用于把节点事件对回帧序，`record.retention` 是任务边界帧。超时内置 `post_stop`，防 JumpBack 死循环 |
| `run_stop` | — | `{ ok }` |
| `input` | `kind: click\|dbclick\|press\|swipe\|key\|keys\|scroll\|move\|text\|app` + 对应参数（见下） | `{ ok, kind, ms, retention }`；`retention.before/.after` 是动作边界帧，自动入 L0 锚区 |
| `reco_test` | `resourceDir`、`type`、`image` 或 `seq`、`param?`、`sweep?{key,min,max,step}`、`node?`（整节点 JSON 透传，V1/V2 由框架解析）、`act?`（配 `node`：识别拿框 → 真机执行动作半）、`templateImage?`（调用方裁好的模板，不写资源目录） | `{ ok, type, meta, results[] }`；`act` 时含 `reco/action/stage/retention`。除 `act` 外在**一次性子进程**里执行：beta 绑定遇到无效模板会原生崩溃，子进程炸掉只损失一次测试 |
| `shutdown` | — | 停流 + 断开 + 退出进程 |

`input` 的参数：`click{x,y,contact?,pressure?}`、`dbclick{x,y,gap?}`、`press{x,y,duration?,contact?,pressure?}`、
`swipe{x1,y1,x2,y2,duration?,contact?,pressure?}`、`key{code}`（Android KeyEvent 码）、
`keys{codes,hold?}`（数组或逗号/加号分隔）、`scroll{dx,dy}`（格数，建议 120 的倍数）、
`move{dx,dy}`（相对移动，Win32/MacOS）、`text{text}`、`app{action:start\|stop,intent}`。
全部经 maafw 控制器本体注入，不直接调 adb。

## 坐标系（最容易出错的一条）

识别与输入共用**控制器分辨率空间**：默认按 interface.json 的 `display_short_side`（缺省短边 720）
缩放。`roi`、模板图、`click` 坐标全在同一空间。只有显式传 `shortSide`/`longSide`/`rawSize`
才会改变它——那意味着项目里所有 roi 与模板都要按新尺寸重算。

## 稳定性约定

- 命令**只增不改**：参数名与返回字段名一律不重命名，删字段等于静默破坏所有消费者。
- 新增命令请同时更新本文件与 `src/client/daemon.ts` 的类型。
- 帧元数据与事件的字段同样只增不改（面板与 timing 反推都按字段名读取）。

## 复用示例

    import { spawnDaemon } from 'maafw-live/client'

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
