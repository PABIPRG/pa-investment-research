# trading-core Python backend

`dsh-trading-core` is the Python FastAPI backend for multi-agent stock analysis. It contains the engine, the adapter API, and its local runtime data; it does not install or start JavaScript tooling.

The host-side integration source now lives in [frontend/packages/investment-research/stock-analysis](../../frontend/packages/investment-research/stock-analysis). The backend API and SSE contract remain authoritative here in [docs/API-接口文档.md](docs/API-接口文档.md).

## Python setup and current local run

```sh
cd backend/dsh-trading-core
./init.sh
cp .env.example .env # then set DEEPSEEK_API_KEY for engine mode
./start.sh           # ADAPTER_RUNNER=engine by default
./start.sh fake       # deterministic local fake runner
./verify.sh
```

On Windows, use `init.bat`, `start_all.bat [fake|engine]`, and `verify.bat`. The wrappers start only `uvicorn adapter.app:app` on `127.0.0.1:8000`; `ADAPTER_RUNNER=fake|engine` can be supplied as an environment variable or the optional start argument. Logs are written to `logs/adapter.log`.

`stop_all.sh` and `stop_all.bat` are manual Python-backend wrappers for port `8000`. They do not implement the Phase 2 Runtime's owned-process rules.

## API

服务提供分析、持仓、市场简报、自选、风险画像与持久通知中心接口。通知历史位于 `data/notifications.sqlite3`（打包版位于 Host 管理的状态目录），可通过“通知历史与设置”分类备份；恢复时不会迁移设备订阅，也不会重新激活未完成投递。

浏览器 Web Push 需要配置 `.env.example` 中的 VAPID 变量；Server 酱、企业微信和邮件共用同一条持久投递队列。外部渠道不可用时，站内通知仍是权威记录。相关文档：

- [API interface document](docs/API-接口文档.md)
- [Frontend integration guide](docs/前端接入指南.md)
- [Risk-profile framework](docs/风险偏好分析框架.md)
- [Cross-environment operation](docs/跨环境运行.md)

## Product integration

### 持仓账户操作留痕

涉及 `holdings` 的导入和重置在最终清理事务前，将持仓与成交的精确前后镜像保存在数据目录的 `_holdings_operation_history/<事务 UUID>.json`。归档仅属于现有持仓账户，不包含影子策略集合；回滚记录的实际后状态等于前状态。该目录不属于可迁移分类，因此普通分类导入、导出和重置不会覆盖或迁移它，完整部署备份必须包含该目录。

归档为私有数据，不是公开 API 响应，不能直接发送给观察室。只有验证同事务的 Host 全局提交决定才记录 `host_committed`；没有配置协调目录的独立调用仅记录 `backend_only`，不代表跨服务操作整体成功。重复完成幂等，已用 UUID 不可重用，归档失败保留事务以便重试。新事务保留开始、局部提交与回滚时间，旧日志缺少的时间不补造；`observedAt` 是归档观察时间。

正常 JsonStore 写入统一记录持仓、历史快照、手工成交、历史起点校正与成交明细的变化；相同数据、重复成交请求不重复记账。跨进程目录锁协调 CLI 与服务写入，预写日志 `_holdings_mutation_wal/pending.json` 保存前后摘要，业务原子替换后才归档到同一操作历史目录。正常记录只保留紧凑字段差分，不把整份成交历史反复复制；传输中间态不会被记为普通成功操作。

手工成交请求通过 `affects_holdings` 区分“调整当前持仓”和“仅补成交记录”。两种方式都先预览并校验文档版本，再以请求编号幂等保存；仅补记录只追加 `manual_trades`，不改 `default` 或已有 `snapshots`，也不倒推组合收益。调整当前持仓按保存时的数量与成本计算，并追加本次生效的快照；成交时间早于最近持仓变更时必须显式提供该选择，不能把旧成交自动当成新的持仓变化。旧请求未提供该字段时保留原有正常追加行为和历史时间保护。

启动、下一次写入和导入／重置 prepare 会先恢复 pending：精确匹配新状态时补记，匹配旧状态时取消未生效意图，无法匹配时停止覆盖并保留现场。业务已保存而归档失败时返回业务结果并输出明确告警，pending 保留至成功恢复；公开读取暂不可用，不负责执行恢复。正常记录时间是写入意图记录时间，不是成交时间。Linux/macOS 使用文件与目录 fsync；Windows 使用文件锁、文件 fsync 和原子替换，不提供相同的断电持久保证。

包含持仓的 Host 备份，在真实文件生成并回读校验后，由私有 `POST /data-transfer/export-completed` 确认。接口要求 Host Bearer 且请求只能包含 `operation_id`；后端仅读取协调目录 `export-receipts/<UUID>.json` 中已验证且有界的普通文件，不接受调用方路径或成功文案。事件保留手动／导入前／重置前用途、开始与校验时间，复用不可变归档、pending 与索引，不改持仓或现金。重复 UUID 相同内容幂等，不同内容拒绝；索引故障保留 pending 并由私有恢复完成。读取快照或下载请求本身不是成功导出证据。Host 与 backend 必须同步升级，恢复材料需要随整个状态卷持久挂载。

外部手改 JSON 不在当前留痕范围。归档私有且无自动清理，部署需监控容量并对整个状态卷备份（含审计与预写目录）；不能只备份分类 JSON。该机制不抵御有权限直接修改数据卷的操作者，也不能保证整个数据卷回退后仍保留备份之后的记录。公开许可与限额见[公开网关](../../frontend/packages/host/public-observatory/README.md)。

### 操作查询索引与恢复

`_holdings_operation_index/projection.sqlite3` 是归档的派生查询索引，不是账户账本。业务写入按“归档持久化 → 索引事务提交 → 清理 pending／传输材料”的顺序完成；索引不可用时保留恢复材料，公开接口返回暂不可用。索引只保存固定字段摘要、数量／成本变化和必要的私有查询元数据，不保存自由文本原文。

私有启动与首次账户写入会迁移既有归档；每份原文最多 32 MiB，流式处理且不限制归档累计数量。已有完整索引不重复扫描。首次初始化中断允许私有入口重试；SQLite 崩溃日志由私有可写连接恢复，匿名请求不做恢复。损坏或未知版本的索引失败关闭，不自动覆盖。确认事实源完整后，可由私有维护调用 `adapter.holdings_operation_index.rebuild(store)` 单事务重建；失败保留旧完整索引，成功使旧分页游标失效。禁止在运行中的数据库上直接覆盖文件；升级和整卷恢复需保留原始归档，索引可在停机维护时重建。

匿名查询以只读连接按时间和公开 ID 翻页，每次最多读取 51 份摘要或 1 份详情，分别限制为 4 KiB／512 KiB；SQLite 锁等待最多 50 毫秒，执行受时间和指令预算限制，超限返回不可用而非截断历史。分页冻结首屏入库上界，新增或回填记录在重新读取首屏后出现。许可范围／索引代次变化返回 409，页面清旧分页重读；游标用认证加密隐藏私有序号，授权与内容字段绑定校验，不能把旧私有内容拼到已公开行上。

`dsh electron --profile investment-research` is a **Phase 2 deliverable and is not enabled in the current phase**. When it is delivered, the product profile and its Runtime will be owned by the frontend workspace; this backend continues to expose its Python API without starting the product shell.
