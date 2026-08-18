# -*- coding: utf-8 -*-
"""QMTProvider：真券商持仓接入（miniQMT / xtquant）。

现状与门槛（docs/券商接入方案.md 有完整对比）：
  - QMT（迅投）是券商提供的量化交易终端，miniQMT/xtquant 是其 Python 接口
  - 开通需券商资产门槛（通常 10 万元），不同券商政策不同
  - 连接后通过 XtQuantTrader 拉取资金/持仓/委托，并可下单

本 Provider 只留结构占位，**未实现真实连接**：
  xtquant 依赖未安装、且需要券商开通的账号，直接调用会得到清晰报错，
  而不是静默失败。实现路径见 docs/券商接入方案.md §QMT。
"""

from ..schemas import HoldingItem
from .base import HoldingsProvider, ProviderUnavailable


class QMTProvider(HoldingsProvider):
    name = "qmt"

    def __init__(self):
        try:
            import xtquant  # noqa: F401

            self._imported = True
        except ImportError:
            self._imported = False

    def is_available(self) -> bool:
        # 未接入真实券商，恒为不可用
        return False

    def get_holdings(self) -> list[HoldingItem]:
        raise ProviderUnavailable(
            "QMT(xtquant)接入未启用：需要券商开通 miniQMT（通常 10 万资产门槛）。"
            "实现路径见 docs/券商接入方案.md §QMT。当前请用 manual 手动录入持仓。"
        )

    # TODO(3b): 实现路径参考
    #   from xtquant import xttrader, xtconstant
    #   session = XtQuantTrader(path, session_id)
    #   session.start(); session.connect()
    #   session.query_stock_asset(account)   # 资金
    #   session.query_stock_positions(account)  # 持仓
    #   需券商开通 miniQMT + 提供 account id
