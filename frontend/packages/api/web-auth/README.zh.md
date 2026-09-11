# @deepseek-ai/dsh-api-web-auth

[English](README.md) | 中文

为 Web 组合提供单管理员、进程内会话鉴权。包在 Host 侧注册 `/auth/session`、`/auth/login`、`/auth/logout` 与 `/healthz`，并向浏览器传输层提供统一授权、CSRF 校验和 WebSocket 生命周期管理能力。

管理员密码至少需要 12 个 Unicode 字符，并拒绝全空白或单一字符重复等明显弱口令；密码只从受保护的版本化 scrypt 哈希文件读取。服务启动时一次性加载并严格校验普通文件、大小、POSIX 权限与记录格式，不接受明文密码配置。会话令牌使用高熵随机值，服务端只保存摘要；Cookie 默认带有 `HttpOnly`、`SameSite=Strict`、`Path=/` 与 `Secure`。仅回环开发模式可以显式关闭 `Secure`，非回环绑定会拒绝该配置。

认证启用但用户名、哈希文件或哈希格式不可用时，服务保持 fail-closed：会话与业务 API 返回不可用状态，而健康检查返回未就绪。空闲或绝对超时、退出登录及插件卸载都会撤销会话并销毁关联 WebSocket。所有非安全方法必须携带与会话绑定的 CSRF 令牌；登录失败受有效客户端 IP 窗口限流保护，地址表有固定上限与主动过期清理。scrypt 校验异步运行且并发有界，超出容量的工作立即背压而不进入无界队列；其他来源的失败计数不会在核验正确凭据前锁死唯一管理员。

请求在进入本包路由前仍须通过共享 Host/Origin/套接字信任栅栏。非回环部署必须显式配置可信 HTTPS authority 与直连反向代理 IP；转发协议和客户端地址只接受可信代理提供的值。匿名客户端只能获得登录壳和最小状态，能力图、插件 bundle、RPC 与 WebSocket 均在会话边界之后，source map 不对外服务。完整部署方法、密码轮换与反向代理要求见 [`docs/web-auth.zh.md`](../../../docs/web-auth.zh.md)。

## Model Experience

### Web 传输鉴权

#### What the model sees

模型看不到 `webAuth` 的登录、会话、Cookie、CSRF 或限流状态；只有通过鉴权后的既有业务插件能够产生模型输入。

#### Token effect

零 token。本包在浏览器传输进入业务分发前运行，不写入系统提示、用户消息、工具定义或工具结果。

#### KV Cache effect

无直接影响；鉴权发生在浏览器请求进入业务分发之前，不改变模型上下文或缓存键。

## Known Limitations and Deferred Work

- 会话只保存在当前服务进程中；重启、滚动切换或多副本部署不会共享会话。
- 当前只支持一个静态管理员身份，不提供用户目录、角色或权限分级。
- TLS 由受信反向代理终止；本包不负责证书签发或 HTTPS 监听。
- 哈希文件在启动时读取，轮换后必须重启服务才能使新凭据生效并清除旧会话。
