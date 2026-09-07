# 投研数据备份、导入与重置实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 在设置页交付可分享的 `.pabackup` 备份、统一增量导入、备份列表管理和安全重置能力。

**目标版本：** `0.1.0-rc.12`。当前实现基线保持 `0.1.0-rc.11`，完成跨层验证与真实产品验收后再统一升版。

**架构：** Python 业务后端拥有领域数据的导出、校验、合并和事务回滚；`investment-python-runtime` 在 Host 侧协调后端、生成标准 ZIP、管理备份目录与分块上传；Client Runtime 暴露窄化门面，设置页只负责状态与用户决策。备份文件在导入过程中始终只读。

**技术栈：** TypeScript、React、Cordis/Typert Remote、Vitest、Python、FastAPI、Pydantic、unittest、fflate、SHA-256。

**规格：** `docs/superpowers/specs/2026-09-07-data-backup-import-design.md`

## 全局约束

- 用户可见名称统一使用“导入”，不新增“恢复”语义。
- `.pabackup` 内部是标准 ZIP，`formatVersion` 初始值为 `1`。
- 自动安全备份只在导入、重置前由默认勾选项触发，第一版没有定时任务。
- 导入不得修改、移动、改名或删除来源备份。
- API Key、券商凭据、日志、缓存、PID、机器地址和产业链种子数据不得进入备份。
- 新增或修改的 Markdown 文档使用中文；代码标识符和逐字契约值保留英文。
- 每个生产行为先写失败测试并确认失败原因，再写最小实现。
- 不在本任务中提交、推送或创建 PR，除非用户另行授权。
- 不在功能开发中途改写包版本；版本升至 `0.1.0-rc.12` 属于验收通过后的发布步骤。

---

### 任务 1：Trading Core 领域快照与事务

**文件：**

- 新建：`backend/dsh-trading-core/adapter/data_transfer.py`
- 修改：`backend/dsh-trading-core/adapter/store.py`
- 修改：`backend/dsh-trading-core/adapter/schemas.py`
- 修改：`backend/dsh-trading-core/adapter/app.py`
- 新建：`backend/dsh-trading-core/tests/test_data_transfer.py`
- 修改：`backend/dsh-trading-core/tests/test_store.py`

**接口：**

- 产出：`export_snapshot(categories) -> dict`、`preview_import(snapshot, rules) -> dict`、`prepare_import(transaction_id, snapshot, rules, expected_revision) -> dict`、`commit_import(transaction_id) -> dict`、`rollback_import(transaction_id) -> dict`、`finalize_import(transaction_id) -> dict`、`reset_categories(transaction_id, categories, expected_revision) -> dict`。
- HTTP：`GET /data-transfer/export`，以及 `POST /data-transfer/preview|prepare|commit|rollback|finalize|reset`。
- 领域 `schemaVersion = 1`；分类固定为 `strategies`、`holdings`、`watchlist`、`research`、`preferences`。

- [ ] **步骤 1：为 `JsonStore.transaction()`、一致快照和批量失败回滚编写失败测试。**
- [ ] **步骤 2：运行 `env/bin/python -m unittest tests.test_store -v`，确认因事务 API 不存在而失败。**
- [ ] **步骤 3：使用进程级 `threading.RLock` 实现事务门，并让所有现有读写方法经过该门。**
- [ ] **步骤 4：再次运行存储测试，确认并发与损坏文件契约仍通过。**
- [ ] **步骤 5：为五类导出范围、敏感集合排除、持仓保留本地、自选去重、策略保留两份和过期预览拒绝编写失败测试。**
- [ ] **步骤 6：实现纯函数合并器、版本摘要和策略引用重映射，使上述测试通过。**
- [ ] **步骤 7：为 prepare/commit/rollback/finalize 和 reset 的持久回滚日志编写失败测试。**
- [ ] **步骤 8：实现事务端点；回滚日志放在数据目录 `_transfer_transactions` 下，成功完成后删除。**
- [ ] **步骤 9：运行 `env/bin/python -m unittest tests.test_store tests.test_data_transfer -v`，预期全部通过。**

### 任务 2：Market Watch 领域快照与事务

**文件：**

- 新建：`backend/market-watch/market_watch/data_transfer.py`
- 修改：`backend/market-watch/market_watch/store.py`
- 修改：`backend/market-watch/market_watch/schemas.py`
- 修改：`backend/market-watch/market_watch/app.py`
- 新建：`backend/market-watch/tests/test_data_transfer.py`
- 修改：`backend/market-watch/tests/test_store.py`

**接口：**

- 消费：任务 1 的事务阶段名称和错误语义。
- 产出：与 Trading Core 相同的 HTTP 端点；领域 `schemaVersion = 1`，实际持久范围仅为 `watchlist` 和 `alerts`，缓存集合不导出。

