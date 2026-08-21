# trading-core Python backend

`dsh-trading-core` is the Python FastAPI backend for multi-agent stock analysis. It contains the engine, the adapter API, and its local runtime data; it does not install or start JavaScript tooling.

The host-side integration source now lives in [frontend/packages/investment-research/stock-analysis](../../frontend/packages/investment-research/stock-analysis). The backend API and SSE contract remain authoritative here in [docs/API-接口文档.md](docs/API-接口文档.md).

## Python setup and current local run

```sh
cd backend/dsh-trading-core
./init.sh
cp .env.example .env # then set DEEPSEEK_API_KEY for engine mode
./start.sh           # ADAPTER_RUNNER=engine by default
./start.sh fake       # deterministic local fake runner
./verify.sh
```

On Windows, use `init.bat`, `start_all.bat [fake|engine]`, and `verify.bat`. The wrappers start only `uvicorn adapter.app:app` on `127.0.0.1:8000`; `ADAPTER_RUNNER=fake|engine` can be supplied as an environment variable or the optional start argument. Logs are written to `logs/adapter.log`.

`stop_all.sh` and `stop_all.bat` are manual Python-backend wrappers for port `8000`. They do not implement the Phase 2 Runtime's owned-process rules.

## API

The service exposes analysis, holdings, market brief, watchlist, and risk-profile endpoints. Start with:

- [API interface document](docs/API-接口文档.md)
- [Frontend integration guide](docs/前端接入指南.md)
- [Risk-profile framework](docs/风险偏好分析框架.md)
- [Cross-environment operation](docs/跨环境运行.md)

## Product integration

`dsh electron --profile investment-research` is a **Phase 2 deliverable and is not enabled in the current phase**. When it is delivered, the product profile and its Runtime will be owned by the frontend workspace; this backend continues to expose its Python API without starting the product shell.
