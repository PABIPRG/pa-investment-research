# @deepseek-ai/dsh-client-ui-settings-investment-research

[English](README.md) | 中文

`investment-research` Profile 的投研就绪页面。浏览器插件在 `settings.section` 注册本地化的 `investment-research` 条目，只投影 `ctx.investmentResearchRuntimeClient` 提供的不含机密快照，展示每个 backend 的所有权、健康状态、已声明工具数、凭据状态、能力等级以及 Host 提供的 Runtime 日志提示。页面不向普通用户暴露工作区或对话存储等实现概念；现有 Runtime 持久化机制仍会自动管理本机数据。

页面从不读取、接收或暂存凭据值。缺少 `DEEPSEEK_API_KEY` 时只提供一个凭据操作：调用 `openSection('models')`，让设置面板保持打开并导航到现有 Models 页面。Key 变更后，页面通过 facade 提供显式的全应用重启操作。root-scoped 交互 store 呈现请求中、已接受、不可用和失败反馈；readiness 重新检查采用 single-flight，并独立呈现失败反馈。UI 不直接调用 Electron。

验收清单要求用户在对话中显式运行健康、读取、写入、股票 engine 与盯盘解读检查。页面不会自动调用 `analyze_stock` 或任何其他工具，因此付费操作始终来自用户的明确动作。

## 模型体验

### 投研就绪设置

#### 模型看到的内容

无。`InvestmentReadinessSnapshot` 只停留在浏览器呈现路径，该包不注册任何模型可见内容。验收清单文案只展示给用户，不会发送给模型。

#### Token 影响

模型输入与输出 token 均为零；该页面不会发起提供方请求。

#### KV Cache 影响

无；该页面既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **资源行在增量一中是源码交付事实**：当前 Host readiness DTO 尚不携带 Runtime 资源来源。bundled resolver 增量会把 `source-env-ready`／`bundled-ready`／`missing`／`invalid` 加入 Host 快照，并让此行改为读取该动态事实；浏览器不会从路径、平台或文件系统推断来源。
- **重启确认之后不显示操作进度**：已接受只表示 launcher 已接管 quiescent restart 请求；当前进程可能在后续 UI 状态能够渲染前退出。
