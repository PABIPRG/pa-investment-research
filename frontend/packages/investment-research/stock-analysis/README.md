# stock-analysis · DeepSeek Harness 插件

把 dsh-trading-core 多智能体股票分析引擎注册为 dsh 的 `analyze_stock` 工具。
对话中用户给出股票代码/名称（如「分析一下 600519」），LLM 调用本工具，
插件通过 HTTP + SSE 驱动 Python 适配器，把引擎的多智能体分析进度实时注入
模型上下文，最终把统一决策信号（Signal）与分步报告渲染为 Markdown 返回。

```
DeepSeek Harness (dsh)
  └─ stock-analysis 插件 (TypeScript, 本目录)
       ├─ startAnalysis()  POST  /analyze                      → task_id
       ├─ consumeSse()     GET   /analyze/{id}/stream  (SSE)   → stage*/result/done
       │    每个 stage 事件 → exec.agent.inject() 追加到模型上下文（进度可见）
       ├─ render.ts        Signal + 分步报告 → Markdown（结果卡 / 完整报告）
       └─ 目标 Python 适配器（adapter/，127.0.0.1:8000）
            └─ dsh-trading-core 引擎 propagate()  ThreadPoolExecutor + SSE
```

## 目录

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：注册 `analyze_stock` 工具（参数/输出 schema、present* 钩子） |
| `src/client.ts` | 适配器 HTTP + SSE 客户端（与 dsh 解耦，纯 Node 可独立测试） |
| `src/render.ts` | Signal → Markdown 渲染（决策卡 + 折叠报告，纯函数） |
| `test/plugin.e2e.ts` | 核心链路端到端验证（不依赖 dsh Web UI） |
| `cordis.yml` | dsh `--patch` 补丁清单（插入本插件） |

## 前置

- dsh 已安装（`npx @deepseek-ai/dsh`）且 Web UI 已在 `127.0.0.1:3080` 运行，
  Settings→Models 配置好 DeepSeek API Key。
- Python 适配器已在 8000 端口运行：
  ```bash
  cd dsh-trading-core
  ADAPTER_RUNNER=engine PYTHONIOENCODING=utf-8 PYTHONUTF8=1 \
    ./env/Scripts/python.exe -m uvicorn adapter.app:app --host 127.0.0.1 --port 8000
  ```
- 引擎的 `.env` 已配置 `DEEPSEEK_API_KEY`，且 `USE_MONGODB_STORAGE=false`。

## 加载到 dsh

```bash
npx @deepseek-ai/dsh web --patch \
  C:/Users/徐诗靖/Desktop/tradingagentCN/dsh-trading-core/dsh-plugin/cordis.yml
```

`cordis.yml` 会在 dsh 启动清单中插入本插件并注入 `adapterBaseUrl`。

> ⚠️ **Windows 路径坑**：cordis 的 loader 只接受 `file://` URL，不能用裸的
> `C:/Users/...`（会把 `C:` 当成 URL scheme 报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`）。
> `cordis.yml` 里的 `name` 已写成 `file:///C:/...`（中文用户名需 URL 编码）。
> 另外插件源码的相对导入必须带 `.ts` 后缀（`./client.ts`），因为 dsh 用原生
> Node ESM 加载，不带后缀会 `ERR_MODULE_NOT_FOUND`。

## 工具契约

`analyze_stock` 参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ticker` | string | ✅ | 股票代码（600519）或名称（贵州茅台） |
| `date` | string | | 分析日期 YYYY-MM-DD，默认最近交易日 |
| `research_depth` | enum | | quick/basic/standard/deep/full，默认 standard |
| `config_overrides` | json | | 会话级引擎配置覆盖（如 max_debate_rounds） |

输出（lossless JSON，渲染在 `output.render`/`presentationMeta`）：

```jsonc
{
  "signal": {              // 统一决策信号
    "action": "买入|持有|卖出",
    "target_price": 1560.0,
    "confidence": 0.7,
    "risk_score": 0.5,
    "reasoning": "…",
    "company_name": "贵州茅台"
  },
  "reports": { "market": "…", "fundamentals": "…", …, "risk": "…" },
  "performance_metrics": { "total_seconds": 271, "node_counts": {…} }
}
```

## 验证

```bash
# 快速链路（适配器需在 fake 模式或 engine 模式运行）
npx tsx test/plugin.e2e.ts
# 真引擎完整跑（约 4-5 分钟），SSE_TIMEOUT_MS 需放大
ADAPTER_URL=http://127.0.0.1:8000 SSE_TIMEOUT_MS=600000 npx tsx test/plugin.e2e.ts

npx tsc --noEmit   # 类型检查
```

## 已知约束

- **dsh 工具是请求/响应模型，没有 `stream.write`**：实时进度通过
  `exec.agent.inject()` 追加到模型上下文，用户可在对话轨迹中看到分析阶段，
  但不会边跑边流式渲染结果。
- SSE 事件由 sse-starlette 以 `\r\n\r\n` 分帧，`client.ts` 已统一归一化处理。
- 结果较长时 LLM 可能截断——插件返回完整 JSON，渲染交给 `output.render`。
