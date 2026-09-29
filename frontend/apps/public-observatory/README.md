# 公开观察室

免登录、只读的账户表现页面，计划绑定 `https://pair-observe.xiexin.dev`。该目录作为独立 Vercel Project 的 Root Directory，构建时需启用“Include source files outside of the Root Directory”，以便复用 monorepo 内的 UI primitives 和品牌资源。

## 环境变量

- `VITE_PUBLIC_API_BASE_URL`：云端 Host 的 HTTPS 根地址。浏览器只会访问其 `/api/public/performance/v1/*` 固定只读接口。

云端 Host 为 `https://pair-demo.xiexin.dev`；Vercel 项目需设置同名构建变量，修改后重新构建部署。`vercel.json` 的 CSP 仅允许连接该 Origin。前端地址配置正确与 Docker 健康都不能证明公开接口已启用。

本应用不保存账户数据、密钥或登录状态。Vercel 域名绑定、环境变量写入和正式部署需要单独执行发布授权。

当前持仓由既有 `holdings.default` 与 market-watch 批量行情计算，汇总与逐只明细使用同一批报价；市值、成本、浮盈和成本收益率均不含现金。缺少报价保留持仓事实，汇总市值和浮盈显示“—”。现金、初始资金与完整总权益没有可靠来源时显示“—”。历史曲线和月历使用已有持仓快照与资金流估算，调仓市值差额不直接当盈亏；历史日期只沿用截至当日已记录的持仓。概览、历史、日历与操作活动独立加载，刷新失败保留同一查询的上次结果并提示可能过期。

浏览器请求显式禁用凭据、重定向与缓存。API 地址只接受 HTTPS（本地回归允许 localhost/127.0.0.1 的 HTTP）；公开响应采用固定字段，不透传私有接口原文。公开范围、写入令牌、限流与重启要求见 [Host 网关说明](../../packages/host/public-observatory/README.md)，这些服务端变量不能配置为 `VITE_*`。

日历接口的 `days` 提供 `trading_status`（`trading`、`closed`、`unknown`）；页面仅在确认交易日且存在历史估值时显示估算日盈亏。交易状态只读取服务端已加载的交易日历，公开请求不触发拉取；尚未覆盖的工作日显示“待确认”，周末显示“休市”。

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
curl -i -H 'Origin: https://pair-observe.xiexin.dev' 'https://pair-demo.xiexin.dev/api/public/performance/v1/live?date=2026-09-23'
curl -i -H 'Origin: https://pair-observe.xiexin.dev' 'https://pair-demo.xiexin.dev/api/public/performance/v1/history?from=2026-09-01&to=2026-09-23'
curl -i -H 'Origin: https://pair-observe.xiexin.dev' 'https://pair-demo.xiexin.dev/api/public/performance/v1/activities?as_of=2026-09-23&category=all&status=all&limit=20'
```

日期替换为待验收日期。各路均须返回 JSON 和精确的 `Access-Control-Allow-Origin: https://pair-observe.xiexin.dev`；同时确认原有私有接口仍要求登录。`404 not-found` 表示公开网关未开启或路由不匹配，`403 request-untrusted` 检查 Host/Origin 信任，`503 temporarily-unavailable` 检查已运行后端与操作索引。`/live` 返回 `availability=unavailable` 表示所选历史日期早于首份持仓记录；当前持仓即使缺少完整账户快照也应返回持仓事实。

当前持仓成本、市值与浮盈来自同一批持仓和行情，不包含现金，不自动生成 `account_snapshots`。启用网关不会把这些金额转换成完整账户权益。现金与初始资金缺失仍显示“—”，不回填或用持仓成本代替。停止公开时关闭服务端公开网关并重新创建容器；不删除数据卷，已被访客保存的公开内容无法追溯收回。

## 控件与验证

操作筛选复用共享 `Select`，可一步清除类型与状态；通用动作复用 `Button`，重试期间禁用重复请求。计算口径使用有可见标签的 `HelpPopover`，不打开模态遮罩。日期、月份和详情继续使用共享组件；日历格、活动整行及原生语义复选框保留专用交互。页面 CSS 不覆盖全局按钮样式。
