# 仓库协作约定

- 默认情况下，编写前端代码时优先使用 TypeScript，编写后端代码时优先使用 Python。
- 使用 Superpowers 工作流时，所有新建或更新的 Markdown 文档均使用中文，包括规格、实施计划、handoff、task brief、task report 和进度账本。
- 代码标识符、命令、文件路径、配置键、API 名称以及必须逐字保留的引用可以继续使用原文；其余标题和说明正文使用中文。

## Linear 项目映射

- 后续所有任务追踪统一使用 Linear。
- Linear workspace: `PABIPRG`
- Linear team: `PABIPRG`
- Team key: `PAB`
- Linear project: `投研智能体`
- Linear project ID: `08905897-5bb3-4f89-8a07-5729018a65b4`
- 默认状态: `Backlog`
- 默认标签: `Feature`
- 创建 Linear issue 前必须先展示完整草稿，并取得用户明确确认。
- 禁止通过仓库名称猜测 Linear Project；必须使用本节记录的项目名称与 ID。若映射失效或无法访问，应停止创建并请求用户确认。

## 多 Agent 与 Git worktree

### 角色与调度契约

- 每个顶层 Codex 任务在启动前必须由调度方明确标注且只标注一种角色：`read-only`（只读分析）、`worktree-writer`（独立开发）或 `local-integrator`（本地主工作区集成与共享服务验证）。未明确角色时一律按 `read-only` 处理，不得修改文件。
- `worktree-writer` 必须在任务提交前从本仓库已保存的 Git 项目中选择 Worktree 环境和起始分支，由 Codex 创建并绑定专属 worktree。不得用临时 Local 任务、同目录 fork、浏览器反馈任务或其他共享当前工作目录的入口承载并行写入任务。
- 调度方必须随写入任务提供：角色、worktree 绝对路径、起始分支或基准提交、目标特性分支名、允许修改的文件范围、验证命令，以及需要使用的端口或其他共享资源。缺少 worktree 绝对路径或基准信息时，`worktree-writer` 不具备写入权限。
- `local-integrator` 是唯一允许写入本地主工作区并操作共享开发服务的角色；同一仓库同一时间最多只能有一个 `local-integrator`。该角色只能用于串行集成、解决冲突、最终验证或用户明确要求在 Local 中完成的工作，不得与其他 Local 写入任务并行。
- 任务若已经以 Local 环境启动，但其目标属于独立开发或并行开发，Agent 必须停止写入并请求调度方重新派发到 Worktree，或者由用户/调度方执行 Handoff。不得采用“先在 Local 修改，完成后再迁移”的方式规避隔离要求。

### 并行写入边界

- 多个 Agent 并行修改代码时，必须遵守“一项独立任务 = 一个独立特性分支 = 一个独立 worktree = 一个独立顶层 Codex 会话”；不得让不同任务的写入 Agent 共用工作目录，也不得通过反复执行 `git switch` 或 `git checkout` 争用同一 worktree 的 `HEAD`。Codex 托管 worktree 可以按产品默认方式临时使用专属 detached `HEAD`，但提交或推送前必须创建符合本仓库命名规则的唯一特性分支。
- 同一顶层会话内创建的子 Agent 默认只用于代码阅读、架构分析、问题定位、测试分析、代码审查和文档整理。除非运行环境能够为每个写入 Agent 绑定并验证唯一 worktree，否则不得让多个子 Agent 并行修改代码；无法隔离时改为串行写入。
- 一个 worktree 同一时间只允许一个主要写入 Agent；不同 worktree 不得 checkout 同一分支。调度方在并行任务开始前必须明确分配唯一的 worktree 绝对路径和分支名；若明确使用 Codex 托管的 detached `HEAD`，还必须记录预期基准提交和后续目标分支名。
- `codex -C <worktree_path>` 只负责设置 Agent 的启动工作目录，不视为文件系统访问控制。仍须依赖 sandbox 或 permission profile 限制可写目录，且 Agent 不得访问或修改其他 worktree。
- worktree 只隔离工作副本、索引和 `HEAD`；端口、数据库、外部缓存、远程引用及其他共享资源仍须为并行任务分别配置或协调。

### 启动、执行与收尾

- 所有写入 Agent 在修改文件前必须检查并核对 `pwd`、`git rev-parse --show-toplevel`、`git rev-parse --git-dir`、`git rev-parse --git-common-dir`、`git branch --show-current`、`git status --short` 和 `git worktree list --porcelain`；实际目录、分支或 detached `HEAD` 基准与任务分配不一致时，立即停止并报告，不得自行切换分支修复。
- `worktree-writer` 必须确认 `git rev-parse --show-toplevel` 与获分配的 worktree 绝对路径完全一致，并确认当前 `HEAD` 与获分配的起始分支或基准提交相符。若实际位于本地主工作区、路径未分配、基准不符或同一 worktree 已有其他写入任务，立即停止并报告“当前任务未获得独立 worktree，请重新派发”，不得继续编辑或测试性写入。
- `local-integrator` 在写入前必须确认该角色由调度方明确分配，并确认没有其他任务正在写入本地主工作区；无法确认时按 `read-only` 处理。
- 任务执行中的开发 Agent 不得为了进入其他任务而执行 `git switch`、`git checkout`，也不得自行创建、移动、删除或清理 worktree。调度或集成流程确需执行这些操作时，必须先确认目标、工作区状态和现有未提交修改。
- 发现当前 worktree 中存在来源不明或与任务无关的未提交修改时，不得覆盖、暂存、提交或清理；若无法绕开，应停止并报告。
- 提交、推送、创建 PR、合并以及 worktree 清理仍须遵守下方 Git 工作流和用户授权边界。清理 worktree 前必须确认工作区干净，且需要保留的改动已经安全进入提交或其他可恢复载体。

