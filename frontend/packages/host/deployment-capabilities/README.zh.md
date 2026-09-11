# @deepseek-ai/dsh-host-deployment-capabilities

[English](README.md) | 中文

由 Host 持有的部署形态分类与能力投影。插件根据显式 `surface` 配置（`cli`、`local-web`、`electron` 或 `cloud-web`）及 Host 平台，提供一份不可变的 `ctx.deploymentCapabilities` 快照。消费方读取该快照，而不再根据浏览器全局变量、监听地址或操作系统字符串猜测权限。

快照描述浏览器文件传输、Host 目录浏览、原生路径打开、券商同步、原生持仓访问，以及允许的持仓数据源名单。`cloud-web` 允许浏览器文件传输，但拒绝全部 Host 路径与本地券商能力；`electron` 启用完整本机桌面能力；`local-web` 保留浏览器传输与 Host 目录访问；`cli` 不提供浏览器传输。

详见[部署支持矩阵](../../../docs/deployment-capabilities.md)与[实现 Agent Note](../../../.agents/notes/implemented/architecture/2026-09-11-deployment-capabilities-and-web-file-transfer.md)。

## 模型体验

### 部署策略

#### 模型看到的内容

无。`ctx.deploymentCapabilities` 只控制 Host 与 Client 产品能力，不贡献提示词、消息或工具 schema。

#### Token 影响

不会向模型请求增加 token。

#### KV Cache 影响

模型请求内容不会变化，因此本包不会影响提示词缓存。

## 已知限制与暂缓事项

- 部署形态是进程级配置，组合完成后保持不变；目前有意不支持按用户或按会话协商能力。
- 容器沙箱以及健康／就绪行为由部署层负责，并在另一工作项中跟踪，不属于本能力声明。
