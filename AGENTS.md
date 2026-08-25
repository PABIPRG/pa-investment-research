# 仓库协作约定

- 默认情况下，编写前端代码时优先使用 TypeScript，编写后端代码时优先使用 Python。
- 使用 Superpowers 工作流时，所有新建或更新的 Markdown 文档均使用中文，包括规格、实施计划、handoff、task brief、task report 和进度账本。
- 代码标识符、命令、文件路径、配置键、API 名称以及必须逐字保留的引用可以继续使用原文；其余标题和说明正文使用中文。

## Git 工作流

### 仓库和分支角色

- `private` 指向个人私仓 `jiahim/pa-investment-research`，是所有开发分支和变更首次推送的唯一远端。
- `public` 指向公共仓库 `PABIPRG/pa-investment-research`，只接收来自私仓的 PR，禁止直接向其任何分支推送。
- `private/master` 是私仓集成分支，用于汇总已经在私仓完成评审和验证的特性。
- `public/master` 是公仓目标分支，也是每轮开发开始时的最终基线。
- 特性分支用于实际开发。人工创建时建议命名为 `feature/<topic>`、`fix/<topic>` 等；Codex 创建时必须使用 `codex/<topic>` 前缀。

### 强制流转路径

所有功能、修复、重构和文档变更必须按照以下顺序流转，不得跳过私仓直接进入公仓：

```text
public/master
    ↓ 同步到 private/master
特性分支（在本地开发）
    ↓ push 到 private
私仓 PR：特性分支 → private/master
    ↓ 私仓 PR 合并
公仓 PR：private/master → public/master
    ↓ 公仓 PR 评审并合并
public/master
    ↓ 回同步 private/master
```

### 开始开发

- 仅在用户明确要求提交、推送或创建 PR/MR 时执行对应 Git 操作；修改代码本身不代表已获得提交、推送或创建 PR 的授权。
- 每次开始开发前，先运行只读检查，确认工作区状态、当前分支和远端映射，避免覆盖或丢弃现有未提交改动。
- 获取 `public/master` 和 `private/master` 的最新状态，先将公仓最新 `master` 同步到私仓 `master`，确保 `private/master` 不落后于 `public/master`。
- 同步基线时优先采用可保持线性历史的 fast-forward；发生分叉或冲突时停止自动同步，先查明差异并解决冲突，不得强制推送或改写共享分支历史。
- 每项工作都从最新的 `private/master` 创建独立特性分支。不得直接在本地 `master` 上开发或提交，也不得复用已经合并的旧特性分支承载新任务。

### 开发、提交与私仓集成

- 日常开发和本地提交只能发生在特性分支。
- Codex 创建的所有 commit message 必须以 `[AI] ` 开头，例如 `[AI] 自动补全接口文档`。提醒用户：人工创建的 commit message 应以 `[Human] ` 开头，例如 `[Human] 修复登录页样式问题`。
- 保持提交粒度合理、主题单一，避免在一个提交中混入无关变更。
- 开发期间需要同步基线时，先获取最新的 `public/master`，再将其 rebase 到特性分支；如必须保留合并语义才使用 merge。禁止对已经由多人共享的分支进行未经确认的历史改写。
- 首次推送及后续更新只能推送到私仓对应特性分支，例如 `git push -u private codex/<topic>`；禁止将特性分支直接推送到 `public`。
- 功能完成并通过与改动范围匹配的检查或测试后，创建私仓 PR，以特性分支为 head、`private/master` 为 base。
- 私仓 PR 必须完成评审、解决全部冲突并通过必要检查后才能合并。禁止绕过 PR 直接向 `private/master` 推送业务变更。

### 提交公仓

- 私仓 PR 合并后，以私仓 `master` 为 head、公仓 `master` 为 base 创建跨仓 PR，即 `private/master → public/master`。
- 创建公仓 PR 前，再次确认 `private/master` 已包含最新 `public/master`、两个分支不存在未解决冲突，并完成合并前所需的测试和检查。
- 公仓 PR 是代码进入公仓的唯一方式。禁止直接 push 到 `public/master`，也禁止从本地特性分支绕过 `private/master` 直接向公仓发起 PR。
- 只有代码评审通过、自动检查通过且冲突完全解决后，方可合并公仓 PR。
- 公仓 PR 合并后，及时把最新 `public/master` 以 fast-forward 方式回同步到 `private/master`，为下一项工作建立一致基线；随后可删除已经合并的私仓特性分支。

### 安全边界

- 禁止对 `private/master`、`public/master` 或其他共享分支执行 force push。
- 任何同步、rebase 或 merge 操作前都必须检查工作区状态；不得覆盖、暂存、提交或丢弃与当前任务无关的用户改动。
- 如果私仓与公仓不属于同一个 GitHub fork network，导致无法创建跨仓 PR，应停止在公仓侧的写操作并告知用户处理仓库关系，不得改用直接推送规避该限制。