### 共享服务与端口

- 本地默认开发端口 `3080` 及其对应的常驻服务只由 `local-integrator` 管理。`worktree-writer` 不得启动、停止、重启或杀死该共享服务，也不得用自己的构建产物覆盖共享服务正在读取的产物。
- `worktree-writer` 需要运行服务级验证时，调度方必须为其分配唯一端口和必要的独立缓存、数据库或临时目录；未分配时只运行不占用共享资源的构建、单元测试或一次性检查，不启动常驻服务。
- 需要在本地默认服务上进行最终联调时，`worktree-writer` 应提交验证结果并交由 `local-integrator` 串行集成、重建和重启；不得跨 worktree 直接操作共享服务。

## Git 工作流

### 仓库和分支角色

- `private` 指向个人私仓 `jiahim/pa-investment-research`，用于保存与推送特性分支。
- `public` 指向公共仓库 `PABIPRG/pa-investment-research`，是 PR 的目标仓库；禁止直接向其任何分支推送。
- `private/master` 只作为 `public/master` 的同步镜像，不接收特性分支合并。
- `public/master` 是公仓目标分支，也是每轮开发的最终基线。
- 特性分支用于实际开发。人工创建时建议命名为 `feature/<topic>`、`fix/<topic>` 等；Codex 创建时必须使用 `codex/<topic>` 前缀。

### 标准流转路径

所有功能、修复、重构和文档变更采用单 PR 流程：

```text
public/master
    ↓ 同步到 private/master
从 private/master 创建特性分支（在本地开发）
    ↓ push 到 private
跨仓 PR：private/<特性分支> → public/master
    ↓ 公仓评审并合并
public/master
    ↓ 回同步 private/master
```

### 开始开发

- 仅在用户明确要求提交、推送或创建 PR/MR 时执行对应 Git 操作；修改代码本身不代表已获得提交、推送或创建 PR 的授权。
- 每次开始开发前，先运行只读检查，确认工作区状态、当前分支和远端映射，避免覆盖或丢弃现有未提交改动。
- 获取 `public/master` 和 `private/master` 的最新状态，先将公仓最新 `master` 同步到私仓 `master`，确保 `private/master` 不落后于 `public/master`。
- 同步基线时优先采用可保持线性历史的 fast-forward；发生分叉或冲突时停止自动同步，先查明差异并解决冲突，不得强制推送或改写共享分支历史。
- 每项工作都从最新的 `private/master` 创建独立特性分支。不得直接在本地 `master` 上开发或提交，也不得复用已经合并的旧特性分支承载新任务。

### 开发、提交与公仓 PR

- 日常开发和本地提交只能发生在特性分支。
- Codex 创建的所有 commit message 和 PR 标题必须以 `[AI] ` 开头，例如 `[AI] 自动补全接口文档`。提醒用户：人工创建的 commit message 和 PR 标题应以 `[Human] ` 开头，例如 `[Human] 修复登录页样式问题`。
- 保持提交粒度合理、主题单一，避免在一个提交中混入无关变更。
- 开发期间需要同步基线时，先获取最新的 `public/master`，再将其 rebase 到特性分支；如必须保留合并语义才使用 merge。禁止对已经由多人共享的分支进行未经确认的历史改写。
- 首次推送及后续更新只能推送到私仓对应特性分支，例如 `git push -u private codex/<topic>`；禁止将特性分支直接推送到 `public`。
- 功能完成并通过与改动范围匹配的检查或测试后，直接创建跨仓 PR，以私仓特性分支为 head、`public/master` 为 base，例如 `private/codex/<topic> → public/master`。
- 创建公仓 PR 前，确认特性分支包含最新 `public/master`、不存在未解决冲突，并完成合并前所需的测试和检查。
- 公仓 PR 是代码进入公仓的唯一方式。禁止先把特性分支合并到 `private/master`，也禁止绕过 PR 直接向公仓推送代码。
- 只有代码评审通过、自动检查通过且冲突完全解决后，方可合并公仓 PR。
- 公仓 PR 合并后，及时把最新 `public/master` 以 fast-forward 方式回同步到 `private/master`，为下一项工作建立一致基线；随后运行 `pnpm --dir frontend run branch:cleanup` 检查本地残留，并仅在用户授权后通过 `--apply` 删除已证明安全的本地特性分支和 worktree。

### 安全边界

- 禁止对 `private/master`、`public/master` 或其他共享分支执行 force push。
- 任何同步、rebase 或 merge 操作前都必须检查工作区状态；不得覆盖、暂存、提交或丢弃与当前任务无关的用户改动。
- 如果私仓与公仓不属于同一个 GitHub fork network，导致无法创建跨仓 PR，应停止在公仓侧的写操作并告知用户处理仓库关系，不得改用直接推送规避该限制。
