# -*- coding: utf-8 -*-
"""Hook 目录（V1.3 §5.6.1 / §5.6.2）。

目录只描述“谁产生、核心做什么、什么情况下不该做”，是事件接入与联调的
单一清单；路由仍以委托版本的追踪依赖为准，不在目录里写业务状态。

``producer`` 为空表示尚未接入事件源：事件可以接收并按依赖路由，但产品上
不能声称该监测已经生效（V1.3：事件源未接入时要显示未启用的具体部分）。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class HookSpec:
    hook_type: str
    producer: str | None
    handling: str
    boundary: str
    priority: str

    def as_dict(self) -> dict:
        return {
            "hook_type": self.hook_type,
            "producer": self.producer,
            "active": self.producer is not None,
            "handling": self.handling,
            "boundary": self.boundary,
            "priority": self.priority,
        }


HOOKS: tuple[HookSpec, ...] = (
    HookSpec(
        "mandate.created",
        "research-partner",
        "baseline_review",
        "需要初始研究时登记任务；只登记日程的委托不跑研究",
        "P0",
    ),
    HookSpec(
        "mandate.revised",
        "research-partner",
        "recompile_dependencies",
        "只重算受影响依赖；仅改名称或备注不重跑",
        "P1",
    ),
    HookSpec(
        "mandate.review_requested",
        "research-partner",
        "event_review",
        "只做一次复核，不恢复持续跟进，也不扩大联系许可",
        "P1",
    ),
    HookSpec(
        "mandate.requirements_completed",
        "research-partner",
        "baseline_review",
        "校验最新版本具备执行条件后继续原任务",
        "P1",
    ),
    HookSpec(
        "mandate.resumed",
        "research-partner",
        "rescan_schedules",
        "按补偿规则决定是否复核，不重放全部历史事件",
        "P1",
    ),
    HookSpec(
        "schedule.due",
        "research-partner-scheduler",
        "due_reminder / scheduled_delivery / periodic_check",
        "直接提醒不跑研究；定时交付须产出成果；周期检查可静默",
        "P1",
    ),
    HookSpec(
        "company.event_available",
        "market-watch",
        "event_review",
        "只匹配相关公司与资料依赖，不依赖股票代码存在",
        "P0",
    ),
    HookSpec(
        "news.item_available",
        "market-watch",
        "event_review",
        "按实体/主题路由；语义不确定时先进候选复核",
        "P2",
    ),
    HookSpec(
        "industry.event_available",
        "market-watch",
        "event_review",
        "多来源转载合并关联并保留出处",
        "P2",
    ),
    HookSpec(
        "market.condition_changed",
        "market-watch",
        "event_review",
        "只在进入目标状态、重要变化或到达复核周期时触发",
        "P2",
    ),
    HookSpec(
        "risk.condition_changed",
        "market-watch",
        "event_review",
        "未知与执行失败单独处理，不写成“风险已排除”",
        "P2",
    ),
    HookSpec(
        "investment.facts_revised",
        "trading-core-investment-records",
        "event_review",
        "按 feature_key 只复核依赖该事实的委托；固定范围不自动扩展",
        "P2",
    ),
    HookSpec(
        "strategy.condition_changed",
        "trading-core-evolution",
        "strategy_review",
        "只在升级/降级/淘汰/变异的阶段变化时触发；策略从待定到候选不算变化",
        "P2",
    ),
    HookSpec(
        "strategy.evolution_completed",
        "trading-core-evolution",
        "strategy_review",
        "每轮闭环完成才产生；只复核订阅了该策略或策略池的委托，不逐日推送结论",
        "P2",
    ),
    HookSpec(
        "evidence.revised",
        None,
        "event_review",
        "定位受影响判断；数据刷新成功本身不启动所有委托",
        "P2",
    ),
    HookSpec(
        "data.dependency_available",
        None,
        "resume_waiting_jobs",
        "唤醒等待该依赖的任务，不全量重跑",
        "P2",
    ),
    HookSpec(
        "entity.reference_changed",
        None,
        "revalidate_dependencies",
        "只重验依赖该身份的委托；合并保留原引用",
        "P3",
    ),
    HookSpec(
        "user.preference_revised",
        None,
        "revalidate_contact",
        "只重验联系资格；推测兴趣不触发偏好修订",
        "P3",
    ),
    HookSpec(
        "research.run_completed",
        "research-partner-worker",
        "contact_evaluation",
        "校验任务、版本与资格后保存结果，不再次创建同一研究",
        "P0",
    ),
    HookSpec(
        "research.run_failed",
        "research-partner-worker",
        "retry_or_waiting_data",
        "区分重试、等待资料与人工处理，不写成“没有变化”",
        "P0",
    ),
    HookSpec(
        "research.run_lease_expired",
        "research-partner-recovery",
        "requeue_bounded",
        "预算内重排；失去租约的结果只能留档",
        "P0",
    ),
    HookSpec(
        "notification.delivery_result",
        "notification-center",
        "contact_record_update",
        "只更新投递状态，不重跑研究、不重发已确认成功的消息",
        "P0",
    ),
    HookSpec(
        "runtime.recovered",
        "research-partner-recovery",
        "bounded_compensation",
        "按类型有界补偿，不全量重跑，不把陈旧行情当新机会",
        "P1",
    ),
)


def hook_catalog(*, active_only: bool = False) -> list[dict]:
    return [
        spec.as_dict()
        for spec in HOOKS
        if not active_only or spec.producer is not None
    ]


def known_hooks() -> set[str]:
    return {spec.hook_type for spec in HOOKS}
