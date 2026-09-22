# 公开观察室

免登录、只读的账户表现页面，计划绑定 `https://pair-observe.xiexin.dev`。该目录作为独立 Vercel Project 的 Root Directory，构建时需启用“Include source files outside of the Root Directory”，以便复用 monorepo 内的 UI primitives 和品牌资源。

## 环境变量

- `VITE_PUBLIC_API_BASE_URL`：云端 Host 的 HTTPS 根地址。浏览器只会访问其 `/api/public/performance/v1/*` 固定只读接口。

用户指定云端 Host 为 `https://pair-demo.xiexin.dev`，本地 `.env.local` 与 `.env.example` 已配置该地址；Vercel 项目仍需单独设置同名构建变量。`vercel.json` 的 CSP 仅允许连接该 Origin。2026-09-20 实测公开 overview 路径带观察室 Origin 返回 403，不带 Origin 返回 401 `auth-required`，云端公开路由尚未验证可用。

本应用不保存账户数据、密钥或登录状态。Vercel 域名绑定、环境变量写入和正式部署需要单独执行发布授权。

账户金额与操作记录独立加载；缺少完整权益快照或账户读取失败时，金额显示“—”，已批准的操作仍可显示、筛选并展开详情。资金请求缓慢不会阻止先显示操作。持仓导入／重置详情只展示数量与成本前后值，不推断买卖、资金流或收益；回滚记录在“失败 / 已回滚”筛选中展示。操作时间标为“记录于”，代表归档时间。页面尚不展示独立于完整权益快照的当前持仓列表。

浏览器请求显式禁用凭据、重定向与缓存。API 地址只接受 HTTPS（本地回归允许 localhost/127.0.0.1 的 HTTP）；页面仅能读取服务端批准的账户快照。公开范围、写入令牌、限流与重启要求见 [Host 网关说明](../../packages/host/public-observatory/README.md)，这些服务端变量不能配置为 `VITE_*`。

日历接口的 `days` 与账户快照 `items` 独立：每天返回 `trading_status`（`trading`、`closed`、`unknown`）。交易状态只读取服务端已加载的交易日历，公开请求不触发拉取；尚未覆盖的工作日显示“待确认”，周末显示“休市”。
