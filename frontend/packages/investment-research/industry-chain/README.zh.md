# @deepseek-ai/dsh-investment-industry-chain

[English](README.md) | 中文

该函数插件持有 `industry-chain` backend 定义，并从 [`ctx.investmentPythonRuntime`](../python-runtime/README.md) 获取经过验证的 lease。公司、实体、五列链路、多层链路、统计和网络切片的浏览器安全读取由 Runtime 数据代理公开；本包只持有 backend 激活与清理。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `backendMode` | `managed` | `managed` 启动明确 connection-refused 的本地 backend；`external` 只验证服务。 |
| `backendBaseUrl` | `http://127.0.0.1:8200` | 注册到 Runtime 的 backend URL。 |
| `backendProjectDir` | — | 无法从源码自动发现时，显式指定绝对 `backend/industry-chain` 目录。 |

## 生命周期

激活时注册固定的 `backend/industry-chain` 项目、`industry_chain.app:app` 模块、`/health` 身份和平台初始化命令，然后获取一个 lease。清理时先释放 lease，再移除定义。该插件不注册模型工具或提示词区块。

## 模型体验

### 工具 schema 与结果

#### 模型可见内容

本包不会新增模型可见 schema 或结果。投研 UI 调用 Host 的固定浏览器数据操作，助理请求仍使用共享投研助理。

#### Token 影响

无直接 token 影响。

#### KV Cache 影响

无直接 KV Cache 影响。

## 已知限制与延后工作

- 仓库之外的 managed 部署必须设置 `backendProjectDir`；缺少 Python 环境时会给出平台初始化命令并失败，不会自动安装。
