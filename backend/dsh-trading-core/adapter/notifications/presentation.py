"""Business copy shared by new events and historical inbox projections."""

import re
from typing import Any, Mapping


def holdings_source_label(value: Any) -> str:
    """Resolve provider identifiers without exposing unknown internal keys."""
    source = str(value or "")
    return {"mac_ths": "同花顺", "easytrader": "券商客户端", "qmt": "QMT 客户端",
            "manual": "手动维护"}.get(source, source if re.search(r"[\u4e00-\u9fff]", source) else "持仓数据源")


def holdings_issue_copy(payload: Mapping[str, Any]) -> dict[str, str]:
    """Explain the failed read, preserved holdings and an actionable recovery path."""
    source = holdings_source_label(payload.get("sourceName"))
    reason = payload.get("reasonCode")
    title, explanation, action = {
        "read_cancelled": ("持仓读取已取消", "本次读取已取消。", "如不再同步，无需处理；需要更新时，可前往持仓同步重新读取。"),
        "read_timeout": ("持仓读取超时", "未能在限定时间内完成读取。", f"请在{source}打开持仓页面，处理登录、验证码或弹窗后，再前往持仓同步重新读取。"),
        "client_not_running": ("请先打开交易客户端", "尚未运行，无法读取持仓。", f"请打开{source}并登录账户、进入持仓页面，再前往持仓同步重新检测。"),
        "accessibility_required": ("持仓读取需要辅助功能权限", "暂时没有读取权限。", "请前往持仓同步，按页面指引为读取程序授予辅助功能权限，再重新检测。"),
        "automation_required": ("持仓读取需要自动化权限", "暂时没有控制客户端的权限。", "请前往持仓同步，按页面指引授予自动化权限，再重新检测。"),
        "empty_result": ("未读取到持仓", "本次没有读取到可导入的持仓。", "请核对所选账户与持仓页面，再重新读取；空结果不会清空已有持仓。"),
        "preview_conflict": ("持仓预览需要重新获取", "预览后持仓发生了变化，本次未覆盖保存。", "请重新读取持仓，核对最新预览后再确认导入。"),
        "client_interaction_required": ("请先处理交易客户端提示", "需要你处理登录、验证码或客户端弹窗。", f"请先在{source}完成上述操作，再前往持仓同步重新读取。"),
        "read_failed": ("持仓读取未完成", "未能完成持仓读取。", f"请检查{source}是否已登录并打开持仓页面，再前往持仓同步重新检测。"),
        "unsupported_platform": ("当前环境不支持券商同步", "无法在当前环境自动读取。", "请在支持的桌面环境同步，或在持仓明细中使用导入持仓。"),
        "dependency_missing": ("持仓读取组件不可用", "缺少可用的读取组件。", "请前往持仓同步查看环境检测结果；也可在持仓明细中使用导入持仓。"),
    }.get(reason, ("持仓同步未完成", "未能完成本次同步。", "请前往持仓同步查看当前检测结果，再按页面指引处理；也可使用导入持仓。"))
    summary = f"{source}：{explanation}当前持仓保持不变。"
    return {"title": title, "summary": summary, "body": f"{summary}\n\n下一步：{action}",
            "severity": "information" if reason == "read_cancelled" else "action_required"}
