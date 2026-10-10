# 公开观察室

免登录、只读的账户表现页面，计划绑定 `https://pair-observe.xiexin.dev`。该目录作为独立 Vercel Project 的 Root Directory，构建时需启用“Include source files outside of the Root Directory”，以便复用 monorepo 内的 UI primitives 和品牌资源。

## 环境变量

- `VITE_PUBLIC_API_BASE_URL`：云端 Host 的 HTTPS 根地址。浏览器只会访问其 `/api/public/performance/v1/*` 固定只读接口。

云端 Host 为 `https://pair-demo.xiexin.dev`；Vercel 项目需设置同名构建变量，修改后重新构建部署。`vercel.json` 的 CSP 仅允许连接该 Origin。前端地址配置正确与 Docker 健康都不能证明公开接口已启用。

本应用不保存账户数据、密钥或登录状态。Vercel 域名绑定、环境变量写入和正式部署需要单独执行发布授权。

页面通过 `/api/public/performance/v1/bundle` 一次读取截至北京时间昨日的最近 90 日公开批次，包括有效日期、逐日概览与持仓、历史曲线、月份日历和公开活动详情。日期控件、前后日、播放、滑块与日历共用有效日期；休市和缺少当日报价的日期跳过。默认最新有效日，少于两日禁播，空持仓的零值不等于缺失。概览与持仓取同一日期的真实报价；现金、初始资金和完整权益无可靠来源时保持“—”。历史收益沿用已有资金流估算，不将调仓市值直接算作收益。

浏览期间的数据仅保留在页面内存：切日、跨月、筛选、展开详情和本地分页不产生请求；断网仍可播放。只有首次进入、手动刷新和非播放状态下的北京时间跨日读取批次，成功后停止请求。刷新保持完整旧批次，失败标示可能过期，恢复后整批替换并清理旧详情；访问被撤销则清除内容。隐藏或断网暂停新请求，失败按 30/60/120 秒退避并尊重限流等待；所有请求含响应体最多等待 30 秒。历史选择保留，最新模式跟随新批次的最新有效日。

公开活动最多载入最近 1000 条已获准记录及详情，截断时明确提示更早记录未包含；活动读取失败不清空可用历史。证券名称一次批量补全，报价仅用于名称，历史金额不使用当前报价。月份列表限定本批范围；跨缺失交易日的差额不显示为每日盈亏。盈亏继续涨红跌绿，缺失不补零。

浏览器请求显式禁用凭据、重定向与缓存。API 地址只接受 HTTPS（本地回归允许 localhost/127.0.0.1 的 HTTP）；公开响应采用固定字段，不透传私有接口原文。公开范围、写入令牌、限流与重启要求见 [Host 网关说明](../../packages/host/public-observatory/README.md)，这些服务端变量不能配置为 `VITE_*`。

日历接口的 `days` 提供 `trading_status`（`trading`、`closed`、`unknown`）；历史估值与交易日状态分别展示：未知交易日保留已有估值和可计算的估算盈亏，不推断为确认交易日；休市日不展示盈亏，缺少前日收益基准时显示“—”。历史交易日缺少估值或收益基准使用浅黄色底色、虚线边框与“缺估值 / 缺基准”文字，休市使用中性色并保留“休市”标签；当日交易日显示“待更新”（T+1），未来交易日显示“未到”，两者不标记为历史数据缺失。交易状态只读取服务端已加载的交易日历，公开请求不触发拉取；尚未覆盖的工作日显示“待确认”，周末显示“休市”。

页首标明“A 股 · T+1 历史数据”，避免将历史估值呈现为当前实时行情。

## Docker 发布配置

根目录 [compose.yaml](../../../compose.yaml) 显式映射观察室服务端变量；只在服务器 `.env` 中添加键，而没有更新实际部署 Compose 的 `investment.environment`，不会把配置传入容器。服务器已有自定义网络、持久卷和策略运行配置时，只合并相关映射，不整份覆盖 Compose。[配置示例](../../../.env.container.example) 默认关闭公开读取，不包含账户数据或真实令牌。

