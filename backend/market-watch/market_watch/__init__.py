# -*- coding: utf-8 -*-
"""盘中盯盘 Agent（market-watch）：条件触发 + 异动扫描 + 技术信号 + 新闻速递 + LLM 简报。

与 dsh-trading-core 平级的第二个后端模块，独立自选列表、独立 8100 端口。
启动：uvicorn market_watch.app:app --port 8100
"""

__version__ = "0.1.0"
