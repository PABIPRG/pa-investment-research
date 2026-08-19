# market-watch 盘中盯盘 Agent

第二个后端模块（与 dsh-trading-core 平级），参考 [PanWatch（盯盘侠）](https://github.com/TNT-Likely/PanWatch) 的完整形态抽取为可直接用的 dsh 插件。

**定位**：dsh-trading-core 做盘前/盘后静态分析与指令式深度分析；本模块做**盘中实时盯盘**——条件触发告警、异动扫描、技术信号、新闻速递、LLM 触发解读与盘前/盘后简报、多渠道推送。

## 目录结构

```
market-watch/
├── market_watch/            # Python 包（uvicorn market_watch.app:app）
│   ├── config.py            # Settings 读模块根 .env（MW_ 前缀）
│   ├── store.py             # JsonStore 原子 JSON 持久化（data/）
│   ├── schemas.py           # Pydantic v2 请求模型
│   ├── llm.py               # OpenAI → DeepSeek 轻量调用
│   ├── quotes.py            # akshare 实时行情 + TTL 缓存 + 资金流 + K线 + 交易日历
│   ├── indicators.py        # MA/MACD/RSI/KDJ/BOLL/支撑压力/量价（纯 pandas）
│   ├── rules.py             # 规则 CRUD + 条件评估 + 板块涨跌停判定
│   ├── scanner.py           # 异动扫描（涨幅/量比/涨跌停/换手/成交额）
│   ├── news.py              # 财联社要闻 + 个股新闻 + LLM 摘要
│   ├── briefs.py            # 盘前/盘后 LLM 简报
│   ├── scheduler.py         # 4 类 job：盘中轮询/新闻速递/盘前简报/盘后日报
│   └── push/                # Server酱 / 企业微信机器人
├── dsh-plugin/              # 11 工具插件
├── init.bat / start_all.bat / stop_all.bat / verify.bat   # Windows
├── init.sh  / start.sh     / stop_all.sh  / verify.sh      # macOS / Linux
├── requirements.txt  .env.example  .gitignore  README.md
└── data/                    # 运行时数据（gitignored）
```

## 快速开始

```bash
# Windows
init.bat          # 建 venv + 装依赖 + 生成 .env（可传 mirror 用清华源）
start_all.bat     # 起适配器 :8100 + dsh Web UI :3081
verify.bat        # 健康检查 + 插件冒烟（11 工具）

# macOS / Linux
./init.sh
./start.sh
./verify.sh
```

> dsh 从 `%TEMP%\dsh-run-mw`（无 .env 目录）启动，避免当前目录 .env 干扰。
> trading-core 与 market-watch 的 dsh 可并存：trading-core 起在 3080、本模块 3081。

## 配置（.env，全部默认可用）

| 变量 | 默认 | 说明 |
|---|---|---|
| MW_LLM_ENABLED | false | 触发解读 / 新闻摘要 / 简报需要 LLM |
| DEEPSEEK_API_KEY | 空 | 与 trading-core 共用 |
| MW_PUSH_ENABLED | false | 触发告警 / 新闻速递 / 简报的外部推送总开关 |
| SERVERCHAN_SENDKEY / WECOM_WEBHOOK_KEY | 空 | 任一配好即可推 |
| MW_SCHEDULE_ENABLED | true | 定时 job 总开关（false 则只留手动 tick） |
| MW_POLL_INTERVAL | 30 | 盘中规则评估轮询秒数 |
| MW_NEWS_ENABLED | false | 新闻速递定时 |
| MW_PRE_BRIEF_ENABLED / MW_POST_BRIEF_ENABLED | false | 盘前 08:50 / 盘后 15:30 简报 |
| NO_PROXY | 见 example | **勿删 eastmoney.com**，否则 akshare 走代理断连 |

所有定时推送默认 OFF，.env 开启即可（同 trading-core BRIEF_* 模式）。

## 适配器端点（:8100，同步 JSON）

| 端点 | 说明 | 对应 dsh 工具 |
|---|---|---|
| POST /watchlist/add · /watchlist/remove · GET /watchlist | 独立自选管理 | watch_add / watch_remove / watch_list |
| POST /alerts · GET /alerts · DELETE /alerts/{id} | 盯盘规则 CRUD | add_alert / list_alerts / remove_alert |
| POST /scan | 异动扫描 | scan_movers |
| GET /overview | 盯盘面板（实时状态 + 命中/逼近规则 + 主力净流入） | watch_overview |
| POST /tech-signal | 单股技术信号 | tech_signal |
| POST /news/express · GET /news/latest | 新闻速递（LLM 摘要） | news_express |
| POST /brief/generate · GET /brief/latest | 盘前/盘后 LLM 简报 | daily_brief |
| GET /health · GET /scheduler/status · POST /scheduler/tick | 运维 | — |

### 规则模型

```json
{
  "name": "放量大涨", "ticker": null, "enabled": true,
  "time_frame": "trading", "combine": "or",
  "conditions": [{"field": "pct_change", "operator": ">=", "value": 5}],
  "cooldown_min": 0, "daily_cap": 0
}
```

- `field` ∈ `price` / `pct_change`(%) / `volume_ratio` / `amount`(亿元) / `turnover`(%)
- `ticker` 空 = 全部自选生效；指定 = 盯单只（不必在自选）
- 触发 → 冷却/日限检查 → LLM 解读（可选）→ Server酱/企微推送

## 调度

| job | 触发 | 守卫 |
|---|---|---|
| 盘中轮询 | IntervalTrigger(30s) | 交易时段 + 交易日 |
| 新闻速递 | IntervalTrigger(MW_NEWS_INTERVAL_MIN) | 交易日 + 时段 |
| 盘前简报 | CronTrigger(08:50) | 交易日 |
| 盘后日报 | CronTrigger(15:30) | 交易日 |

`POST /scheduler/tick` 手动评估一轮（绕过时段守卫，供夜间测试；冷却/日限照常生效）。

## 验证闭环

1. `curl :8100/health`；`POST /watchlist/add {code:"600519"}`
2. `POST /alerts {name:"涨超5%", conditions:[{field:"pct_change",operator:">=",value:5}]}`
3. `POST /scan {kind:"limit"}` 挑涨停股加自选 → `POST /scheduler/tick` 看 `triggered`
4. 配 LLM：`MW_LLM_ENABLED=true` → 再 tick，推送含解读段
5. `POST /news/express` → `GET /news/latest`；`POST /brief/generate {period:"post"}`

## 已知问题 / 限流

- **东财 push2 限流**：实时快照是整市分页拉取（55+ 请求/次）。短时间内密集调用会被东财 WAF 封 IP（`RemoteDisconnected`），连 curl 也连不上，通常数十分钟后自动解封。缓解：
  - 保持 `MW_QUOTE_CACHE_TTL>=60`（默认已 60），避免高频重复拉整市。
  - 本模块已内置**新浪快照 fallback**（缺量比/换手率，其余字段可用），东财被限时自动切换；K 线走 baostock fallback。
  - 被封期间行情端点返回空/降级数据，非崩溃；解封后自动恢复。
- **eastmoney TLS 指纹**：部分网络下 Python requests 的 TLS ClientHello 被东财 WAF 直接断开（curl 却通）。若解封后仍复现，可用 `curl_cffi`（impersonate 浏览器指纹）作为 HTTP 层。

## 关键坑

- **成交额单位是元**（显示亿需 /1e8）；涨跌幅/换手率是百分数数值（5.32=+5.32%）
- akshare 全延迟 import，config.py 在一切数据调用前加载 NO_PROXY
- baostock 全局 socket 非线程安全，全程持 `_bs_lock`
- Windows 需 `tzdata`（zoneinfo）
- store 落在 `market-watch/data/`（不带 /adapter，避免与 trading-core 撞车）
