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

全程只用 GitHub 内置的 `GITHUB_TOKEN`，无任何凭据配置。包不发布到 npm registry：安装走
`npm install <Release 附件的 tgz 地址>` 或 git 引用；将来要上 registry 时，按 MaaEvidenceKit 的
trusted publishing 流程在 `check` 与 `release` 之间加 publish 任务即可。

## 已知事项

- 发布构建在 Node 22.13（engines 声明的下限）上做，发布的文件由包声称支持的运行时产出。
- GitHub 用 **tag 指向的那份 workflow 文件**执行：修好 `release.yml` 后重跑旧 tag 仍会执行旧版，
  正确做法是发新版本 tag。
- 部分失败后重跑是安全的：`release` 任务跳过已存在的 Release，不会重复建。

## 相关文件

- `CHANGELOG.md`：正式变更记录，release notes 来源。
- `scripts/release-notes.mjs`：提取指定版本段落；缺失或为空即非零退出。
- `.github/workflows/ci.yml`：push / PR 回归（Node 22.13/24 × ubuntu/windows）。
- `.github/workflows/release.yml`：tag 触发的发布链。