- [ ] **步骤 1：为事务门、自选按代码去重、预警按身份去重、缓存排除和回滚编写失败测试。**
- [ ] **步骤 2：运行 `env/bin/python -m unittest tests.test_store tests.test_data_transfer -v`，确认新行为缺失导致失败。**
- [ ] **步骤 3：实现与 Trading Core 相同的存储事务门和领域传输端点。**
- [ ] **步骤 4：确保 `events`、`event_alerts`、新闻、行情及调度状态不进入快照。**
- [ ] **步骤 5：运行 `env/bin/python -m unittest tests.test_store tests.test_state_dir tests.test_data_transfer -v`，预期全部通过。**

### 任务 3：Host 备份容器与协调器

**文件：**

- 新建：`frontend/packages/investment-research/python-runtime/src/backup-contract.ts`
- 新建：`frontend/packages/investment-research/python-runtime/src/backup-archive.ts`
- 新建：`frontend/packages/investment-research/python-runtime/src/backup-service.ts`
- 修改：`frontend/packages/investment-research/python-runtime/src/index.ts`
- 修改：`frontend/packages/investment-research/python-runtime/src/types.ts`
- 修改：`frontend/packages/investment-research/python-runtime/package.json`
- 新建：`frontend/packages/investment-research/python-runtime/tests/backup-archive.spec.ts`
- 新建：`frontend/packages/investment-research/python-runtime/tests/backup-service.spec.ts`

**接口：**

- 产出远程方法：`backup-describe`、`backup-set-directory`、`backup-create`、`backup-list`、`backup-delete`、`backup-upload-begin`、`backup-upload-chunk`、`backup-upload-inspect`、`backup-import`、`backup-reset`、`backup-upload-cancel`。
- 分块大小 256 KiB；压缩文件上限 64 MiB；解压总量上限 128 MiB；条目上限 256；最多保留两个有效导入预览。
- `BackupManifest.format = "pa-investment-backup"`，`formatVersion = 1`。

- [ ] **步骤 1：为清单解析、可读文件名、SHA-256、ZIP 路径穿越、重复条目、版本过新和解压上限编写失败测试。**
- [ ] **步骤 2：运行指定 Vitest 文件，确认容器实现尚不存在。**
- [ ] **步骤 3：用 `fflate` 和 Node 流实现标准 ZIP 写入、受限读取及固定清单校验。**
- [ ] **步骤 4：为默认目录、目录变更、扫描列表、损坏文件可见、显式删除和来源不可变编写失败测试。**
- [ ] **步骤 5：实现原子配置、目录扫描和直接子文件删除保护。**
- [ ] **步骤 6：为分块上传、24 小时孤立文件清理、预览版本摘要和跨后端失败回滚编写失败测试。**
- [ ] **步骤 7：实现 Host 协调器；所有 lease 在 `finally` 中释放，安全备份失败时停止导入或重置。**
- [ ] **步骤 8：运行 `pnpm exec vitest run packages/investment-research/python-runtime/tests/backup-archive.spec.ts packages/investment-research/python-runtime/tests/backup-service.spec.ts`，预期全部通过。**

### 任务 4：Client Runtime 门面与上传控制器

**文件：**

- 修改：`frontend/packages/client/investment-research-runtime/src/client/index.ts`
- 修改：`frontend/packages/client/investment-research-runtime/tests/apply.client.spec.ts`
- 新建：`frontend/packages/client/ui-settings-investment-research/src/client/backup-upload.ts`
- 新建：`frontend/packages/client/ui-settings-investment-research/tests/backup-upload.client.spec.ts`

**接口：**

- Client 门面逐一窄化任务 3 的远程方法，不公开后端 URL、绝对临时路径或内部回滚标识。
- `uploadBackup(file, api, onProgress, signal)` 按 256 KiB 切片并顺序上传 Base64；取消和失败均调用 `backup-upload-cancel`。

- [ ] **步骤 1：为门面方法映射、释放后拒绝调用和 Remote 错误解包编写失败测试。**
- [ ] **步骤 2：扩展 `InvestmentResearchRuntimeClient` 并实现最小转发，使测试通过。**
- [ ] **步骤 3：为零字节文件、分块边界、进度、取消和中途失败清理编写失败测试。**
- [ ] **步骤 4：实现上传控制器并运行 `pnpm exec vitest run packages/client/investment-research-runtime/tests/apply.client.spec.ts packages/client/ui-settings-investment-research/tests/backup-upload.client.spec.ts`。**

### 任务 5：设置页 UI 与交互状态

**文件：**

