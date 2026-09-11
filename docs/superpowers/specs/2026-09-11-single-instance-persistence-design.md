# PAB-18 单实例持久化目录与历史数据迁移设计

## 目标

单用户实例以一个绝对 `$DSH_HOME` 作为可挂载数据根。Host 设置、profile、会话、附件、storage、投研业务备份和三个 Python 后端的可写数据均从该根解析；源码和打包形态由 Host 托管时遵守同一契约。迁移只处理测试副本或操作员明确选择的离线副本，不扫描、移动或清理真实用户目录。

## 目录契约

```text
$DSH_HOME/
├── .dsh-instance.json
├── settings.yaml
├── cordis.patch.yml
├── profiles/
├── sessions/
├── attachments/v1/
├── storages/
└── investment-research/
    ├── backup-settings.json
    ├── backups/
    ├── trading-core/{data,state,user-config,cache,logs}/
    ├── market-watch/{data,state,user-config,cache,logs}/
    └── industry-chain/{data,state,user-config,cache,logs}/
```

`resolveDshInstanceLayout()` 是路径事实源。Host 托管进程统一注入 `DSH_INVESTMENT_STATE_DIR=<DSH_HOME>/investment-research/<backend-id>`。独立启动且未设置该变量的源码后端继续使用仓库内默认目录。

## 数据分类与迁移矩阵

| 数据 | 所有者 | 实例迁移 | PAB-14 `.pabackup` | 说明 |
|---|---|---:|---:|---|
| `settings.yaml`、profile、home patch | Host | 是 | 否 | 配置随实例目录恢复 |
| `sessions/` 与 `attachments/v1/` | Host 会话与附件 | 必须成对 | 否 | 会话历史不由业务备份掩盖 |
| `storages/` | Host storage | 是 | 否 | JSON 与 SQLite 均可能存在 |
| `backup-settings.json`、`backups/` | PAB-14 Host 协调器 | 是 | 归档本身 | 自定义外部备份目录需作为独立挂载声明 |
| backend `data/state/user-config` | 三个 Python 后端 | 是 | trading-core 与 market-watch 的业务分类 | industry-chain 报告、universe、overlay 与 LLM links 位于其 `data` |
| `.credentials.yaml`、`.env` | 凭据提供方／部署方 | 否 | 否 | 使用独立密钥迁移流程，普通备份不承载秘密 |
| backend `cache/logs` | 运行期诊断与派生数据 | 否 | 否 | 可以位于持久卷，但不进入逻辑迁移 |
| `runtime.json`、实例锁、事务日志、未完成上传 | 运行期协调器 | 否 | 否 | 不能恢复为进程或事务授权 |

PAB-14 继续拥有分类预览、冲突处理、事务提交、回滚和业务 reset。PAB-18 不改变 `.pabackup` 格式，也不把整实例迁移解释为业务增量导入。

## 初始化和迁移

`initializeDshInstance()` 只接受不存在或空的绝对目标，建立私有目录和版本标记，不创建虚构用户数据。`migrateDshInstance()` 接受明确的来源副本与目标，按固定白名单递归复制到目标同级 staging 目录，拒绝符号链接与特殊文件，校验普通文件 SHA-256，最后以 rename 原子发布。目标非空、版本不兼容、复制或校验失败时不发布目标，来源始终只读。

运行模式分为 `quiesced` 与 `online`。`quiesced` 要求 Host 和三个后端已停止，可复制关闭后的 SQLite。`online` 遇到 `.db`、`.sqlite` 或 `.sqlite3` 必须由调用方提供 `backupSqlite`，实现使用 SQLite backup API、`VACUUM INTO` 或等价一致性快照；完成后不复制 live WAL/SHM sidecar。没有一致性操作时迁移失败。

## 恢复和回滚

应用回滚只更换镜像或可执行文件，启动前必须确认旧版本支持目标 `.dsh-instance.json` 与各业务格式。数据回滚先停止应用，再把迁移前快照恢复为完整 `$DSH_HOME`；它不调用 PAB-14 reset，也不由旧镜像自动触发。两类回滚均保留失败目录和原始副本，避免反复覆盖现场。

## 浏览器状态边界

localStorage 只承载会话选择、视图、检查目标等界面交互状态。未发送文字草稿保持现有会话级交互状态，不属于已提交会话历史；未发送图片由浏览器运行期持有。Host 接受消息后，附件必须先进入 `attachments/v1`，再追加可恢复的会话事件。本变更不新增草稿持久化协议。

## PAB-19 与 PAB-20 的稳定接口

PAB-19 可依赖符号化 `$DSH_HOME` 与 `resolveDshInstanceLayout()`，但不得向浏览器返回绝对路径；云端文件下载继续走 Host 受限接口。PAB-20 把一个 volume 挂载为绝对 `$DSH_HOME`，启动 Host 时无需分别挂载三个后端目录；容器在线备份若允许 SQLite，必须注入一致性 `backupSqlite` 实现。Docker、Compose、健康检查和云端 UI 均不属于 PAB-18。
