# @deepseek-ai/dsh-investment-industry-chain

[English](README.md) | 中文

该 Host 插件向 [`ctx.investmentPythonRuntime`](../python-runtime/README.md) 注册 `industry-chain` Python 后端。它验证或启动服务、持有一个生命周期租约，并发布零工具且不依赖 LLM 的能力状态，让就绪页面能够准确呈现该后端。

公司、实体、五列链路、多层链路、统计、网络切片、数据状态和数据初始化请求继续通过 Runtime 的固定 Host allow-list。插件有意不注册模型工具，也不复制旧 backend 插件；模型侧产业上下文继续兼容现有 `investment_context` 工具，并传入 `domain: "industry"`。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `backendMode` | `managed` | `managed` 可以启动本地后端；`external` 只验证服务。 |
| `backendBaseUrl` | `http://127.0.0.1:8200` | 注册到 Runtime 的固定后端地址。 |
| `backendProjectDir` | — | 无法自动发现仓库时，显式指定绝对 `backend/industry-chain` 目录。 |

## 后端契约与生命周期

managed 定义使用仓库路径 `backend/industry-chain`、Uvicorn 模块 `industry_chain.app:app` 与 `/health`。健康响应必须同时包含 `ok: true` 和 `service: "industry-chain"`。

激活时依次注册定义、获取经过验证的租约，再发布 `{ backendId: "industry-chain", toolCount: 0, llm: "none" }`。释放时保持投研插件统一顺序：工具边界、能力、租约，最后注销后端定义。

## 数据初始化边界

服务健康与图谱数据是否就绪相互独立，启动时绝不下载种子数据。产品页面先读取 `industry-chain.data-status`；只有用户明确操作才会调用固定且不接收输入的 `industry-chain.data-bootstrap`。下载进度和错误由后端持有，并通过这两个固定 Runtime 操作呈现。

## 模型体验

该包只在 Host 注册后端，不会向模型请求增加 schema、提示词、自动上下文、消息或结果。现有 V2 助理上下文路径继续使用 `investment_context` 与 `domain: "industry"`。

#### KV 缓存影响

该包不改变模型请求前缀。

## 已知限制与延后工作

- **后端数据仍由 endpoint 持有**：图谱构建、持久化与查询行为继续位于 `backend/industry-chain`；本插件只持有 Host 注册与生命周期。
- 仓库之外的 managed 部署必须设置 `backendProjectDir`；缺少 Python 环境时会给出平台初始化命令并失败，不会自动安装。
