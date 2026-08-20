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
- Market data: `POST /scan`, `GET /overview`, `POST /tech-signal`, `POST /news/express`.
- Briefs: `POST /brief/generate`, `GET /brief/latest`.

The service reads `MW_` settings from `.env`; optional scheduled jobs and outbound notifications remain disabled by default.

## Product integration

`dsh electron --profile investment-research` is a **Phase 2 deliverable and is not enabled in the current phase**. Its frontend-owned Runtime may later manage this API, but this backend does not start or stop that product process.
