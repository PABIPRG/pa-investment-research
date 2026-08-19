# -*- coding: utf-8 -*-
"""dsh-trading-core 适配器 HTTP 客户端（同步 + SSE）。

封装适配器（adapter/app.py）对外提供的全部 HTTP 接口，是本仓库引擎能力
对外的程序化入口。依赖仅 requests（已在 requirements.txt）。

接口文档：docs/adapter-http-api.md

快速上手
-------

    from adapter_client import TradingCoreClient, HoldingItem

    client = TradingCoreClient("http://127.0.0.1:8000")

    # 1) 健康检查
    assert client.health()["status"] == "ok"

    # 2) 风险偏好 / 自选
    client.set_risk_profile("balanced")
    client.set_watchlist(["600519", "000858", "300750"])

    # 3) 个股分析（一站式：启动 + 消费 SSE + 返回最终结果，阻塞）
    result = client.run_analysis(
        ticker="600519",
        risk_profile="balanced",
        on_stage=lambda msg: print(msg),   # 进度回调
        timeout=900,
    )
    print(result["signal"]["action"])       # 买入 / 卖出 / 持有
    print(result["reports"].get("fundamentals"))

    # 4) 持仓快速体检
    client.save_holdings([HoldingItem("600519", 100, 1500)], mode="deep")
    h = client.run_holdings_analysis(mode="quick", use_saved=True)
    print(h["signal"]["weighted_risk_score"])

    # 5) 市场简报（串行）
    b = client.run_brief(period="post_market", scope="all")
    print(b["signal"]["summary"])
    client.get_latest_brief()                # 事后回查
    client.mark_brief_pushed(b["signal"]["trade_date"])  # 标记已推送

低层用法（手动管理任务生命周期）
-------------------------------

    task_id = client.analyze_stock("600519")
    for ev in client.stream_task(task_id):
        if ev.type == "stage":   print("进度:", ev.message)
        elif ev.type == "result":final = ev.data
        elif ev.type == "done":  break
    # 或事后取：client.get_task_result(task_id)
"""

from .client import AdapterHttpError, AdapterTaskError, TradingCoreClient
from .models import (
    AnalyzeParams,
    BriefParams,
    HoldingItem,
    HoldingsParams,
    SseEvent,
    TaskStatus,
)

__all__ = [
    "TradingCoreClient",
    "AdapterHttpError",
    "AdapterTaskError",
    "HoldingItem",
    "AnalyzeParams",
    "HoldingsParams",
    "BriefParams",
    "TaskStatus",
    "SseEvent",
]

__version__ = "0.1.0"
