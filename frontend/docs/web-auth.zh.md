# Web 管理员鉴权运维指南

[English](web-auth.md) | 中文

Web 管理员鉴权默认关闭，以保持现有回环开发体验。凡是把服务暴露到回环地址之外的部署，都必须启用鉴权并由 HTTPS 反向代理提供传输加密。

## 生成密码哈希

密码不会通过命令行参数传递，且至少需要 12 个 Unicode 字符。以下命令只把版本化 scrypt 哈希写入权限收紧的文件：

```bash
umask 077
read -r -s DSH_ADMIN_PASSWORD
printf '%s' "$DSH_ADMIN_PASSWORD" | dsh web-password-hash > /run/secrets/dsh-web-password.hash
unset DSH_ADMIN_PASSWORD
```

服务启动时只接受不超过 4096 字节、格式有效的普通文件；POSIX 平台拒绝符号链接以及任何组/其他用户可读写执行的权限位，因此应保持 `0600`。校验失败只表现为登录服务未就绪，不会向客户端泄露路径、权限或哈希内容。

## 启动配置

```bash
export DSH_WEB_AUTH=required
export DSH_WEB_ADMIN_USERNAME=admin
export DSH_WEB_ADMIN_PASSWORD_HASH_FILE=/run/secrets/dsh-web-password.hash
dsh web --host 127.0.0.1 --port 3080
```

仅回环、仅本地开发且没有 HTTPS 时，可显式设置 `DSH_WEB_INSECURE_COOKIES=1`。该设置与 `--host 0.0.0.0` 组合会被拒绝。

对外部署时不设置 `DSH_WEB_INSECURE_COOKIES`，由 HTTPS 反向代理终止 TLS，并执行如下启动；`--trusted-host` 是浏览器实际访问的 HTTPS authority，`--trusted-proxy` 是与本进程建立 TCP 连接的代理 IP：

```bash
dsh web --host 0.0.0.0 --trusted-host research.example.com --trusted-proxy 127.0.0.1
```

非回环绑定缺少鉴权、可信 authority 或可信代理时会在监听前失败。服务只接受由显式可信直连代理提交的 `X-Forwarded-Proto: https`，并从右向左剥离 `X-Forwarded-For` 中已声明的可信代理跳点；来自其他套接字的转发头全部忽略。反向代理必须覆盖客户端提供的转发头，并通过防火墙或私网确保后端 HTTP 端口只能由这些代理访问。直接 HTTP 访问会得到“需要安全入口”，登录字段保持禁用，启动日志也只公告可信 HTTPS 地址，不公告可误用的 LAN HTTP 地址。

未声明的 Host、跨站 Origin 和跨站 Fetch Metadata 会在鉴权之前被拒绝。回环 Host 还必须对应真实的回环客户端套接字；远端请求即使伪造 `Host: 127.0.0.1` 也不会获得回环权限。

## 会话与轮换

- 会话 Cookie 是随机不透明值，带 `HttpOnly`、`SameSite=Strict`、`Path=/`，安全模式还带 `Secure`。
- 会话只在服务进程内保存，同时受空闲和绝对有效期约束；服务重启会注销所有浏览器。
- 所有 HTTP 写操作需要会话绑定的 CSRF 令牌；通用 RPC 与 WebSocket 在业务分发之前同样需要有效会话，退出和过期会关闭该会话登记的 WebSocket。
- 登录失败按可信代理边界解析出的有效客户端 IP 和进程全局窗口限流；地址表有固定上限并主动清理过期窗口，无法解析的代理链会 fail-closed。
- 轮换密码时先以同一命令生成新哈希并原子替换文件，再重启 Web 服务。新进程只接受新密码，旧会话随重启失效。

## 健康检查与后续部署契约

`GET /healthz` 只返回 `ok` 或 `not-ready`，不会暴露用户名、文件路径或会话信息。PAB-19 的进程托管可使用该端点判断就绪；鉴权配置缺失时必须把 503 当作不可就绪。PAB-20 的网络部署必须提供 HTTPS、保留 Host、配置可信 authority，且不能开启不安全 Cookie。

匿名可见信息仅限登录页 HTML/基础壳资源、`/auth/session` 的最小公开状态与不含部署细节的 `/healthz` 就绪状态。客户端能力图通过受保护的 `/auth/boot` 获取，插件 bundle 必须先通过会话授权，所有 source map 返回 404；`/api`、通用 RPC、会话导出和 WebSocket 业务通道均在服务端鉴权边界之后。
