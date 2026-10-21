# -*- coding: utf-8 -*-
"""研究委托核心的统一异常。

适配器必须把 sqlite3 等底层异常转换成这里的领域异常，
避免存储细节泄漏到命令层与 DSH 工具层。
"""

from __future__ import annotations


class ResearchPartnerError(Exception):
    """研究委托核心异常基类。"""


class StorageUnavailable(ResearchPartnerError):
    """业务库不可访问：文件打不开、锁超时、迁移失败。"""


class StorageCorruption(ResearchPartnerError):
    """业务库结构或内容损坏，需要修复。"""


class Conflict(ResearchPartnerError):
    """版本冲突或重复写入；调用方应重读后决定是否重试。"""


class NotFound(ResearchPartnerError):
    """对象不存在或不属于当前主体。"""


class InvalidRequest(ResearchPartnerError):
    """输入不满足领域约束。"""


class Unauthorized(ResearchPartnerError):
    """调用上下文缺少所需主体或能力。"""


class LeaseExpired(Conflict):
    """任务租约已过期或被他人持有，持旧租约者不能提交状态。"""
