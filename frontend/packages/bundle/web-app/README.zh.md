# `@deepseek-ai/dsh-web-app`

[English](README.md) | 中文

dsh 浏览器表层组合包。[`cordis.patch.yml`](cordis.patch.yml) 叠加在 [`dsh-base`](../base/README.md) 之上：设置 coding persona，插入 Web 宿主行与浏览器插件名录，保持客户端插件重载链挂载，并挂载本包的 `web-runtime` 粘合插件。运行时解析已构建的前端 dist，只把显式配置的公共 authority 提供给浏览器信任栅栏，挂载 [`frontend-static`](../../host/frontend-static/README.md) 回退席位，注册模型可见的 Web 表层上下文与 `DSH_WEB_URL`，并在 Loader 结算后打印一个规范 URL。普通 `web-startup` 提供方解析 `--host`、`--port`、可重复的 `--trusted-host`、可重复的 `--trusted-proxy` 与 `--help`。默认仍只绑定回环；仅当已启用必需的管理员鉴权、至少一个可信 HTTPS authority、至少一个精确可信反向代理地址且保持安全 Cookie 时，才接受 `--host 0.0.0.0`。此时公告的地址是 `https://` 加第一个可信 authority，不再公告可直接访问的 LAN HTTP 地址。代理边界与凭据文件契约见 [`docs/web-auth.md`](../../../docs/web-auth.md)。

## 模型体验

### Harness 源码与 Web 表层上下文

#### 模型看到的内容

当 `surfaceContext` 为 true 时，`harness:source` 段落标明磁盘上的 Harness 实现，但不会声称它就是工作目录；全局段落 `app:web-surface`（顺序 −98）则向模型说明 GUI：规范的本地 URL、「this page」指代什么、更新约定（重载接收端始终开启；无刷新重载还需要 `pnpm run dev:web` watcher），以及不要启动替代服务器的指令。`DSH_WEB_URL` 还会连同描述出现在受管 bash 环境中，每次调用时从运行中的服务器解析。当它为 false 时，这两个段落和该变量都不会注册。

#### Token 影响

每个会话一行源码说明和一段提示词，外加两行受管环境变量；每个进程内保持恒定。

#### KV Cache 影响

该提示词段落位于系统提示词靠前位置，且在进程整个生命周期内稳定（端口是启动期事实），因此不会使跨轮次缓存失效。

## 已知限制与延期工作

- **前端 dist 必须已构建**：对 dist 的 `require.resolve` 在激活时明确报错并给出构建提示；没有从源码直接服务的回退路径。
- **TLS 在上游终止**：本组合只验证显式可信代理套接字提供的转发元数据；部署必须阻止客户端直接访问后端 HTTP 监听端口。