- 新建：`frontend/packages/client/ui-settings-investment-research/src/client/DataBackupSection.tsx`
- 新建：`frontend/packages/client/ui-settings-investment-research/src/client/DataBackupSection.module.css`
- 修改：`frontend/packages/client/ui-settings-investment-research/src/client/InvestmentReadinessSection.tsx`
- 修改：`frontend/packages/client/ui-settings-investment-research/src/client/InvestmentReadinessSection.module.css`
- 修改：`frontend/packages/client/ui-settings-investment-research/src/client/index.ts`
- 修改：`frontend/packages/client/ui-settings-investment-research/src/client/store.ts`
- 修改：`frontend/packages/client/ui-settings-investment-research/src/client/locales.ts`
- 修改：`frontend/packages/client/ui-settings-investment-research/src/css-modules.d.ts`
- 修改：`frontend/packages/client/ui-settings-investment-research/tests/section.client.spec.tsx`
- 修改：`frontend/packages/client/ui-settings-investment-research/tests/apply.client.spec.ts`

**接口：**

- 消费：Client Runtime 的备份门面，以及现有 `workspaces.pickDirectory()`、`workspaces.openPath()`。
- 产出：创建、列表、导入预览、分类冲突规则、逐项冲突、删除确认和重置确认的完整用户流程。

- [ ] **步骤 1：为一级信息层级、统一“导入”文案、可读文件信息、无定时设置和来源备份不变说明编写失败组件测试。**
- [ ] **步骤 2：实现静态结构、双语文案和响应式布局，使结构测试通过。**
- [ ] **步骤 3：为加载、空列表、损坏/版本过新、创建中、上传中、校验中和成功/失败状态编写失败测试。**
- [ ] **步骤 4：实现列表加载、创建备份、目录选择、打开目录和删除确认。**
- [ ] **步骤 5：为默认冲突规则、分类修改、逐项修改及导入前备份默认勾选且可取消编写失败测试。**
- [ ] **步骤 6：实现统一导入弹窗；提交期间锁定关闭，完成后刷新备份列表和投研页面数据。**
- [ ] **步骤 7：为分类重置、清空全部、清空前备份默认勾选、取消警告和“不删除已有备份”说明编写失败测试。**
- [ ] **步骤 8：实现重置确认与结果反馈，使键盘焦点、`aria-live` 和禁用状态符合规格。**
- [ ] **步骤 9：运行 `pnpm exec vitest run packages/client/ui-settings-investment-research/tests/section.client.spec.tsx packages/client/ui-settings-investment-research/tests/apply.client.spec.ts packages/client/ui-settings-investment-research/tests/backup-upload.client.spec.ts`。**

### 任务 6：组合验证与真实产品 UAT

**文件：**

- 修改：`frontend/packages/bundle/investment-runtime/package.json`（仅在新增依赖未随现有 Runtime 自动装配时）
- 修改：`frontend/packages/bundle/investment-runtime/tests/bundle.spec.ts`（与上一项保持一致）
- 新建：`docs/superpowers/handoffs/2026-09-07-data-backup-import-uat.md`

**接口：**

- 消费：任务 1–5 的完整纵向切片。
- 产出：自动化验证记录、真实渲染证据和未关闭验证债务。

- [ ] **步骤 1：运行两个 Python 领域传输测试套件和前端三个相关测试套件。**
- [ ] **步骤 2：运行受影响 TypeScript 包的 bundle/typecheck，确认没有 Remote 类型漂移。**
- [ ] **步骤 3：用隔离端口和临时 `DSH_HOME` 启动投研 Profile，不占用共享 `3080` 服务。**
- [ ] **步骤 4：真实创建备份并检查 ZIP、文件名、列表刷新与打开目录。**
- [ ] **步骤 5：在另一份隔离状态中导入，核对默认冲突规则、再次导入幂等性及来源备份未变化。**
- [ ] **步骤 6：注入第二后端提交失败，核对第一后端回滚且 UI 明确报告结果。**
- [ ] **步骤 7：验证选择性重置和清空全部均不删除备份；验证取消安全备份后的风险提示。**
- [ ] **步骤 8：检查 1440、1024、768、390 像素宽度及键盘操作，将结果写入 UAT 记录。**

## 基线记录

- `ui-settings-investment-research`：22 项测试通过。
- `investment-python-runtime` 的 `data/state/runtime`：89 项测试通过。
- `market-watch` 的 `test_store/test_state_dir`：9 项测试通过。
- `trading-core` 的 `test_store` 通过；`test_state_dir.test_packaged_runtime_writes_only_beneath_state_root` 在当前最小测试环境因未安装完整量化引擎依赖 `langgraph` 无法执行。该测试与本功能无直接交集，最终 UAT 前必须在完整后端依赖环境补跑并记录结果。