| 位置 | 配置 | 用途及默认值 |
|---|---|---|
| Vercel 构建环境 | `VITE_PUBLIC_API_BASE_URL=https://pair-demo.xiexin.dev` | 前端向哪个 Host 发起请求 |
| Docker 运行环境 | `DSH_PUBLIC_OBSERVATORY_ORIGIN=https://pair-observe.xiexin.dev` | 精确来源，不带尾 `/`；留空关闭公开网关 |
| Docker 运行环境 | `DSH_PUBLIC_OBSERVATORY_OPERATIONS_SINCE` | 经批准的操作公开起点，含时区；留空不公开操作 |
| Docker 运行环境 | `DSH_PUBLIC_OBSERVATORY_RESEARCH_SINCE` | 研究报告固定摘要的公开起点，含时区；留空不公开研究活动 |
| Docker 运行环境 | `MW_URL` | trading-core 到既有 market-watch 的内部地址，用于当前持仓批量报价 |
| Docker 运行环境 | `DSH_PUBLIC_OBSERVATORY_SNAPSHOT_IDS` | 旧完整账户快照接口的许可；新页面不依赖，默认 `[]` |
| Docker 运行环境 | `DSH_PUBLIC_OBSERVATORY_WRITE_TOKEN` | 私有快照写入专用；公开读取不需要，默认空 |

先确认公开范围，再在既有部署目录的环境文件设置对应值；例如使用 `.env.container` 时，必须在既有 Compose 流程中指定 `--env-file .env.container`。仅更新镜像不会补齐旧 Compose 的映射，`restart` 也不会更新已有容器的环境。发布者须在备份和既有部署审批完成后，通过部署流程重新创建 Host 容器及 managed 后端；不更改 `DSH_WEB_AUTH=required`、数据卷或其他业务变量。attached/external 后端需独立注入其服务端许可。

发布后从真实观察室页面验收，并以不带凭据的读取辅助检查响应；不要把令牌或整个容器环境打印到日志：

```sh
curl -i -H 'Origin: https://pair-observe.xiexin.dev' 'https://pair-demo.xiexin.dev/api/public/performance/v1/bundle?from=2026-09-01&to=2026-09-23'
curl -i -H 'Origin: https://pair-observe.xiexin.dev' 'https://pair-demo.xiexin.dev/api/public/performance/v1/history?from=2026-09-01&to=2026-09-23'
curl -i -H 'Origin: https://pair-observe.xiexin.dev' 'https://pair-demo.xiexin.dev/api/public/performance/v1/activities?as_of=2026-09-23&category=all&status=all&limit=20'
```

日期替换为待验收日期。各路均须返回 JSON 和精确的 `Access-Control-Allow-Origin: https://pair-observe.xiexin.dev`；同时确认原有私有接口仍要求登录。`404 not-found` 表示公开网关未开启或路由不匹配，`403 request-untrusted` 检查 Host/Origin 信任，`503 temporarily-unavailable` 检查已运行后端与操作索引。`/live` 返回 `availability=unavailable` 表示所选历史日期早于首份持仓记录；当前持仓即使缺少完整账户快照也应返回持仓事实。

页面历史持仓成本、市值与浮盈来自同一日期的持仓记录和估值，不包含现金，不自动生成 `account_snapshots`。启用网关不会把这些金额转换成完整账户权益。现金与初始资金缺失仍显示“—”，不回填或用持仓成本代替。停止公开时关闭服务端公开网关并重新创建容器；不删除数据卷，已被访客保存的公开内容无法追溯收回。

## 控件与验证

操作筛选复用共享 `Select`，可一步清除类型与状态；通用动作复用 `Button`，重试期间禁用重复请求。计算口径使用有可见标签的 `HelpPopover`，不打开模态遮罩。历史与日历的常规说明合并为“收益说明”，支持悬停、键盘聚焦与点击固定；历史区间在标题右侧展示。缺失与刷新失败仍显示简短可见状态，详细口径放在说明浮层中。日期、月份和详情继续使用共享组件；日历格与活动整行保留专用交互。页面 CSS 不覆盖全局按钮样式。

本地浏览器回归：先用 `VITE_PUBLIC_API_BASE_URL=http://127.0.0.1:3419 pnpm --filter @deepseek-ai/dsh-public-observatory build` 构建，在 frontend 目录设置 `OBSERVATORY_TEST_PYTHON` 为可运行 trading-core 的 Python 解释器，再运行 `DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/observatory-refresh-density.e2e.ts apps/web/tests/observatory-timeline.e2e.ts`。测试启动独立 3418/3419 端口、真实 Python 公开路由和临时虚构账户，行情/名称均为夹具；浏览器阻断非本机请求。覆盖同批金额、有效日期、零新增请求、断网浏览、跨日、刷新失败恢复、空/单点、四档视口、明暗主题、键盘与详情焦点恢复。

隔离端口可通过 `OBSERVATORY_UAT_PORT` 与 `OBSERVATORY_UAT_API_PORT` 指定；构建时的 `VITE_PUBLIC_API_BASE_URL` 需与本地 API 端口一致。
