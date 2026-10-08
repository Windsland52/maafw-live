# 发布指南（maafw-live）

流程对齐 [create-maa-project](https://github.com/Windsland52/create-maa-project) 与
[MaaEvidenceKit](https://github.com/Windsland52/MaaEvidenceKit)：**CHANGELOG.md 是 release notes
的唯一来源**，发布由 tag 触发、CI 完成，人只负责把 CHANGELOG 写对、把 tag 打对。

## 版本模型

- 语义化版本，`v*` 形式的附注 tag（如 `v0.1.0`）。
- 版本号手写在 `package.json`（不同于 create-maa-project 的 tag 派生），`release.yml` 会校验
  tag 与 `package.json` 一致，不一致直接失败。
- **已推送的 tag 不移动、不重建**：发布出问题发新版本前向修复，不把旧 tag 指到别处。

## 发布前

1. 为本次版本在 `CHANGELOG.md` 写好 `## [<version>] - <日期>` 段（人工精炼、用户视角、合并同类项），
   并刷新文件底部的对比链接（`[Unreleased]` 与新版本各一条）。
2. 本地全绿：

   ```bash
   npm test                                # 构建 + 纯函数单测
   npm run verify                          # 装配级回归：断言 stdout/stderr/退出码外部契约
   npm run accept:offline                  # 关键帧库离线契约验收
   node scripts/release-notes.mjs <version>  # 验证 CHANGELOG 段可提取（与 CI 同一脚本）
   ```

3. `npm version <version> --no-git-tag-version` 同步 `package.json` 与 `package-lock.json`。

## 发布

```bash
git add CHANGELOG.md package.json package-lock.json
git commit -m "chore(release): <version>"
git tag -a v<version> -m "v<version>"
git push origin master v<version>
```

tag 推送触发 `.github/workflows/release.yml`，任务链（`needs` 决定顺序）：

| 任务 | 行为 |
| --- | --- |
| `check` | 校验 tag == `package.json` 版本、**CHANGELOG 必须有该版段落**（空 notes 不许发）；`npm ci` + test + verify + accept:offline；`npm pack` 出 tarball 并上传 artifact |
| `release` | 用 `scripts/release-notes.mjs` 从 **tag 树**的 CHANGELOG 提取该版段落，`gh release create` 建 GitHub Release 并把 tarball 挂为附件；已存在则跳过 |

全程只用 GitHub 内置的 `GITHUB_TOKEN`（GitHub Release + GitHub Packages）与 npm 的
**trusted publishing（OIDC）**：仓库里没有任何长期发布凭据。

发布产物同时进两个 registry：

| 通道 | 身份 | 说明 |
| --- | --- | --- |
| npm registry `@windsland52/maa-live` | OIDC（`id-token: write`） | `--access public --provenance`。`publish-npm` 作业**刻意不写** `registry-url` / `NODE_AUTH_TOKEN`：setup-node 的 `registry-url` 会写一个带占位 token 的 `.npmrc`，遮蔽 OIDC 交换，而 npm 对任何认证失败都回报成掩码 E404（PUT 404） |
| GitHub Packages（同名 scope） | `GITHUB_TOKEN`（`packages: write`） | 镜像/内部通道。GHCR 不支持 npm 的 trusted publishing，也不接受 provenance 证明，故**不带** `--provenance`；安装需带 PAT，匿名装不了。因此**公共安装通道是 npm registry** |

两个发布作业都先查"该版本是否已存在"，存在即跳过——部分失败后重跑是安全的。

### 首次发布前的一次性配置（人工，改不了代码）

1. **scope 归属**：`@windsland52` 必须是你的 npm scope（用户名同名，或建同名组织）。npm 包名只能小写，
   `@Windsland52/...` 这种大写形式会被拒。
2. **npm trusted publisher**：在 npmjs.com 上为该包（或该包名的 pending publisher）绑定
   仓库 `Windsland52/maafw-live` + workflow 文件名 `release.yml`。
   若 npm 当前要求"先有一次成功发布才能配 trusted publisher"，就先本地 `npm publish --access public` 一次
   再启用 OIDC——**以 npm 页面当时的口径为准**（本仓文档不预判它）。
3. **GitHub Packages**：无需额外配置，`packages: write` 已在 workflow 里；包靠 `package.json` 的
   `repository` 字段关联到本仓（缺这个字段 GHCR 会拒绝发布）。

## 已知事项

- 发布构建在 Node 22.13（engines 声明的下限）上做，发布的文件由包声称支持的运行时产出。
- GitHub 用 **tag 指向的那份 workflow 文件**执行：修好 `release.yml` 后重跑旧 tag 仍会执行旧版，
  正确做法是发新版本 tag。
- 部分失败后重跑是安全的：`release` 任务跳过已存在的 Release，不会重复建。
- **发布后 registry 有传播延迟，别据此判定失败**：新包/新版本在 npm 侧要过一遍处理流水线
  （`npm publish` 输出里的 "Your package is being processed and may take a few minutes to become available"
  就是这个状态）。实测 0.1.0 与 0.1.1 各等 **2–3 分钟**才在 packument 里可见，期间
  `npm view`、`npm i <该版本>`、直接 GET packument 全是 404/ETARGET。
- **本机 npm 缓存会掩盖新版本**：registry 已经有了，本机 `npm view` / `npm i <版本>` 仍可能报
  `ETARGET: No matching version found`（缓存的旧 packument）。加 `--prefer-online` 或等几分钟再试——
  这不是发布失败。
- **发布前本地干跑一次 `npm publish --dry-run`**：`bin` 路径这类问题**只有 publish 报**
  （`npm pack` 不报）——0.1.0 前就撞过 `bin[...] script name ... was invalid and removed`，
  照那样发出去用户装完没有命令。

## 相关文件

- `CHANGELOG.md`：正式变更记录，release notes 来源。
- `scripts/release-notes.mjs`：提取指定版本段落；缺失或为空即非零退出。
- `.github/workflows/ci.yml`：push / PR 回归（Node 22.13/24 × ubuntu/windows）。
- `.github/workflows/release.yml`：tag 触发的发布链。
