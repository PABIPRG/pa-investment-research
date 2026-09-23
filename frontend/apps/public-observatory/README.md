# 公开观察室

免登录、只读的账户表现页面，计划绑定 `https://pair-observe.xiexin.dev`。该目录作为独立 Vercel Project 的 Root Directory，构建时需启用“Include source files outside of the Root Directory”，以便复用 monorepo 内的 UI primitives 和品牌资源。

## 环境变量

- `VITE_PUBLIC_API_BASE_URL`：云端 Host 的 HTTPS 根地址。浏览器只会访问其 `/api/public/performance/v1/*` 固定只读接口。

云端 Host 为 `https://pair-demo.xiexin.dev`；Vercel 项目需设置同名构建变量，修改后重新构建部署。`vercel.json` 的 CSP 仅允许连接该 Origin。前端地址配置正确与 Docker 健康都不能证明公开接口已启用。

本应用不保存账户数据、密钥或登录状态。Vercel 域名绑定、环境变量写入和正式部署需要单独执行发布授权。

账户金额与操作记录独立加载；缺少完整权益快照或账户读取失败时，金额显示“—”，已批准的操作仍可显示、筛选并展开详情。资金请求缓慢不会阻止先显示操作。持仓导入／重置详情只展示数量与成本前后值，不推断买卖、资金流或收益；回滚记录在“失败 / 已回滚”筛选中展示。操作时间标为“记录于”，代表归档时间。页面尚不展示独立于完整权益快照的当前持仓列表。

浏览器请求显式禁用凭据、重定向与缓存。API 地址只接受 HTTPS（本地回归允许 localhost/127.0.0.1 的 HTTP）；页面仅能读取服务端批准的账户快照。公开范围、写入令牌、限流与重启要求见 [Host 网关说明](../../packages/host/public-observatory/README.md)，这些服务端变量不能配置为 `VITE_*`。

日历接口的 `days` 与账户快照 `items` 独立：每天返回 `trading_status`（`trading`、`closed`、`unknown`）。交易状态只读取服务端已加载的交易日历，公开请求不触发拉取；尚未覆盖的工作日显示“待确认”，周末显示“休市”。

## Docker 发布配置

根目录 [compose.yaml](../../../compose.yaml) 显式映射观察室服务端变量；只在服务器 `.env` 中添加键，而没有更新实际部署 Compose 的 `investment.environment`，不会把配置传入容器。服务器已有自定义网络、持久卷和策略运行配置时，只合并相关映射，不整份覆盖 Compose。[配置示例](../../../.env.container.example) 默认关闭公开读取，不包含账户数据或真实令牌。

| 位置 | 配置 | 用途及默认值 |
|---|---|---|
| Vercel 构建环境 | `VITE_PUBLIC_API_BASE_URL=https://pair-demo.xiexin.dev` | 前端向哪个 Host 发起请求 |
| Docker 运行环境 | `DSH_PUBLIC_OBSERVATORY_ORIGIN=https://pair-observe.xiexin.dev` | 精确来源，不带尾 `/`；留空关闭公开网关 |
| Docker 运行环境 | `DSH_PUBLIC_OBSERVATORY_OPERATIONS_SINCE` | 经批准的操作公开起点，含时区；留空不公开操作 |
| Docker 运行环境 | `DSH_PUBLIC_OBSERVATORY_SNAPSHOT_IDS` | 经逐份批准的账户快照 ID JSON 数组；默认 `[]` |
| Docker 运行环境 | `DSH_PUBLIC_OBSERVATORY_WRITE_TOKEN` | 私有快照写入专用；公开读取不需要，默认空 |

先确认公开范围，再在既有部署目录的环境文件设置对应值；例如使用 `.env.container` 时，必须在既有 Compose 流程中指定 `--env-file .env.container`。仅更新镜像不会补齐旧 Compose 的映射，`restart` 也不会更新已有容器的环境。发布者须在备份和既有部署审批完成后，通过部署流程重新创建 Host 容器及 managed 后端；不更改 `DSH_WEB_AUTH=required`、数据卷或其他业务变量。attached/external 后端需独立注入其服务端许可。

发布后从真实观察室页面验收，并以不带凭据的读取辅助检查响应；不要把令牌或整个容器环境打印到日志：

```sh
curl -i -H 'Origin: https://pair-observe.xiexin.dev' 'https://pair-demo.xiexin.dev/api/public/performance/v1/overview?date=2026-09-23'
curl -i -H 'Origin: https://pair-observe.xiexin.dev' 'https://pair-demo.xiexin.dev/api/public/performance/v1/activities?as_of=2026-09-23&category=all&status=all&limit=20'
```

日期替换为待验收日期。两路均须返回 JSON 和精确的 `Access-Control-Allow-Origin: https://pair-observe.xiexin.dev`；同时确认原有私有接口仍要求登录。`404 not-found` 表示公开网关未开启或路由不匹配，`403 request-untrusted` 检查 Host/Origin 信任，`503 temporarily-unavailable` 检查已运行后端与操作索引。`200` 且 `availability=unavailable` 才是请求成功但无获准完整账户快照，不能与网络失败混淆。

私有 Web 的持仓成本、市值与浮盈来自持仓和行情计算，不包含现金，不自动生成 `account_snapshots`。启用网关不会把这些金额转换成完整账户权益。资金快照缺失仍显示“—”，不回填现金或用持仓成本代替初始资金。停止公开时撤销对应服务端许可并重新创建容器；不删除数据卷，已被访客保存的公开内容无法追溯收回。

## 控件与验证

操作筛选复用共享 `Select`，可一步清除类型与状态；通用动作复用 `Button`，重试期间禁用重复请求。计算口径使用有可见标签的 `HelpPopover`，不打开模态遮罩。日期、月份和详情继续使用共享组件；日历格、活动整行及原生语义复选框保留专用交互。页面 CSS 不覆盖全局按钮样式。
