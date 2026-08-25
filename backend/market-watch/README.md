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
- Security research: `GET /securities/search`, `POST /securities/detail`.
- Market data: `POST /scan`, `GET /overview`, `POST /tech-signal`, `POST /news/express`.
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

The default `_poll_job()` only calls `in_trading_session()`: it skips weekends and non-trading hours, but does not use an exchange-holiday calendar to exclude a weekday market closure. `latest_trade_date()` must not be treated as proof that today is an exchange trading day. Set `MW_SCHEDULE_ENABLED=false` explicitly for a closure when polling must not run. `POST /scheduler/tick` runs one watch cycle manually while still applying cooldown and daily-cap rules.

## Market-data limits and units

The Eastmoney snapshot is paginated across the whole market (55+ requests). A short `MW_QUOTE_CACHE_TTL` can trigger push2 rate limiting, so keep the default 60 seconds unless the data-source cost is understood. When Eastmoney is rate limited or unavailable, the service falls back to Sina snapshots; Sina does not provide volume ratio or turnover, so those fields may be `null`. K-line retrieval falls back from akshare to baostock.

`amount` rule thresholds and scan filters use **亿元**. `pct_change` and `turnover` use percentage-number values (for example, `5.32` means +5.32%); `volume_ratio` is unitless. baostock uses a global socket and is protected by an internal lock, so its calls are serialized. Windows installations retain the `tzdata` requirement for `zoneinfo`.

The module-level configuration loads `.env` before akshare is used. Keep `eastmoney.com` and `push2.eastmoney.com` in `NO_PROXY`; routing them through a system proxy can break the direct market-data connection.

## Product integration

`dsh electron --profile investment-research` is a **Phase 2 deliverable and is not enabled in the current phase**. Its frontend-owned Runtime may later manage this API, but this backend does not start or stop that product process.
