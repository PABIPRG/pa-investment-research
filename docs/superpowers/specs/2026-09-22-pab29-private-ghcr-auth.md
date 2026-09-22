# PAB-29：私有 GHCR 短期授权设计与实施计划

## 背景与已确认决策

关联 [PAB-29](https://linear.app/pabiprg/issue/PAB-29)。组织策略不允许将
`ghcr.io/pabiprg/pa-investment-research` 设为公开包，原有“生产服务器匿名拉取”前提不成立。
用户于 2026-09-22 确认改用每次 GitHub Actions 运行生成的短期 `GITHUB_TOKEN`，不在服务器
保存个人 PAT、机器账号 PAT 或长期 registry 配置。

本轮只修改部署授权链路，不触发 `workflow_dispatch`、Production 审批、Tailscale 登录、服务器
安装或线上切换。`INVESTMENT_DEPLOY_GUARDS_READY` 保持 `false`，直到更新后的入口完成安装与权限复核。

## 能力审计

| 用户动作 | 现有入口/接口 | 权威状态与副作用 | 重叠或缺口 | 决策 | 证据/未知 |
|---|---|---|---|---|---|
| 发布不可变镜像 | `Investment container image` | GHCR digest 与发布清单 | 已满足 | Reuse | master run `35693257256` 已发布成功 |
| 校验部署候选 | `ci.py preflight` | 构建来源、主干历史、config ID | 私有包查询缺少登录 | Extend | 当前明确依赖匿名 `imagetools inspect` |
| 获取短期包权限 | 部署 workflow 的 `GITHUB_TOKEN` | job 级 `packages: read`，任务结束后失效 | 尚未授予和使用 | Compose | GitHub Packages 支持获准仓库使用 `GITHUB_TOKEN` |
| 将凭据交给受限入口 | Tailscale SSH → 固定 sudo 命令 | stdin，不新增 sudo 参数 | stdin 当前只接受镜像 digest | Extend | 现有入口已清空环境并禁止参数 |
| 拉取私有镜像 | root 部署器 `docker pull` | 精确 digest 进入本机镜像存储 | 当前使用静态空 `DOCKER_CONFIG` | Extend | 拉取发生在停服和备份之前 |
| 部署与恢复 | 现有事务、备份、Compose、健康检查 | 生产容器、数据卷、恢复标记 | 无 | Reuse | 不改变阶段机和数据格式 |

部署来源、token 输入结构、镜像 digest、config ID、权限、阶段与失败处理全部由确定性脚本验证；
本方案不使用模型推断。

## 协议与安全边界

1. `candidate` 和 `deploy` job 只申请 `packages: read`；发布 workflow 继续独立使用 `packages: write`。
2. `candidate` 在获取 Production 身份之前，用本 job 的 `GITHUB_TOKEN` 登录 GHCR，再执行原有 digest/config ID 校验。
3. `deploy` 通过 stdin 发送且只发送三行：精确镜像 digest、`github.actor`、本 job 的短期 token。
   root 入口仍禁止参数、环境继承和任意镜像仓库。
4. 部署器限制总输入大小，分别验证固定 GHCR digest、可打印用户名和无空白 token；错误与状态文件不得包含用户名或 token。
5. 部署器在 root 私有临时目录中创建 `DOCKER_CONFIG`，通过 `docker login --password-stdin` 登录，
   拉取精确 digest 后立即删除目录，再检查架构、用户、来源标签和 revision。停服、备份、切换期间不保留 registry 凭据。
6. 登录或拉取失败仍发生在停服之前。现有恢复阻塞标记语义保持不变，诊断不输出 Docker stderr。
7. 包设置必须允许 `PABIPRG/pa-investment-research` 的 Actions 读取该包；权限不足时候选 job 在获取
   Production OIDC 和服务器访问之前失败。

## 实施与验证

先添加协议拒绝、token 不进入 argv/记录、临时配置清理、认证拉取顺序及 workflow 权限测试，并保留失败证据；
再修改 `deploy.py`、部署 workflow、安装/运维说明和既有规格。执行 Python 聚焦测试、shell 语法、workflow
静态检查和 `git diff --check`。真实私有包读取由 PR CI 或合并后的手动 connectivity 验证；服务器安装、
OIDC/SSH 和生产切换仍是受限外部验证，未执行前不得标记 PAB-29 Done。

## 风险与回滚

- root 在拉取期间能读取短期 token，这是完成私有 registry 登录所需的最小信任扩展；token 不落长期磁盘，
  job 结束后失效。服务器 root 或 Docker daemon 本身仍处于既有供应链信任边界。
- 不使用个人 PAT classic，避免长期凭据、人工账号耦合和额外轮换面。若 GitHub 改变 `GITHUB_TOKEN`
  的包访问规则，候选预检会在生产网络访问前失败。
- 回滚代码可恢复匿名公开包方案，但组织策略仍禁止公开时不能恢复生产可用性；实际回滚应保留私有包并
  回退到上一版已安装入口，或重新审查替代 registry。
