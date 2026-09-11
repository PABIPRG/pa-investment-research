# 投研智能体单镜像容器部署规格

## 目标

仓库提供一个可审计并按内容身份交付的 Linux x86_64 OCI 镜像，在同一容器内运行 Node Host、Web 前端和三个受 Host 管理的 Python 后端。运行时只暴露经过 Web 认证边界保护的入口，不暴露 Python 服务端口，并把全部持久状态写入单一 `$DSH_HOME` 卷。

## 运行契约

- 构建阶段使用锁定的 pnpm 依赖、已构建的 Web 产物、可迁移的 CLI 生产依赖闭包，以及经过 SHA-256 校验的 Python 3.10 Linux 运行时和精确依赖锁；运行阶段不安装或编译依赖。
- Python requirements 固定版本但未固定每个 wheel 的 hash，Debian apt 包也在构建时解析，因此不能宣称不同时间的构建逐字节可复现；交付身份以 CI 实际验证镜像的 commit 标签、OCI revision、镜像 ID、BuildKit 元数据和归档 SHA-256 为准。
- 容器以非 root 用户和只读根文件系统运行，只有 `$DSH_HOME`、`/tmp` 与 `/run/dsh` 可写。
- `DSH_WEB_AUTH=required`、管理员用户名、密码哈希 secret、受信 Host、受信代理、HTTPS 安全 Cookie、`TZ` 与 `TIMEZONE` 一致性在启动前失败关闭。
- 容器入口用 `$DSH_HOME/investment-research/.container-instance.lock` 的原子目录和共享卷心跳租约保证一个持久卷只有一个调度实例；只有持有随机 owner token 的进程可以续租和释放，异常退出的租约经过有界超时后才能被接管。
- `SIGTERM`、`SIGINT` 与 `SIGHUP` 转发给 CLI 子进程；宽限期结束后容器入口强制终止子进程并以非零状态退出。
- 健康检查同时验证 Web `/healthz` 和三个仅在容器回环地址监听的 Python `/health`，任一服务未就绪时容器保持 unhealthy。

## 交付边界

Pull Request CI 构建但不推送镜像，使用 Compose 启动同一 SHA 标签镜像完成健康检查、非 root、只读根文件系统和端口暴露断言，并上传可由 `docker load` 复用的镜像归档、归档 SHA-256、镜像 ID 与构建元数据。镜像仓库推送、生产部署、版本号、Git tag、GitHub Release、Kubernetes 和多容器拆分不在本项范围。

## 验收

静态与单元测试验证 Compose、Dockerfile、运行时锁、配置校验、单实例锁、健康聚合和信号收敛契约；PR CI 提供真实镜像构建和 Compose 启动证据。反向代理后的真实浏览器登录与完整三后端业务验收由 PAB-21 关闭。
