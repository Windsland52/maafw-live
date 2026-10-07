# 真机样例

环境：MuMu Player v5（Android，控制器 1280×720）+ `@maaxyz/maa-node` 5.14.2，
被测项目 = M9A（`interface.json` 默认控制器 ADB、资源 `resource/base`），游戏《重返未来：1999》。
数字都是实测值；命令里的路径换成你自己的。

## 样例 1：一次性状态留档 → 关掉 → 离线裁出状态标记

**为什么要这条动线**：每日签到弹窗一天只出现一次。看到它的时候不留档，回头就没有像素可裁——
这正是"捕获时刻的原图往往已经不存在"（留存契约开篇的需求来源）。

```bash
# ① 看到状态：当场升格（必须在捕获它的那个 daemon 会话里）
printf 'connect project ./M9A\nscreencap /tmp/state.png\nkf promote latest --note "daily signin popup"\nquit\n' \
  | maafw-live repl
#   → 已升格 kf:<库UUID>:0005（1280x720）

# ② 关掉弹窗（点一下），该状态当天再也不可能出现

# ③ 事后，离线（不连设备）从留存帧裁状态标记
maafw-live crop --from-kf kf:<库UUID>:0005 --roi 570,118,140,58 \
  --project ./M9A --out tpl_obtained.png
#   离线裁剪：未连接设备（留存帧是本机持久文件，裁剪不需要设备）
#   宽松框 [570,118,140,58] → 收紧 [589,124,101,23]     ← snap 把标题文字收出来了
#   自匹配 位置正确，得分 1（9 次评估）
#   空间核对：未连接设备，未与当前控制器尺寸比对（模板空间 = 源帧捕获时尺寸 1280x720）
#   L2 出处：tpl_obtained.png.prov.json
```

复核（判据是"只在留存帧上命中"）：

| 被检图像 | 结果 |
| :--- | :--- |
| 留存帧（库内 L0） | `hit=true score=1 box=[589,124,101,23]` |
| 当前实时画面（弹窗已关） | `hit=false`（同帧另一张物品卡片模板同样 miss） |

**结论**：这张留存帧是该状态唯一的证据；模板从它离线裁出且出处可追溯。这是 `--from-kf` 存在的理由。

## 样例 2：离线裁出的模板在实时帧上仍然命中（像素空间一致）

```bash
maafw-live crop --from-kf kf:<库UUID>:0003 --roi 925,138,68,70 --project ./M9A --out tpl_icon.png
maafw-live screencap --project ./M9A --out live.png          # 另取一帧实时画面
maafw-live reco --node '{"recognition":"TemplateMatch","template":"<abs>/tpl_icon.png","roi":[880,110,180,140]}' \
  --resource-dir ./M9A/resource/base --image live.png
#   [命中] ... 实测最高置信度 1
#   best.box = [925,138,68,70]
```

**结论**：库帧与实时帧同为 1280×720 控制器空间，1:1 裁出的 L2 可以直接用于实时识别——
"从留存帧裁"不等于"只能事后看看"。

## 样例 3：分辨率空间守卫（别让错空间的模板流进 pipeline）

```bash
# 用 1080 短边连接（控制器 1920x1080），却拿 1280x720 的库帧裁模板 + 显式跨帧验证
maafw-live crop --from-kf kf:<库UUID>:0003 --roi 925,138,68,70 \
  --kind adb --target 127.0.0.1:16384 --short-side 1080 --cross \
  --resource-dir ./M9A/resource/base --out tpl_bad.png
#   自匹配 位置正确，得分 1（同帧仍然对——模板与源帧当然一致）
#   跨帧验证 seq=1：得分 0，位置漂移
#   空间核对：源 1280x720 ≠ 当前控制器 1920x1080
#   警告：… 源帧空间与当前控制器不一致（见下条），该比对不成立，先在当前空间重采一帧再验
#   警告：模板按源帧空间裁出，与当前识别空间不一致（改过 shortSide / 换过设备？）
#   exit=3
```

**结论**：同帧自匹配 1.0 **不能**证明模板可跨空间使用。工具在这里不静默产出"看起来很好"的模板，
而是给出空间不一致的判定与退出 3；跨帧失败也**不会**被误归因成"模板对动态区域敏感"。

## 样例 4：热缓存路径对照（同一条动线，源不同）

```bash
maafw-live crop --roi 925,138,68,70 --project ./M9A --out tpl_live.png
#   源帧 seq=1（1280x720，L0 热缓存）
#   自匹配 位置正确，得分 1（9 次评估）
#   跨帧验证 seq=2：得分 1，位置正确          ← 热缓存路径自动跨帧（这次状态还在画面上）
#   空间核对：源 1280x720 = 当前控制器 1280x720
```

出处里的 `derivedFrom.kind` 是 `l0-cache`（带热缓存 `seq`），样例 1–3 是 `kf`（带完整 `kf:` ID 与 sha256）。
两种来源把同一套契约字段填满，消费方不必分支处理。

## 样例 5：离线裁出的模板直接进 pipeline 节点（闭环）

承接样例 1 的做法：签到月历页留档为库帧 → 离线裁出「今日奖励」标签（`556,356,120,44` → 收紧
`556,357,85,25`，自匹配 1.0）→ 放进项目资源 → 跑节点。

```bash
# 项目侧（模板是资源的一部分，和别的素材一样提交）
mkdir -p proj/res/image && cp tpl_signin_label.png proj/res/image/signin_label.png
cat proj/res/pipeline/demo.json
# { "SigninCalendar": { "recognition": "TemplateMatch", "template": "signin_label.png",
#                       "roi": [520,330,200,100], "threshold": 0.8, "action": "DoNothing" } }

maafw-live run --entry SigninCalendar --project ./proj --timeout 30000
#   任务 SigninCalendar：完成（status=3000，651ms，帧序 1..3）
#     [ok] SigninCalendar  415ms
#   exit=0
```

