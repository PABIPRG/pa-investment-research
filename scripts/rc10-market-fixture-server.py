#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从隔离 demo state 读取事件，按真实 market-watch HTTP 合同提供 UAT 服务。"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware


def create_app(state_root: Path, failure_marker: Path) -> FastAPI:
    app = FastAPI(title="rc.10 market-watch fixture")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health():
        return {"ok": True, "service": "market-watch"}

    @app.get("/news/events")
    def events(limit: int = Query(default=30)):
        if failure_marker.exists():
            raise HTTPException(503, "rc.10 fixture market unavailable")
        document = json.loads(
            (state_root / "data" / "events.json").read_text(encoding="utf-8")
        )
        items = document.get("latest") or []
        # 故意返回完整上游结果，让 trading-core 的有界去重合同负责最多 50 条。
        return {
            "as_of": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "count": len(items),
            "items": items,
            "requested_limit": limit,
        }

    @app.get("/securities/search")
    def search(q: str, limit: int = 8):
        if q in ("600000", "浦发银行"):
            return {"items": [{"code": "600000", "name": "浦发银行"}], "count": 1}
        return {"items": [], "count": 0}

    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-root", required=True)
    parser.add_argument("--failure-marker", required=True)
    parser.add_argument("--port", type=int, default=8280)
    args = parser.parse_args()
    uvicorn.run(
        create_app(
            Path(args.state_root).expanduser().resolve(),
            Path(args.failure_marker).expanduser().resolve(),
        ),
        host="127.0.0.1",
        port=args.port,
    )


if __name__ == "__main__":
    main()
