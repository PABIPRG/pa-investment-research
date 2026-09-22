# 公开观察室实施计划

关联 [PAB-30](https://linear.app/pabiprg/issue/PAB-30/建立免登录公开观察室与只读投研投影) 与[公开观察室设计](../specs/2026-09-19-public-observatory-design.md)。角色为 `worktree-writer`，独立目录为 `/Users/xiexin/.codex/worktrees/b818/pa-investment-research`，基准为 `524232a9bfb9e989a0abd9f80a68d7603f46da86`，目标分支为 `codex/public-observatory`。独立服务端口为 3198；不得操作共享 3080。未授权提交、推送特性分支、创建 PR、部署或绑定域名。

## 阶段一：账户快照与公开投影

1. 先写 trading-core 测试，固定账户快照金额、revision、不可变读取、指定日期缺失和字段白名单。
2. 在 holdings/account 所有者内实现账户快照模型与存储，不复用影子账户或缺少现金的组合表现结果。
3. 增加内部读取函数和固定公开 DTO；没有权威快照时返回 unavailable，不在读取时迁移或计算。
4. 增加已登录侧账户校准操作的后端合同，为后续私有设置入口提供写入能力；公开路由不暴露该操作。

## 阶段二：Host 公开读取边界

1. 先写 Host 测试，证明精确 Origin 的匿名 GET/HEAD 成功，错误 Origin、方法和路由失败，既有受保护接口保持不变。
2. 新建 Host 包，注册六类精确公开路由并通过 `InvestmentPythonRuntime.getRunningBackend('trading-core')` 访问已运行后端；禁止公开请求启动或保活业务进程。
3. 增加生产配置：公开 Origin 与限流参数由 Web 启动配置显式注入；默认未配置时公开路由不可用。
4. 把包加入 Web bundle roster，并补充包 README、Agent Note 与配置文档。

## 阶段三：独立 Vercel 应用

1. 在 `frontend/apps/public-observatory` 建立独立 Vite/React 应用、Vercel 配置和 `VITE_PUBLIC_API_BASE_URL` 校验。
2. 先实现 API client、请求 revision 隔离和状态 store 测试，再连接页面。
3. 按交互稿实现时间切片、概览、ECharts 权益曲线、持仓、活动和月历。
4. 在 UI primitives 增加 DatePicker 与 MonthPicker，补充导出、键盘、焦点与主题测试。
5. 官网入口作为独立小改动最后接入，保持官网构建和 SEO 验证通过。

## 阶段四：验证与交付

1. 运行 trading-core、Host、UI primitives 和公开应用聚焦测试。
2. 运行受影响包类型检查、构建、主题校验、Markdown 链接和 diff 检查。
3. 使用端口 3198 和隔离状态目录完成真实浏览器 UAT，记录通过项和验证债务。
4. 生产 Vercel Project、`pair-observe.xiexin.dev` 绑定、API Origin 配置与部署等待用户单独授权。

## 执行结果（2026-09-19）

- 阶段一至阶段三的代码与文档已在 `codex/public-observatory` worktree 完成；官网入口按独立改动边界留待后续。
- trading-core 聚焦测试 10 项通过；Host 信任边界、公开网关与前端 API client 共 12 项通过；Web startup 聚焦测试 8 项通过。
- Host 公开网关、公开应用及实际使用的共享组件严格 TypeScript 检查通过；production build 通过，保留 ECharts 单 chunk 大小提醒。
- 真实浏览器 UAT 通过：免登录入口、日期切换、播放/暂停、历史刷新暂停、筛选与空态、三类弹层、父子弹层返回、图表键盘、失败恢复、浅深主题及 1440 / 1024 / 768 / 390px。
- `git diff --check` 通过。生产部署、域名绑定、生产 Origin、真实账户数据链路为 `not-tested`，等待单独授权。

## 安全加固与验证（2026-09-20）

1. 用部署端精确内容 ID 白名单控制公开，默认关闭，不改动既有单账户账本或备份格式。新快照和私有历史成交不自动发布；批准内容校验失败不可见。撤销需移除部署 ID 并重启，不通过删除账户记录实现。
2. 新写端使用专用服务端 token，先鉴权再解析有限请求体；公开读取使用无创建目录、无锁等待、有字节上限的原子文档读取。失败统一脱敏，不回退到私有数据或估值。
3. Runtime 增加不持有生命周期的运行中端点读取；公开 GET 不调用 acquire。网关限制全程上游等待、下行发送、响应字节、并发、每 IP 与总请求速率，修正 Loader 导出、错误标头和重复参数。
4. 自动化先复现旧缺陷，再运行 Python/TypeScript 聚焦回归、真实 Loader 与 HTTP、慢客户端、临时账户的 Python 实链；浏览器验证已批准展示、撤销清空、重新批准恢复和活动详情。生产发布仍单独授权。

回滚可关闭 Host Origin 并清空快照白名单，账户原始记录不删除。生产入口统一限流、后端端口隔离及账户快照恢复能力仍需部署/后续专项验证，不能将本地通过等同线上通过。
