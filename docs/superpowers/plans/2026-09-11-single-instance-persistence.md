# PAB-18 单实例持久化实施计划

## 范围

从 `72f0a8e029618b3bafc7c2f33adc4105c9c4537a` 在 `codex/pab18` 实施统一目录契约、Host 托管后端状态根注入、industry-chain 写路径修正和副本迁移工具。复用 PAB-14，不修改 Docker/Compose、认证面、CI 或云端文件 UI。

## 实施顺序

1. 先用 home-paths 测试固定 Host、备份和三个后端的完整路径映射。
2. 先用 python-runtime 测试证明 source managed child 缺少状态根，再统一注入 `DSH_INVESTMENT_STATE_DIR`。
3. 先扩展 industry-chain state-dir 测试覆盖 reports、universe、overlay 和 LLM links，再把全部路径改由 `settings.data_root` 或 `settings.reports_dir` 派生。
4. 先为初始化、零写入 dry-run、物理路径与 TOCTOU、挂载点事务发布／回滚、managed profile 依赖排除、备份路径重定位、流式 SHA-256、SQLite 文件头与在线一致性边界写测试，再实现目标内部 staging + marker-last 事务迁移。
5. 更新 package README、当前 Runtime Agent Note、用户指南和维护者操作文档，说明 PAB-14 边界、目录分类和两类回滚。
6. 执行聚焦 Vitest、三个后台状态测试、`build:lib` 和仅使用临时副本的重建／恢复失败演练。
7. 自查 diff 后创建单一 `[AI]` commit，推送 `private/codex/pab18`，向公共 `master` 创建 PR，并把证据回写 PAB-18。

## 安全条件

- 不读取、复制、移动、覆盖或清空真实用户数据。
- 不使用端口 `3080`；没有真实服务需求时不启动常驻服务。
- 来源与目标必须是物理路径互不包含的绝对目录，身份变化或目标非空即失败。
- 凭据、缓存、日志、进程状态、锁、事务日志和未完成上传不进入普通实例迁移。
- 在线 SQLite 没有一致性备份实现时明确失败；Host 会话与附件没有共同快照屏障时不允许在线逐文件迁移。
