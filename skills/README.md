# maafw-live Skills

本目录是本仓随 npm 包一起发布的 Agent Skill。每个 skill 一个目录，含 `SKILL.md` 与可选的 `references/`。

## 安装

Skill 与 CLI 分开安装：装 CLI 不等于装 skill（反之亦然）。

```bash
# CLI（skill 里所有命令都要它）
npm install --global maafw-live@latest
maafw-live version

# skill（标准 skills CLI；列仓库里有哪些：--list）
npx skills add https://github.com/Windsland52/maafw-live --list
npx skills add https://github.com/Windsland52/maafw-live --skill maafw-live --global
```

本地开发时用 checkout 路径：`npx skills add . --skill maafw-live`（本地安装不跟随远端更新，改完重跑）。

## Skill 与 CLI 的版本关系

Skill 随包发布但**不写自己的版本号**——写死的版本每次发版都要改，而且从仓库装的副本仍然对不上。
所以对齐用**比字节**，CLI 自带四条命令：

```bash
maafw-live skill                        # 包内 skill 位置与逐文件指纹
maafw-live skill --check <安装根目录>    # 比对 <根>/maafw-live 与包内副本：same/different/missing/extra，有漂移退出 3
maafw-live skill --install <根目录>      # 把包内副本逐字节写到 <根>/maafw-live（离线，不联网）
maafw-live skill --print [--format json] # 输出包内副本内容（harness 自取，不想用 skills CLI 时）
```

`extra`（目标目录多出来的文件，例如 skills CLI 放进去的 agent 元数据）**不计漂移**；仅行尾不同（CRLF ↔ LF）
仍算 `different`，但会标注成因，避免把工具改写误判成内容分叉。日常安装/更新仍推荐 skills CLI
（它维护各 agent 的目录与符号链接），`--install` 是给"自己管一份副本"的 harness 用的。

Skill 与文档冲突时，**以本仓 `docs/` 为准**：

| 要知道什么 | 唯一出处 |
| :--- | :--- |
| daemon 命令、参数、返回字段 | [`docs/daemon-protocol.md`](../docs/daemon-protocol.md) |
| 关键帧留存与引用语义（L0/L1/L2、升格、出处） | [`docs/keyframe-retention-contract-v0.md`](../docs/keyframe-retention-contract-v0.md) |
| CLI 命令面、退出码、JSON 信封 | [`README.md`](../README.md) |
| 字段/协议/版本的原始语义（不属于本工具） | MaaLLMWiki（版本锁定原文） |

## 可用 Skill

### `maafw-live`

MaaFramework 应用的实时观测、识别实测、模板资产与状态证据留存。设备在线时给确定性观测；
设备不在那个画面上（或根本没连）时，从关键帧库留存帧离线裁出带出处的模板。
