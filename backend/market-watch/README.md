# market-watch Python backend

`market-watch` is the Python FastAPI service for intraday watchlists, alerts, scans, news, briefs, and scheduled notifications. It is a Python-only backend and has no JavaScript dependency lifecycle.

The host-side integration source now lives in [frontend/packages/investment-research/market-watch](../../frontend/packages/investment-research/market-watch).

## Python setup and current local run

```sh
cd backend/market-watch
./init.sh
cp .env.example .env # configure optional LLM and push credentials as needed
./start.sh
./verify.sh
```

On Windows, use `init.bat`, `start_all.bat`, and `verify.bat`. These wrappers start only `uvicorn market_watch.app:app` on `127.0.0.1:8100`; logs are written to `logs/adapter.log`.

`stop_all.sh` and `stop_all.bat` are manual Python-backend wrappers for port `8100`. They do not replace the Phase 2 Runtime's owned-process rules.

## Service endpoints

- `GET /health` and `GET /scheduler/status` report service state.
- Watchlists: `POST /watchlist/add`, `POST /watchlist/remove`, `GET /watchlist`.
- Alerts: `POST /alerts`, `GET /alerts`, `DELETE /alerts/{id}`.
- Market data: `POST /scan`, `GET /overview`, `POST /tech-signal`, `GET /news/flash`, `POST /news/express`.
- Briefs: `POST /brief/generate`, `GET /brief/latest`.

## Scheduler, notifications, and configuration

The service reads `MW_` settings from `.env`. `MW_SCHEDULE_ENABLED` defaults to `true`: it enables the 30-second intraday polling job by default. Set `MW_SCHEDULE_ENABLED=false` to disable all scheduler jobs explicitly. Individual jobs remain opt-in where appropriate:

| Setting | Default | Effect |
| --- | --- | --- |
| `MW_LLM_ENABLED` | `false` | Enables LLM interpretations, news summaries, and briefs when `DEEPSEEK_API_KEY` is available. |
| `MW_PUSH_ENABLED` | `false` | Enables outbound Server酱 or WeCom notifications when the corresponding credential is present. `MW_PUSH_CHANNELS` is optional: leave it empty to enable every credentialed channel, or set it to restrict delivery to `serverchan` and/or `wecom`. |
| `MW_POLL_INTERVAL` | `30` | Intraday rule-evaluation interval in seconds. |
| `MW_NEWS_ENABLED` | `false` | Enables news job; `MW_NEWS_INTERVAL_MIN` defaults to `60`. |
| `MW_PRE_BRIEF_ENABLED` / `MW_POST_BRIEF_ENABLED` | `false` / `false` | Enables the 08:50 pre-market or 15:30 post-market brief respectively; times are configurable. |
| `MW_QUOTE_CACHE_TTL` | `60` | Whole-market snapshot cache duration in seconds. |
| `MW_FLASH_FIRST_PAINT_DEADLINE` / `MW_FLASH_FULL_DEADLINE` | `1.5` / `10` | Total wait budget for base first-paint news or the explicit full-source path. |
| `MW_FLASH_CACHE_TTL` / `MW_FLASH_STALE_TTL` | `15` / `300` | Fresh and stale-while-revalidate windows for flash news. |
| `MW_FLASH_SOURCE_TIMEOUT` / `MW_FLASH_SOURCE_WORKERS` | `2` / `8` | Per-source HTTP timeout and fixed source-worker capacity; refresh flights remain active until these workers settle. |
| `MW_KLINE_COLD_DEADLINE` | `2.5` | Maximum foreground wait for a cold K-line request; its single refresh continues in the background. |
| `MW_KLINE_CACHE_TTL` / `MW_KLINE_STALE_TTL` | `60` / `1800` | Fresh and stale-while-revalidate windows for K-line data. |
| `MW_KLINE_SOURCE_TIMEOUT` / `MW_KLINE_BAOSTOCK_TIMEOUT` | `2` / `2` | HTTP-provider timeout and isolated baostock child-process timeout. |
| `MW_KLINE_REFRESH_WORKERS` | `4` | Maximum admitted K-line refreshes; excess cold keys fail fast instead of entering an unbounded queue. |

The default `_poll_job()` only calls `in_trading_session()`: it skips weekends and non-trading hours, but does not use an exchange-holiday calendar to exclude a weekday market closure. `latest_trade_date()` must not be treated as proof that today is an exchange trading day. Set `MW_SCHEDULE_ENABLED=false` explicitly for a closure when polling must not run. `POST /scheduler/tick` runs one watch cycle manually while still applying cooldown and daily-cap rules.

## Market-data limits and units

The Eastmoney snapshot is paginated across the whole market (55+ requests). A short `MW_QUOTE_CACHE_TTL` can trigger push2 rate limiting, so keep the default 60 seconds unless the data-source cost is understood. When Eastmoney is rate limited or unavailable, the service falls back to Sina snapshots; Sina does not provide volume ratio or turnover, so those fields may be `null`.

Base `GET /news/flash` reads only Sina Finance and direct, timeout-bounded CLS within the first-paint deadline. Completed sources return as a partial result, while the same refresh flight continues until every bounded provider settles; an incomplete refresh never replaces a more complete stale cache. `enrich=1` explicitly selects all configured sources plus event extraction and may invoke the optional LLM. K-line retrieval uses Sina and Eastmoney plus a baostock fallback isolated in a killable child process. Per-code single-flight and bounded admission prevent an unavailable provider from creating an unbounded work queue; fresh or stale cache returns immediately, while an uncached foreground wait ends at `MW_KLINE_COLD_DEADLINE` and leaves an admitted background refresh running.

`amount` rule thresholds and scan filters use **亿元**. `pct_change` and `turnover` use percentage-number values (for example, `5.32` means +5.32%); `volume_ratio` is unitless. baostock uses a global socket and therefore runs in one short-lived child process per fallback, which the parent terminates after `MW_KLINE_BAOSTOCK_TIMEOUT`. Windows installations retain the `tzdata` requirement for `zoneinfo`.

The module-level configuration loads `.env` before akshare is used. Keep `eastmoney.com` and `push2.eastmoney.com` in `NO_PROXY`; routing them through a system proxy can break the direct market-data connection.

## Product integration

`dsh electron --profile investment-research` is a **Phase 2 deliverable and is not enabled in the current phase**. Its frontend-owned Runtime may later manage this API, but this backend does not start or stop that product process.
