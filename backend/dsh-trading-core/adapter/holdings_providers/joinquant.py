# -*- coding: utf-8 -*-
"""JoinQuantProvider：聚宽（jqdatasdk）。

重要澄清（docs/券商接入方案.md）：
  聚宽 = 数据 + 研究 + 回测平台，**不提供真实券商持仓/下单**。
  jqdatasdk 只给行情/财务数据（需购买授权，约 ¥6999/年）。
  真实持仓与交易要走券商通道（QMT / 券商 API）。

因此本 Provider 只做两件事：
  1. 说明可用性判定（装了 jqdatasdk + 配了账号密码才算 available）
  2. 预留取数据入口（TODO: 拉历史行情供 L1 定量风险分析），
     真正的持仓解析需对接券商（见 qmt.py）。

若把 HOLDINGS_PROVIDER 设为 joinquant，本 Provider 会抛 ProviderUnavailable，
提示用户改用 manual（或接 QMT）。
"""

from ..schemas import HoldingItem
from .base import HoldingsProvider, ProviderUnavailable


class JoinQuantProvider(HoldingsProvider):
    name = "joinquant"

    def __init__(self):
        self._client = None
        # 凭证由 jqdatasdk 在用户侧保存（~/.jqdatasdkrc 或代码内 auth）
        # 这里不读取任何敏感文件，由用户自行在代码/环境配置
        try:
            import jqdatasdk  # noqa: F401

            self._imported = True
        except ImportError:
            self._imported = False

    def is_available(self) -> bool:
        # 即便装了 jqdatasdk，聚宽也出不了真实持仓，故恒为不可用
        return False

    def get_holdings(self) -> list[HoldingItem]:
        raise ProviderUnavailable(
            "聚宽(jqdatasdk)只提供行情/财务数据，不提供券商持仓。"
            "真实持仓请用 manual 手动录入，或接 QMT(xtquant，需 10 万门槛)。"
        )

    def fetch_quotes(self, codes: list[str], days: int = 120) -> dict:
        """TODO(3b): 拉历史行情供 L1 定量风险分析。

        需要先实现 jqdatasdk.auth(username, password) + is_available 判定，
        且用户购买聚宽授权。未实现前调用即抛错。
        """
        raise NotImplementedError("聚宽行情数据接入待用户购买授权后实现（见 docs/券商接入方案.md）")
