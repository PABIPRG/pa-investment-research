# Web 管理员鉴权运维指南

[English](web-auth.md) | 中文

Web 管理员鉴权默认关闭，以保持现有回环开发体验。凡是把服务暴露到回环地址之外的部署，都必须启用鉴权并由 HTTPS 反向代理提供传输加密。

## 生成密码哈希

密码不会通过命令行参数传递。以下命令只把版本化 scrypt 哈希写入权限收紧的文件：

```bash
umask 077
read -r -s DSH_ADMIN_PASSWORD
printf '%s' "$DSH_ADMIN_PASSWORD" | dsh web-password-hash > /run/secrets/dsh-web-password.hash
unset DSH_ADMIN_PASSWORD
```

## 启动配置

```bash
export DSH_WEB_AUTH=required
export DSH_WEB_ADMIN_USERNAME=admin
export DSH_WEB_ADMIN_PASSWORD_HASH_FILE=/run/secrets/dsh-web-password.hash
dsh web --host 127.0.0.1 --port 3080
```

仅回环、仅本地开发且没有 HTTPS 时，可显式设置 `DSH_WEB_INSECURE_COOKIES=1`。该设置与 `--host 0.0.0.0` 组合会被拒绝。

对外部署时不设置 `DSH_WEB_INSECURE_COOKIES`，由 HTTPS 反向代理终止 TLS，并保留原始 `Host`。使用非 IP 域名时还需通过 `--trusted-host <authority>` 声明访问权威；未声明的 Host、跨站 Origin 和跨站 Fetch Metadata 会在鉴权之前被拒绝。

## 会话与轮换

- 会话 Cookie 是随机不透明值，带 `HttpOnly`、`SameSite=Strict`、`Path=/`，安全模式还带 `Secure`。
- 会话只在服务进程内保存，同时受空闲和绝对有效期约束；服务重启会注销所有浏览器。
- 所有写操作需要会话绑定的 CSRF 令牌；退出和过期会关闭该会话登记的 WebSocket。
- 轮换密码时先以同一命令生成新哈希并原子替换文件，再重启 Web 服务。新进程只接受新密码，旧会话随重启失效。

## 健康检查与后续部署契约

`GET /healthz` 只返回 `ok` 或 `not-ready`，不会暴露用户名、文件路径或会话信息。PAB-19 的进程托管可使用该端点判断就绪；鉴权配置缺失时必须把 503 当作不可就绪。PAB-20 的网络部署必须提供 HTTPS、保留 Host、配置可信 authority，且不能开启不安全 Cookie。

静态应用资源保持可加载，以便呈现登录页；`/api`、通用 RPC、会话导出和 WebSocket 业务通道均在服务端鉴权边界之后。
