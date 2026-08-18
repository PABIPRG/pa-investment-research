# dsh-trading-core

把 TradingAgents-CN 的多智能体股票分析引擎，收敛成一个跑在 DeepSeek Harness (dsh) 里的可用插件。

> 本仓库只保留了真正用到的代码：引擎核心 `tradingagents/`（裁剪掉 Streamlit app、前端、Mongo/Redis 栈、docker 等上游附加物）+ 无状态 FastAPI 适配器 + dsh TypeScript 插件。衍生自 [TradingAgents-CN](https://github.com/hsliuping/TradingAgents-CN)，Apache-2.0，详见 [LICENSE](LICENSE)。

## 功能

在 dsh 对话里可以直接用的 **9 个工具**：

| 工具 | 作用 |
|---|---|
| `analyze_stock` | 个股多智能体分析：基本面/技术面/新闻/情绪/风险辩论 → 统一买卖决策 |
| `analyze_holdings` | 持仓组合风险分析：波动率、集中度 HHI、单股权重、β 对照风险预算，给调仓建议 |
| `market_brief` | 市场简报：北向资金、板块异动、龙虎榜、涨停、风险提示等机会点 |
| `set_watchlist` / `get_watchlist` | 自选列表读写 |
| `set_holdings` | 手动上传/保存持仓 |
| `get_latest_brief` | 取最近一次简报 |
| `set_risk_profile` / `get_risk_profile` | 风险偏好读写（保守/稳健/进取） |

特色：
- **风险偏好驱动分析框架**：同一只股票，保守型→「持有」，进取型→「分批建仓」；持仓预算、简报机会点分级随画像变化。详见 [docs/风险偏好分析框架.md](docs/风险偏好分析框架.md)。
- **SSE 实时进度**：引擎各阶段（基本面→技术面→新闻→情绪→风险辩论→决策）实时注入模型上下文，跑分析时能看到进度。
- **市场简报推送**（可选）：适配器常驻定时生成简报，支持 Server酱 / 企业微信推送。

## 架构

```
DeepSeek Harness (dsh)
  └─ dsh-plugin/            TypeScript 插件（本仓库）
       ├─ startAnalysis()  POST /analyze                → task_id
       ├─ consumeSse()     GET  /analyze/{id}/stream    → 阶段进度
       │    每个 stage → exec.agent.inject() 追加模型上下文（可见进度）
       └─ render.ts         Signal + 分步报告 → Markdown
            │
            ▼  HTTP / SSE（127.0.0.1:8000）
adapter/                  FastAPI 无状态服务（本仓库）
  ├─ TaskManager → ThreadPoolExecutor → SSE 流
  ├─ engine_bridge：config 注入（风险偏好 → DeepSeek）
  ├─ holdings_runner / brief_engine：持仓风险预算、简报机会点
  └─ JsonStore：watchlist / holdings / 偏好持久化（data/adapter/*.json）
            │
            ▼  TradingAgentsGraph.propagate()
tradingagents/            TradingAgents-CN 引擎核心（裁剪后）
```

## 快速开始

### 1. 准备环境

```bash
cd dsh-trading-core
python -m venv env
env/Scripts/python.exe -m pip install -r requirements.txt   # Windows
```

### 2. 配置

```bash
cp .env.example .env      # 填 DEEPSEEK_API_KEY 等
# 或直接沿用旧配置：把可用 .env 拷进来（适配器只读其中一部分，见下表）
```

关键配置（完整模板见 [.env.example](.env.example)）：

| 键 | 说明 | 默认 |
|---|---|---|
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` | LLM 密钥与端点 | `https://api.deepseek.com` |
| `RISK_PROFILE` | 全局默认风险偏好 | `balanced` |
| `DEFAULT_CHINA_DATA_SOURCE` | A 股数据源 | `akshare` |
| `HOLDINGS_PROVIDER` | 持仓数据源（manual/joinquant/qmt） | `manual` |
| `USE_MONGODB_STORAGE` | 保持 `false`（本插件用 JSON 文件存储） | `false` |
| `TA_CACHE_STRATEGY` | 缓存策略（`file` 即可） | `file` |
| `NO_PROXY` | 国内行情站直连白名单（东财/新浪等） | 见模板 |
| `BRIEF_*` | 简报推送/定时（可选） | 关 |

### 3. 启动

```bat
start_all.bat
```

或手动：

```bash
# 终端 1：适配器（engine 模式）
env/Scripts/python.exe -m uvicorn adapter.app:app --host 127.0.0.1 --port 8000 --log-level warning

# 终端 2：dsh Web UI（--patch 加载插件）
npx @deepseek-ai/dsh web --patch dsh-plugin/cordis.yml
```

在 dsh Settings→Models 配置 DeepSeek API Key 后，对话里直接说「**分析一下 600519**」即可。

> Windows 提示：dsh 的 cordis loader 只接受 `file://` URL，`cordis.yml` 里已写好（中文用户名需 URL 编码）；插件源码相对导入带 `.ts` 后缀。

## 工具与参数

`analyze_stock`：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ticker` | string | ✅ | 股票代码（600519）或名称（贵州茅台） |
| `date` | string | | 分析日期 `YYYY-MM-DD`，默认最近交易日 |
| `research_depth` | enum | | `quick/basic/standard/deep/full`，默认 `standard` |
| `risk_profile` | enum | | `conservative/balanced/aggressive`，覆盖全局偏好 |
| `config_overrides` | json | | 会话级引擎配置覆盖（如 `max_debate_rounds`） |

`analyze_holdings` 与 `market_brief` 也接受 `risk_profile`。优先级：**调用参数 > 已保存偏好 > .env > balanced**。

## 适配器 HTTP API（adapter/，无状态）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/analyze` | 个股分析 → `{task_id}`；SSE 于 `/analyze/{id}/stream`（`started/progress/done/error`） |
| POST | `/holdings/analyze` | 持仓风险分析（quick/deep） |
| POST | `/holdings/save` | 保存持仓 |
| GET/POST | `/watchlist` | 自选读写 |
| GET/POST | `/risk_profile` | 风险偏好读写 |
| POST | `/brief` | 生成市场简报 |
| GET | `/brief/latest` | 最近简报 |
| GET | `/health` | 健康检查 |

## 项目结构

```
dsh-trading-core/
├── adapter/            # FastAPI 无状态服务（引擎桥接 / 持仓 / 简报 / 推送 / 存储）
├── tradingagents/      # 引擎核心（只保留运行时可达的模块，见依赖分析）
├── dsh-plugin/         # dsh TypeScript 插件（9 工具 + SSE 客户端 + Markdown 渲染）
├── config/             # 引擎配置（models / pricing / logging / settings）
├── docs/               # 风险偏好框架说明、集成设计参考
├── env/                # Python 虚拟环境（gitignore）
├── data/  logs/        # 运行时数据与日志（gitignore）
├── start_all.bat       # 一键启动适配器 + dsh Web UI
└── requirements.txt / .env.example / .env
```

## 验证

```bash
# 插件加载冒烟（9 工具）与类型检查
cd dsh-plugin && npm install && npx tsc --noEmit && npx tsx test/plugin-load.smoke.ts

# 端到端（适配器需 engine 模式运行；引擎单股约 3-9 分钟，超时给足）
ADAPTER_URL=http://127.0.0.1:8000 SSE_TIMEOUT_MS=900000 npx tsx test/plugin.e2e.ts
```

> 注意：`/brief` 请**串行**跑（akshare 的 py_mini_racer V8 并发会崩适配器）。

## 开源说明

- 引擎核心 `tradingagents/` 衍生于 [TradingAgents-CN](https://github.com/hsliuping/TradingAgents-CN)，保留其 Apache-2.0 [LICENSE](LICENSE)。
- 本仓库不包含上游 `app/`、`frontend/` 等代码；商用请遵守 TradingAgents-CN 授权条款。
- 密钥只存在于本地 `.env`（已被 gitignore），不入库、不进 wire。
