# PAB-29：受控生产部署规格与实施计划

## 已确认方案

关联 [PAB-29](https://linear.app/pabiprg/issue/PAB-29)，承接 PAB-20 容器交付，恢复演练继续由 PAB-18 跟踪。用户已确认生产使用 Linux 服务器 aly、既有 Tailscale OIDC；Mac 不承担镜像构建或部署。原公开 GHCR 决策因组织策略不可执行，已由 [2026-09-22 私有 GHCR 短期授权设计](2026-09-22-pab29-private-ghcr-auth.md)取代。生产保持显式批准后执行。

本任务在专属 worktree `/Users/xiexin/.codex/worktrees/4526/pa-investment-research` 串行实施，分支 `codex/pab-29-controlled-deployment`，起始基准 `31f10b6954ddb3fcbe9d6f875ef172c846b9ff5f`（2026-09-21 的 public/master）。private/master 尚未同步，不在本轮擅自推送共享分支。不开启本机 Docker 或共享 3080 服务。

## 能力与所有权

| 用户动作 | 现有入口 | 状态与副作用 | 缺口 | 决策 | 证据 |
|---|---|---|---|---|---|
| 构建候选 | investment-container.yml | 镜像及测试结果 | 无 | Reuse | 真实 Compose smoke 已有 |
| 发布镜像 | 同一 CI 归档 | GHCR digest | 缺少发布 job | Extend | 现有流水线仅导出归档 |
| 批准部署 | GitHub Production | 审批与来源限制 | 缺少部署工作流及保护设置 | Extend | 已有 immutable OIDC Subject |
| 登录 aly | Tailscale OIDC/SSH | 临时 CI 节点 | 需要工作流接入 | Compose | 已归档配置记录；上线前复验 |
| 更新服务 | 现有 Compose | 镜像、配置和持久卷 | 缺少受限自动入口 | Create | pa-deployer 已创建但未授予特权 |
| 恢复数据 | 整卷离线备份方案 | 备份及恢复记录 | 缺少恢复演练 | Compose | PAB-18 未关闭 |

部署许可、来源、镜像身份、备份和健康判定均为确定性脚本逻辑，不使用模型推断。

## 实现约束

1. PR 保持只读构建。仅公仓 master 的 push/手动构建成功后，独立 packages:write job 下载同次测试的归档并发布，不重新构建。记录完整 SHA、镜像 config ID、registry digest、run ID/attempt。
2. 部署仅手动触发，输入成功的容器构建 run ID。检查工作流来源、主干关系、成功状态和发布清单，禁止 PR 临时提交成为生产来源。审批前展示候选。
3. 使用精确的 `Production` 名称，保持已有 immutable Subject：`repo:PABIPRG@315199386/pa-investment-research@1337955404:environment:Production`。OIDC 仅在批准后的部署 job 获得；用 tag:ci-deployer / pa-deployer / Tailscale SSH。
4. 服务器入口为 root 所有固定脚本，sudoers 仅允许无参数调用；stdin 只接受允许仓库的 sha256 digest、GitHub actor 和本次 job 的短期 token。token 通过临时 Docker 配置完成精确拉取后、停服前删除。禁止从调用者环境注入程序、路径或 Compose 参数。
5. 沿用 `/home/admin/pa-investment-deploy/compose.yaml`、`.env`、`web-admin-password.hash`，以及 `pa-investment-research_dsh-data`。保留 1panel-network 和现有反代。不整体替换现网 Compose。
6. 部署使用进程锁和落盘恢复阻塞标记；先检查当前单实例、配置/挂载/权限、磁盘空间和新镜像，再停机整卷备份。备份完成并校验后才更新 DSH_IMAGE。每个阶段落盘，失败阻止下一次自动部署，保留管理员恢复入口。
7. 健康失败或进程中断后不自动回退镜像/恢复数据；可能已有新格式写入。记录旧镜像、完整备份、阶段和诊断。重试前由管理员确认恢复并清除阻塞标记。
8. 运行时健康检查复用镜像聚合检查，另验证 HTTPS healthz。业务入口登录和恢复演练是上线验收，不能由脚本测试替代。

## 实施与验证顺序

先写拒绝路径、来源校验和部署失败状态测试，再实现 Python 标准库部署器、安装模板、CI 发布/部署流程，最后补运维说明并执行聚焦自检。服务器 Python 3、Docker Compose v2、GNU tar 和已有 sudo 是运行依赖，不需要 Node/pnpm 或源码构建工具。

本机执行 Python unittest、语法和工作流解析检查。Linux CI 执行相同测试及真实容器构建/Compose smoke；私有 GHCR Actions access、Tailscale CI 登录、安装、备份恢复和真实升级必须在获准环境完成。未运行项明确记为未验证，不标记 Done。

## 本轮验证与交接（2026-09-21）

- 已实现容器 publish job、手动 Production 部署工作流、来源/审批校验、root 受限入口及安装/sudoers 模板；运维入口为 `ops/pa-investment/README.md`。复用现有应用健康检查、Compose、卷及网络，不修改应用数据格式或 UI。
- 本机 Python 3.14：27 项测试中 26 项通过，1 项 Linux GNU tar 整卷恢复测试因平台跳过。覆盖 digest 输入拒绝、构建来源与 attempt、保护规则、registry config ID、配置保留、路径权限、单实例、空间不足、健康失败、并发和各阶段失败/中断后的恢复标记。
- actionlint 1.7.12 检查三个受影响工作流通过；两份 shell 脚本 `sh -n` 通过；`git diff --check` 通过。未运行 shellcheck/pyflakes；未执行完整前端测试，因为应用代码未变，本机未安装项目依赖。
- GitHub 只读复核：Production 当前 `can_admins_bypass=true`、`protection_rules=[]`、`deployment_branch_policy=null`。实际部署前需要配置保护；不将此误报为 Tailscale OIDC 未配置。
- 未提交、推送、创建 PR、安装服务器脚本或切换线上容器。PAB-29 保持 In Progress；private/master 未在本轮推送同步。

待补证据负责人：实施代理负责 PR 获准后的 Linux CI、私有包短期授权、连通检查和受限入口检查；维护者批准 GitHub 保护配置、服务器安装和停机部署，并负责业务/恢复验收。截止点为首次正式部署前；关闭条件是记录成功的 Linux CI、私有镜像由获准 Actions 读取、OIDC/SSH、sudo 权限拒绝、整卷备份/恢复、候选升级和 HTTPS/业务验证。恢复演练关联 PAB-18。未完成前不得声明自动生产部署已就绪。
