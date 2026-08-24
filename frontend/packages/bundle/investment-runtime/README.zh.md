# `@deepseek-ai/dsh-investment-runtime-bundle`

[English](README.md) | 中文

纯 patch profile bundle（组合包），以 `investment-python-runtime` 行插入 [`@deepseek-ai/dsh-investment-python-runtime`](../../investment-research/python-runtime/README.md)。它不拥有 backend 定义或业务工具；后续投研能力 bundle 注入该服务，注册自己的 backend 并获取经过验证的 lease（租约）。

该 bundle 必须放在每个投研能力 bundle 之前。缺少它时，这些插件对 `ctx.investmentPythonRuntime` 的依赖会保持 unresolved（未解析），profile activation（激活）会失败，而不是发布没有 backend 的工具。

## 模型体验

间接产生影响：获取所插入 runtime 的业务插件拥有自己的工具 schema 与结果。

#### KV 缓存影响

无直接影响；所插入的 runtime 不贡献请求内容。

## 已知限制与暂缓事项

- **顺序属于 profile 约定**：该 patch 不插入任何业务能力，缺少它的能力 bundle 无法激活。
