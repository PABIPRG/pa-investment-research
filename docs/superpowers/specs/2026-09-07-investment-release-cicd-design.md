# 投研桌面端 GitHub Release 持续交付设计

## 背景

投研桌面端已有 Pull Request 检查与三平台打包冒烟流水线，但测试产物只保留 14 天，没有一个明确、不可变且可审计的正式发布入口。版本 `0.2.0-alpha.1` 需要建立从 `master` 指定提交构建到 GitHub Release 的完整链路，同时避免把每次提交都误当成正式版本。

## 决策

正式发布由 GitHub Actions 的 `workflow_dispatch` 手动触发，而不是由每次提交自动触发。操作者在 `master` 上输入 `expected_version` 与 `channel`；仓库 `frontend/package.json` 的版本仍是唯一事实源，输入值只用于防误操作确认。

预检任务在运行开始时记录 `github.sha`。所有 macOS arm64、macOS x64 与 Windows x64 构建任务都检出该完整 SHA，因此在流水线执行期间继续合并到 `master` 不会改变本次发布内容。标签格式为 `investment-v<version>`，只能创建一次；若标签已指向其他提交或 Release 已存在，流水线失败，不移动标签、不覆盖附件。

## 流水线结构

1. `preflight` 校验触发分支、版本格式、版本与渠道对应关系、仓库版本及远端标签/Release 冲突，并输出版本、标签和锁定 SHA。
2. `build` 矩阵复用现有 Electron 与 Python sidecar 构建、签名完整性检查和运行时冒烟逻辑，生成三个按版本和平台命名的 ZIP。
3. `publish` 从矩阵产物聚合三个 ZIP，验证文件集合，生成 `SHA256SUMS`，为全部产物生成 GitHub artifact attestations，再以 draft → 上传 → 公开的顺序创建标签和 GitHub Release。上传中断时，下次运行只会删除并重建带有同一 SHA 工作流标记的 draft；人工 draft 与已公开 Release 均不修改。
4. PR 打包冒烟产物继续是短期测试制品，并在名称中加入短 SHA，避免同版本多个提交难以区分。

## 发布语义

- `prerelease` 渠道只接受带预发布后缀的版本，例如 `0.2.0-alpha.1`，并创建 GitHub prerelease。
- `stable` 渠道只接受纯三段版本，例如 `0.2.0`，并创建正式 Release。
- 同一个目标版本可以在开发期间经历多个提交；只有标签最终锁定的提交是正式版本内容。
- 正式 Release 创建后不得重新打包同一版本。任何修复都必须提升版本，例如从 `0.2.0` 到 `0.2.1`。

## 权限与安全边界

工作流默认只读。只有 `publish` 任务获得 `contents: write`、`id-token: write` 与 `attestations: write`，并绑定 `github-release` Environment。首次发布前，仓库管理员必须启用 GitHub immutable releases、预创建并保护该 Environment，然后在其中设置 `INVESTMENT_RELEASE_GUARDS_READY=true`；否则发布任务在任何写操作前失败。代码层的版本、渠道和标签冲突校验继续作为第二道防线。

当前交付沿用仓库已有的 macOS ad-hoc 签名与 ZIP 产物。Apple Developer ID、公证、Windows Authenticode 和安装器格式属于后续凭证化阶段；在凭证和发布主体确认前，流水线不会伪装成生产级系统签名。

## 验证

以 Vitest 固化版本/渠道/SHA/tag 计算规则和工作流结构；以 YAML 解析确认触发器、权限、矩阵、锁定 SHA、校验和、attestation 与 Release 创建步骤；以现有 constraints、启动类型检查及文档门禁验证仓库一致性。PR 上运行短期三平台打包冒烟，合并后再由维护者手动执行首次 `0.2.0-alpha.1` 发布。
