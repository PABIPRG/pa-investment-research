# Agent Note: 投研桌面端发布锁定一个 master commit

Status: implemented

[English](2026-09-07-investment-desktop-github-release.md) | 中文

## 问题

投研桌面端打包工作流会生成短期 PR 产物，但不会创建持久且身份明确的发布。产品版本在准备期间可能经过多个 commit，因此只有版本字符串无法回答用户下载的内容来自哪个源码修订。每个 commit 都发布会把普通集成活动变成无限增长的发布流，而重新构建已有版本会让其内容可变。

## 决策

### 手动发布意图与仓库持有的版本

`.github/workflows/investment-release.yml` 仅支持手动运行。它接收预期版本以及 `prerelease` 或 `stable` 渠道，而 `frontend/package.json` 仍是版本真源。运行必须从 `master` 发起；预期值必须等于仓库值；预发布版本与稳定版本必须使用各自匹配的渠道。

预检记录完整的 `github.sha`，每个平台任务都检出该值。之后合入 `master` 的 commit 无法改变正在执行的发布。PR 打包产物携带七字符 commit 前缀，因此同一个开发版本的多次构建仍可区分。

### 不可变的公开身份与已验证字节

发布使用 `investment-v<version>`，包含 macOS arm64、macOS x64 和 Windows x64 的 ZIP 文件以及 `SHA256SUMS`。发布任务只消费构建矩阵产物，验证准确的平台集合，写入并验证校验和，并在发布前创建 GitHub 产物证明。

工作流拒绝已有的公开 GitHub Release。它创建带标记的 draft、上传全部产物后再公开；上传中断后，后续运行只会删除并重建带有本工作流标记且锁定同一 commit 的 draft。人工 draft 不受影响。仅当已有 tag 指向锁定 commit 时才可复用该 tag，这允许从 tag 已创建的中间状态恢复。指向其他位置的 tag 会让运行失败；工作流绝不移动 tag 或替换已公开 Release 的产物。

### 收窄的发布权限与签名边界

工作流默认只有仓库只读权限。只有发布任务获得仓库内容、OIDC 与产物证明写权限，而且该任务关联 `github-release` Environment。首次发布前，仓库管理员启用 GitHub immutable releases，预创建并保护该 Environment，再把其中的 `INVESTMENT_RELEASE_GUARDS_READY` 变量设为 `true`；没有这项确认时，发布任务会在任何写操作前退出。该 Environment 的审核策略由仓库管理员维护。

打包保留仓库现有的 macOS ad-hoc 签名与 ZIP 格式。Apple Developer ID 签名、公证、Windows Authenticode 与安装器格式需要仓库当前尚未定义的发布身份和凭据；这项缺口保持明确，不把它表述为生产级签名。

## 曾考虑的替代方案

**每个 commit 都发布。** 这会让测试构建永久存在、让普通集成占满 Release 历史，而且不能表达明确的发布意图。PR CI 继续自动运行并保留限时产物。

**把手动输入的版本作为真源。** 这会允许所选标签与实际构建的 manifest 不一致。输入值只用于确认，已提交源码持有版本值。

**每个矩阵任务分别构建最新 `master`。** 新合并可能让一个发布包含不同修订。矩阵开始前捕获一个完整 SHA，可让每个平台使用同一源码身份。

**重新构建版本时替换产物。** 用户可能在同一版本下收到不同字节，校验和历史也会产生歧义。已有发布保持不可变，修正必须使用新版本。

**没有凭据却声称生产级签名。** 打包成功会夸大平台信任与分发就绪程度。首个序列发布当前已支持的 ZIP，并把凭据支持的签名保留为独立后续工作。

## 后果

维护者在发起工作流之前合并版本变更，选择 `master`，输入同一个版本并选择匹配渠道。在多个使用同一开发版本的 commit 中，只有不可变发布 tag 引用的 commit 是正式内容。

构建可以按源码身份复现，并通过校验和与 GitHub 产物证明审计，但首个序列不会消除 ad-hoc 或未签名分发带来的操作系统警告。发布不可变性与审批依赖版本控制之外的仓库设置；Environment 变量是管理员已经配置这些设置的快速失败确认。
