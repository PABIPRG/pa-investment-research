# 投研桌面端 GitHub Release 持续交付实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 建立手动触发、版本可确认、提交可锁定、三平台可验证且产物可追溯的 GitHub Release 流程，并关联 Linear `PAB-15` 与里程碑 `0.2.0-alpha.1`。

**架构：** 由纯 TypeScript 发布契约负责版本、渠道、SHA 和产物命名；GitHub Actions 负责预检、固定 SHA 的矩阵构建、聚合校验和、证明与不可变 Release 发布。PR 打包冒烟继续独立运行并只提供短期制品。

**技术栈：** TypeScript、Vitest、GitHub Actions、Electron Forge、GitHub CLI、GitHub artifact attestations。

**规格：** [持续交付设计](../specs/2026-09-07-investment-release-cicd-design.md)

## 全局约束

- 只从 `public/master` 基线的独立 `codex/` 分支修改，通过 `private` 特性分支向 `public/master` 创建跨仓 PR。
- 不自动合并 PR，不创建真实 Release，不移动或覆盖任何已有标签。
- 所有 pnpm 命令使用 `corepack pnpm`，确保遵循仓库声明的 11.7.0。

## 任务一：固定发布契约

- [x] 新增失败测试，覆盖版本格式、渠道匹配、`master` 限制、完整 SHA 和标签/产物命名。
- [x] 运行聚焦测试并确认因实现缺失而失败。
- [x] 新增 `frontend/scripts/investment-release.ts` 的最小纯函数实现。
- [x] 运行聚焦测试并确认通过。

## 任务二：实现正式 Release 工作流

- [x] 在测试中定义手动触发输入、只读默认权限、三平台矩阵、锁定 SHA、发布 Environment、校验和、attestation 与不可变 Release 的结构契约。
- [x] 运行测试并确认新工作流缺失导致失败。
- [x] 新增 `.github/workflows/investment-release.yml`，复用现有打包与冒烟行为。
- [x] 运行工作流结构测试并确认通过。

## 任务三：区分 PR 测试制品

- [x] 先增加测试，要求短期打包产物名包含短 SHA。
- [x] 修改 `.github/workflows/investment-sidecar.yml` 输出短 SHA 并写入产物名。
- [x] 运行相关测试并确认通过。

## 任务四：记录决策与操作说明

- [x] 新增中英文 implemented/process Agent Note，记录手动门禁、不可变标签与凭证化签名边界。
- [x] 重新记录双语一致性摘要。
- [x] 更新计划勾选状态，并运行文档门禁。

## 任务五：验证、评审与 PR

- [x] 运行聚焦测试、constraints、启动类型检查、文档门禁与差异检查。
- [x] 进行只读代码评审并处理高优先级发现。
- [x] 创建单一主题的 `[AI]` 提交并推送到 `private/codex/investment-release-cicd`。
- [x] 创建 `private/codex/investment-release-cicd` 到 `public/master` 的 `[AI]` 跨仓 PR。
- [x] 把 PR 链接回写 Linear `PAB-15`，停在等待评审与合并状态。
