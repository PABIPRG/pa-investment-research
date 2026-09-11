# 后端打包隐私修复（PAB-15）

## 范围与决策

用户确认在当前专属 worktree 从主线 42af49bbad 创建 `codex/package-privacy-hardening`。仅修改打包规则、检查、测试和开发文档；不提交、推送、发布或操作共享开发服务。历史进化动作跨电脑迁移问题由 PAB-14 继续阻塞生产发布。

| 操作 | 现有入口 | 状态与副作用 | 缺口 | 决策 | 证据 |
|---|---|---|---|---|---|
| 复制后端 | build-investment-python-sidecar.ts | 临时 staging，成功后替换输出 | 整目录复制漏排文档和本地配置 | Extend | copyBackend |
| 验证产物 | smoke-investment-python-sidecar.ts | 校验实际目录与描述清单、包内解释器 | 哈希一致不代表内容可分发 | Extend | verifyFiles |
| 生成应用与 ZIP | Electron packaging.ts | 组装、签名、Forge ZIP | 组装后缺少隐私门禁 | Extend | packageApplication |

均为确定性规则，不使用模型判断凭证或输出安全结论。

## 方案

- 后端仅保留 `adapter/**/*.py`、`tradingagents/**/*.py`、`market_watch/**/*.py`、`industry_chain/**/*.py` 和根目录 LICENSE/NOTICE；模块内也排除隐藏目录、文档、测试、缓存等。
- 不复制项目根目录 config、开发文档、CLI、脚本、环境文件、备份与数据库。运行配置由已有配置管理器在用户状态目录初始化。产业链种子通过已有运行时入口初始化，不引入新数据源。
- 同一策略检查构建 staging、最终应用 sidecar 和 CI smoke；遍历实际文件，不仅信任 runtime.json。发现额外文件、符号链接、个人绝对目录、私钥标记、常见令牌格式和非空敏感字段字面量时失败。
- 失败报告仅包含规则和包内相对路径，不包含命中原文；失败不替换已有 sidecar 输出。旧 ZIP 不会因为源码修复自动变安全，禁止继续分发旧包。
- 开发文档保留在源码仓库，个人绝对链接改为相对引用；不改写 Git 历史。

## 验证计划与界限

先失败测试确认检查尚不存在，再验证文件排除、实际内容扫描、二次污染、符号链接、日志脱敏和失败保留旧输出。使用真实源码和独立包验证后端模块、默认配置及三服务健康接口。三平台 CI 执行聚焦回归。

检查范围是第一方后端 payload；不宣称完整扫描 Python/Electron 第三方二进制或识别任意秘密。正式签名、公证及完整产品跨平台 UAT 仍是发布门禁。本次不触发外部发布。

## 本机验证结果

- 主机端 TypeScript 类型检查、完整 Electron 构建通过。
- 5 个测试文件、40 项聚焦测试通过；覆盖旧输出保护、三平台路径规则、短凭证、中文用户路径、二次污染与日志脱敏。
- 旧候选包被新门禁拒绝（`unexpected-file`），验证了旧规则的遗漏确实会被拦截。
- 新 macOS ARM64 ZIP 内后端共 175 文件，逐个哈希与应用目录一致；从 ZIP 解出的后端目录通过同一敏感内容扫描。
- 新 ZIP SHA256：`28ec543a7bb928cb0c45d957c5eae59a1eefa1446e4c5541f6f25031dc745283`。当前版本号仍为 0.1.0-rc.11，本地候选，不是已发布版本。

| 关注点 | 状态 | 证据 / 后续 |
|---|---|---|
| 最终包中不含开发文档、配置与备份 | passed | ZIP 解包扫描与应用目录逐文件比对 |
| 包内三后端实际启动 | passed | 独立临时目录、随机本地端口，三服务 HTTP /health 200，进程正常退出 |
| 默认配置脱离开发目录初始化 | passed | 包内 ConfigManager 在临时状态目录生成模型配置，API key 均为空；包内 config 目录不存在 |
| Windows / Intel 新包验证 | not-tested | 已接入三平台 CI，待 PR 触发；本机只验证 ARM64 |
| 图形界面完整验收、正式签名和公证 | not-tested | 本次不改 UI；生产发布前继续完成相应门禁 |

本次修复的 ARM64 文件过滤及后端运行验证通过；生产仍未就绪，PAB-14 历史进化动作迁移缺陷及剩余发布验收尚未关闭。未提交、推送、创建 PR 或发布。

日志：`/private/tmp/pab-privacy-build.log`、`/private/tmp/pab-privacy-tests.log`、`/private/tmp/pab-privacy-types.log`、`/private/tmp/pab-privacy-health.log`、`/private/tmp/pab-privacy-smoke.log`。不将临时状态数据纳入源码或安装包。
