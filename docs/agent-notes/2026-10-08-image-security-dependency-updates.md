# PAB-29：镜像依赖安全修复

## 任务与基线

用户要求修复运行 37731684440 的三项 HIGH 漏洞并新开 PR，尽快取得演示候选构建。主代理角色为 worktree-writer，唯一写入目录 `/Users/xiexin/.codex/worktrees/security-dependency-updates/pa-investment-research`，起点为公仓最新 master `8a286f84ef5f386f0894229d22ecc4ce66327fd4`，目标分支 `codex/security-dependency-updates`。旧 PR #159 已合并，原 1830 工作区不再承载新修改。子代理仅只读；不操作共享 3080 或用户远程服务器。私仓 master 仍为旧镜像，本轮使用公仓权威基线，不额外推送镜像分支来触发未授权发布。

关联既有 PAB-29；Linear 连接不可用，不创建新工作项或更新 Done。允许修改范围为三个依赖声明、pnpm 配置与锁、第三方声明、四平台 Python 目标锁及其摘要、相关回归与说明。无需改变接口、业务存储或页面交互。

## 根因与方案

失败运行的 106 项运维测试、镜像构建、边界、Compose 启停已通过；八次秘密命中均按已批准策略处理。Trivy 0.74.0 报告三项 HIGH：CVE-2026-104850、CVE-2026-104873、GHSA-wq5f-xc86-pv6w，阻断上传及 GHCR 发布。用户已确认按官方修复版本升级。

| 用户能力 | 既有入口与权威依赖 | 决策 | 修改与验证 |
|---|---|---|---|
| MCP 工具连接与调用 | mcp-client；pnpm 统一依赖闭包 | Reuse | SDK 1.29.0 → 1.31.0；最低声明与精确覆盖一起更新，避免传递依赖残留；现有 stdio/HTTP、本地图片返回链路回归 |
| 图片读取与私有附件 | attachment-local；sharp optional 原生包 | Reuse | sharp 0.35.4 → 0.35.5，libvips 平台包随官方分发更新；核对实际原生库版本与真实图片处理 |
| 研究图执行 | Python 目标 requirements 与 runtime-lock 摘要 | Reuse | langgraph-sdk 0.4.3 → 0.4.4；四平台同步，仅重算目标锁摘要；真实 SDK 导入及无网络图运行 |

所有版本、摘要、安全等级和验收均按确定性规则处理，不由模型替代门禁。MCP 继续使用现有 transport；不创建 OAuth 策略平行实现。正式秘密例外、漏洞零豁免、OS/OpenSSL 与安全校验器保持现有基线。

## 实施及验证计划

1. 核对官方 npm/PyPI 版本、完整性与上游约束；精确更新三个依赖，使用仓库 pnpm 11.7.0 生成锁。LangGraph 1.2.11 要求 SDK >=0.4.2,<0.5.0，0.4.4 满足；其余 Python 固定版本保留。
2. 完成 frozen 安装、目标锁摘要校验、MCP 与附件聚焦单测、真实本地 MCP/图片链路及离线 LangGraph 运行。临时资源位于 `/private/tmp/security-dependency-updates-*`；MCP 仅使用独占随机回环端口，禁止调用模型或行情服务。
3. 核对两项 npm 依赖及 Python 锁均无旧版本，更新第三方声明，完成所需类型/构建验证、范围复审；提交到新特性分支并按已获 PR 授权创建跨仓 PR。
4. 完整 Linux 镜像、漏洞扫描和其他平台原生模块仍以新 CI 为准。负责人为本任务代理与仓库维护者；关闭期限为演示候选发布前，条件为新提交对应的镜像/Compose/扫描成功。PR 请求不包含合并或 aly 部署；远程预览更新按逐次授权执行。

这是固定依赖/生成锁修改，不新增只复述版本字符串的单测；失败证据复用真实 Trivy 阻断，兼容性由现有聚焦回归和真实本地入口证明。回退可整体撤销本次依赖与锁变更，但旧依赖仍被门禁阻断；不以回退安全检测换取构建通过。

## 本地验证结果（2026-10-08）

使用 Node 24.15.0、Corepack 隔离的 pnpm 11.7.0；官方 registry 的 frozen-lockfile 安装通过，未放宽安装脚本策略。现有本机 pnpm 10.33.0 不支持仓库 allowBuilds 语法，因此按 packageManager 使用 11.7.0，而非修改配置迁就旧工具。

| 检查 | 结果 |
|---|---|
| MCP、附件、read-image 聚焦单测 | 8 文件、143 项通过 |
| MCP SDK 真实本地 stdio / HTTP E2E | 22 项通过；随机回环端口，不调用外部模型 |
| ACP 图片入口 keyless replay | read-image / inline-image-prompt 共 4 项通过 |
| Python 源与四平台目标锁摘要 | 聚焦契约 1 项通过；额外只读复审确认所有 SHA256 与文件一致 |
| 第三方声明生成一致性 | 聚焦契约 1 项通过；生成器补齐基线已有的 undici 声明 |
| typecheck:startup | 通过 |
| build:lib:host | 通过；MCP、附件与研究运行时 Host 产物完成构建；plain Node 加载构建后的 MCP 入口与附件 PNG 解码、像素限额拒绝均通过 |
| sharp 原生实际处理 | PNG → WebP 缩放与重新读取通过；sharp 0.35.5、rsvg 2.63.2、vips 8.18.7 |
| Python 3.10.20 / LangGraph | 使用 runtime-lock 指定且 SHA256 校验通过的 CPython；按 linux-x64 固定版本约束安装 graph 1.2.11 / SDK 0.4.4，pip check 通过；禁止 socket 联网的 invoke / stream 均通过 |

两名只读代理复核锁文件闭包与 Python 摘要，无阻断发现。Node 锁内仅 SDK 1.31.0，所有 sharp 平台包 0.35.5、libvips 平台包 1.3.4；四平台 Python 锁均为 SDK 0.4.4。pnpm 另外更新既有 xmldom 包的 registry deprecation 元数据，其版本未变。

以上不代表 Linux 镜像扫描已经通过；完整镜像、Trivy 和其他平台验证尚待新 CI。GitHub 分支 API 复核被自动审批拒绝，理由为要求逐次远程授权；本地准备继续，推送、PR 及预览触发前明确本次操作授权。未连接 aly、未合并或部署。

## 修复依据

- [MCP SDK 官方公告](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h)：1.x 修复版本 1.31.0。
- [LangGraph SDK 官方公告](https://github.com/langchain-ai/langgraph/security/advisories/GHSA-fvww-7h3r-vfhp)：修复版本 0.4.4。
- [sharp 官方公告](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w)：0.35.5 更新到修复后的 librsvg 2.63.2。
- [失败的镜像构建运行](https://github.com/PABIPRG/pa-investment-research/actions/runs/37731684440)：产物发布被三项 HIGH 阻断。
