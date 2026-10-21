# -*- coding: utf-8 -*-
"""研究实体层的统一异常。

适配器必须把底层异常（sqlite3.OperationalError、requests 异常等）
转换成这里的领域异常，避免存储/网络细节泄漏到上层。
"""

from __future__ import annotations


class ResearchEntityError(Exception):
    """研究实体层异常基类。"""


class StorageUnavailable(ResearchEntityError):
    """实体库不可访问：文件打不开、锁超时、连接失败。"""


class StorageCorruption(ResearchEntityError):
    """实体库结构或内容损坏，需要迁移或修复。"""


class ConflictError(ResearchEntityError):
    """写入冲突，调用方应重读后重试。"""


class InvalidRecord(ResearchEntityError):
    """实体记录或输入不满足领域约束。"""


class SourceUnavailable(ResearchEntityError):
    """外部数据源暂不可用（网络、鉴权、限流）。"""


class InvalidSourceBatch(ResearchEntityError):
    """数据源返回的批次字段缺失、重复或不可信。"""


class ReportError(ResearchEntityError):
    """报告无法生成或未通过校验。"""