**结论**：`--from-kf` 裁出的 L2 不是"事后看一眼"的产物——它就是能写进 pipeline、被框架识别回路命中的模板。
判据落在任务级：`record.ok=true` 且节点 `[ok]`（不是"命令退出 0"）。阈值起点按实测（本例自匹配 1.0，
节点处取 0.8 留余量）。

## 样例 6：离线裁的模板做真机落点验证（`reco --act`，识别成功 ≠ 点击生效）

承接样例 2：留存帧里大厅的「图鉴」图标 → 离线裁模板（`52,466,78,76` → 收紧 `60,467,69,62`，自匹配 1.0）
→ 用同一个模板真机点它。

```bash
maafw-live reco --act --node '{"recognition":"TemplateMatch","template":"<abs>/tpl_gallery.png",
                               "roi":[40,450,180,120],"threshold":0.8,"action":"Click"}' \
  --project ./M9A --json
#   stage=action
#   reco:   {"algorithm":"TemplateMatch","hit":true,"box":[60,467,69,62], "best":{"score":0.990205}}
#   action: {"action":"Click","box":[60,467,69,62],"success":true,"detail":{"point":[118,470]}}
#   retention: before.seq=1  after.seq=2
```

随后截图确认：画面已从大厅切到图鉴页——**动作真的生效了**。

要读的三件事：

1. **`stage`**：`action` 表示识别命中且动作已执行；停在 `recognition` 说明动作半没跑（识别未命中/报错）。
2. **命中框 vs 落点**：`reco.box=[60,467,69,62]`，实际点击点 `[118,470]` 落在框内——这是 Click 的
   「框内随机点」语义（避免每次都点同一个像素、也避免脚本特征）。落点在框外才是问题。
3. **`retention.before/after`**：动作边界帧已进 L0 锚区，可直接 `frame get --seq` 取"点之前/点之后"的画面
   取证——不要用"现在再截一帧"冒充动作后的那一刻。

**结论**：`--act` 是"识别拿框 → 真机执行动作"的半链路，专门用来验证 target 框语义与落点。
它会**真的动设备**，所以：一次一个变量、先确认目标在帧里、动作有可见效果时再下结论（本例效果 = 页面切换）。

## 样例 7：两个模板全部离线裁自留存帧，跑通两节点流程

这是"素材从哪来"的完整答案：**两个节点用的模板都不是现场截的**，一个来自几天前的大厅留存帧，
一个来自本次会话刚升格的图鉴页留存帧；目标位置也不是猜的，是 `annotate --from-kf` 的候选表给的。

```bash
# ① 节点 2 的目标：在留存帧上离线取候选（OCR 源要资源目录），按表选号
maafw-live annotate --from-kf kf:<库UUID>:0007 --resource-dir ./M9A/resource/base --out som.png
#   SoM 候选 30 个（ocr 15 / conn 15）… #5 [ocr] ctrl=116,403,118,43  "以影像之"

# ② 离线裁两个模板（分别源自大厅留存帧与图鉴页留存帧）
maafw-live crop --from-kf kf:<库UUID>:0004 --roi 52,466,78,76  --project ./M9A --out gallery_icon.png
maafw-live crop --from-kf kf:<库UUID>:0007 --roi 110,398,132,54 --project ./M9A --out story_title.png
#   收紧 60,467,69,62（1.0）        收紧 126,416,101,23（1.0）

# ③ 放进项目资源，写 next 链，跑
#   EnterGallery  : TemplateMatch gallery_icon.png roi[40,450,180,120] → Click, next: [GalleryOpened]
#   GalleryOpened : TemplateMatch story_title.png  roi[80,370,200,90]  → DoNothing
maafw-live run --entry EnterGallery --project ./proj2 --timeout 40000
#   任务 EnterGallery：完成（status=3000，2223ms，帧序 1..4）
#     [ok] EnterGallery  469ms
#     [ok] GalleryOpened 1414ms
#   exit=0
```

**屏幕状态独立复核**（不要只看退出码）：跑完截图 → 图鉴页模板命中 1.0、大厅图标 miss
→ 点击与页面切换都真的发生了。

两个必须知道的读表细节：

1. **认 `nameSource`**：`node_details` 是框架给的权威节点名（上面两条都是），可以据此判断走了哪条分支；
   `entry` 是顶层兜底值，出现在节点完成之前（框架在 `PipelineNode.*` 顶层填的是任务入口名），**未确认**。
   另外 `record.nextCandidates` 给的是**候选序列**：本例读作 `EnterGallery×1 → GalleryOpened×3`
   ——"×3"是页面切换动画期间框架反复轮询同一候选，属于正常现象，也顺带告诉你那一步等了多久才命中。
   端到端结论始终靠 `record.ok` + 屏幕或留存帧复核。
2. **素材链可以完全离线**：留存帧 → `annotate --from-kf` 选候选 → `crop --from-kf` 裁模板 → 写进项目 →
   `run` 时设备才需要出现。设备在不在那个画面上，与素材制作无关。

## 这几条样例共同说明的事

1. **源帧身份决定能不能复核**：热缓存 seq 只在本会话有意义；库帧 ID + sha256 才是跨会话可复核的引用。
2. **同一个判据链**：位置正确 → 跨帧稳定 → 空间一致。三段都过，模板才值得写进 pipeline。
3. **失败要如实**：状态没了就是没了（miss 是结论，不是要调参）；空间不同源就说不一致，
   不产出"得分很高但用不了"的模板。
