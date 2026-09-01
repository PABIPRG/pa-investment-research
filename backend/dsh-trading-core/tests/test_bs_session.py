# -*- coding: utf-8 -*-
"""baostock 会话复用回归测试：避免高频 login/logout 触发服务端临时封禁。

运行（自 backend/dsh-trading-core）：
    ./env/Scripts/python.exe -m unittest tests.test_bs_session -v
依赖：adapter.holdings_runner（不碰真实网络，FakeBS/ mock 隔离）。
"""

import unittest
from unittest.mock import patch

import adapter.holdings_runner as h
from adapter.holdings_runner import HoldingDataError, _bs_ensure_session, _bs_hist


def _reset_session_state() -> None:
    h._bs_session_held = False
    h._bs_session_last_use = 0.0


class _FakeBS:
    """记录 login/logout 调用次数的假 baostock 模块。"""

    def __init__(self) -> None:
        self.logins = 0
        self.logouts = 0

    def login(self):
        self.logins += 1
        return type("R", (), {"error_code": "0", "error_msg": ""})()

    def logout(self):
        self.logouts += 1


class BsSessionReuseTests(unittest.TestCase):
    def setUp(self) -> None:
        _reset_session_state()

    def tearDown(self) -> None:
        _reset_session_state()

    def test_session_reused_within_idle_window(self):
        fake = _FakeBS()
        _bs_ensure_session(fake)
        _bs_ensure_session(fake)
        self.assertEqual(fake.logins, 1, "空闲窗口内复用，不应重复 login")
        self.assertEqual(fake.logouts, 0)

    def test_session_relogged_after_idle_expiry(self):
        fake = _FakeBS()
        _bs_ensure_session(fake)
        h._bs_session_last_use = 0.0  # 模拟超过空闲阈值
        _bs_ensure_session(fake)
        self.assertEqual(fake.logins, 2, "会话超时应重登")
        self.assertEqual(fake.logouts, 1, "重登前先断开旧会话")

    def test_bs_hist_selfheals_stale_session(self):
        """会话被其它封装 logout → _bs_hist 查询失败后重登一次自愈。"""
        calls = {"n": 0}

        def fake_query(bs, code, start, end, names):
            calls["n"] += 1
            if calls["n"] == 1:
                raise HoldingDataError("会话已失效")
            return [{"date": "2026-09-01", "close": 1.0}]

        with patch("adapter.holdings_runner._bs_ensure_session") as ensure, \
                patch("adapter.holdings_runner._bs_query", side_effect=fake_query):
            out = _bs_hist("sh.600519", "2026-01-01", "2026-09-01")

        self.assertEqual(out, [{"date": "2026-09-01", "close": 1.0}])
        self.assertEqual(calls["n"], 2)
        self.assertEqual(ensure.call_count, 2, "初次确保 + 失效后重登")

    def test_bs_hist_login_failure_propagates(self):
        with patch("adapter.holdings_runner._bs_ensure_session",
                   side_effect=HoldingDataError("baostock 登录失败: 黑名单用户")):
            with self.assertRaises(HoldingDataError):
                _bs_hist("sh.600519", "2026-01-01", "2026-09-01")


if __name__ == "__main__":
    unittest.main()
