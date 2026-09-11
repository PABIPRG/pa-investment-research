# PAB-17 Web 单用户管理员鉴权设计

## 目标与边界

为 Web 版增加默认关闭、显式启用的单用户管理员鉴权。鉴权开启后，所有 `/api` HTTP、通用 RPC 和 WebSocket 下行在进入业务处理前都必须通过会话校验；Electron/IPC、会话持久化、投资 Python 运行时和容器编排不在本次范围。

## 安全模型

- 管理员名和版本化 scrypt 密码哈希来自启动环境；服务不接收明文配置，也不记录凭据、Cookie 或 CSRF 值。
- 登录成功后只向浏览器写入随机不透明 Cookie；会话内容保存在进程内，并同时受空闲和绝对有效期约束。
- Cookie 使用 `HttpOnly`、`SameSite=Strict`、`Path=/`；非 HTTPS Cookie 只允许显式的回环开发模式。
- 所有状态变更请求在会话 Cookie 之外还必须携带会话绑定的 CSRF 令牌。
- 登录按来源地址和全局窗口限流；来源只取直连 socket 地址，不信任转发头。
- 注销、过期和插件卸载会撤销会话并关闭该会话已登记的 WebSocket。
- 原有 Host/Origin/Sec-Fetch DNS 重绑定防线和回环特权方法限制继续生效，鉴权不能替代它们。

## 接口

- `GET /auth/session`：返回 `disabled`、`signed-out`、`signed-in` 或 `unavailable` 状态；登录态包含 CSRF 和到期时间。
- `POST /auth/login`：接受有上限的 JSON 用户名/密码，成功后建立服务端会话。
- `POST /auth/logout`：要求有效会话和 CSRF，撤销会话并清除 Cookie。
- `GET /healthz`：只暴露最小就绪状态，不泄露鉴权配置。

## Web 体验

应用启动先探测会话。鉴权关闭或会话有效时进入现有应用；未登录时显示中文登录页。页面覆盖加载、配置缺失、凭据错误、限流、会话过期和重试状态。进入应用后提供可键盘操作的退出入口；业务请求遇到 401 时刷新回登录门禁并显示过期提示。

## 部署与兼容

鉴权通过 `DSH_WEB_AUTH=required` 开启，用户名和哈希文件路径分别由 `DSH_WEB_ADMIN_USERNAME` 与 `DSH_WEB_ADMIN_PASSWORD_HASH_FILE` 提供。`0.0.0.0` 仅在鉴权要求开启且配置齐备时允许。默认仍为回环、鉴权关闭，因此现有本机 Web 与 Electron 行为保持兼容。

## 验证

先写服务端鉴权、连接层全链路门禁、客户端 401/CSRF、启动配置和登录 UI 的失败测试；随后运行聚焦 Vitest、主题样式校验、库构建、Web 构建，并在独立端口 3091 以真实 Chromium 验收登录失败/成功、刷新保持、退出、过期和未认证 API/WebSocket 拒绝。
