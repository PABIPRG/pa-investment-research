# -*- coding: utf-8 -*-
"""联网验收用的实体样本。

样本只选已导入实体库或可公开检索的代码，用于逐个实体类型验证工具链路；
不代表任何投资建议，也不是测试断言数据。
"""

from __future__ import annotations

ENTITY_SAMPLES: dict[str, dict] = {
    "ENTITY_01_01": {"entity_id": "SEC:CN:A:600519", "params": {"code": "600519"}},
    "ENTITY_01_02": {"entity_id": "FUND:510300", "params": {"code": "510300"}},
    "ENTITY_01_03": {"entity_id": "INDEX:000300", "params": {"code": "000300"}},
    "ENTITY_01_04": {"entity_id": "BOND:127119", "params": {"code": "127119"}},
    "ENTITY_02_01": {"entity_id": "CO:CN:A:600519", "params": {"code": "600519"}},
    "ENTITY_02_02": {"entity_id": None, "params": {"code": "600519"}},
    "ENTITY_02_03": {"entity_id": None, "params": {"code": "600519"}},
    "ENTITY_03_01": {"entity_id": "IND:CN:白酒Ⅱ", "params": {}},
    "ENTITY_03_02": {"entity_id": "THEME:SOLID_STATE_BATTERY", "params": {}},
    "ENTITY_03_03": {"entity_id": "CHAIN:CATHODE_MATERIAL", "params": {}},
    "ENTITY_04_01": {"entity_id": "TREND:AI_COMPUTE_DEMAND", "params": {}},
    "ENTITY_04_02": {
        "entity_id": "POLICY:NEW_ENERGY_SUBSIDY",
        "params": {"keyword": "新能源", "days": 3},
    },
    "ENTITY_04_03": {"entity_id": None, "params": {"code": "600519"}},
    "ENTITY_04_04": {"entity_id": None, "params": {"keyword": "降息", "days": 3}},
    "ENTITY_05_01": {"entity_id": "SEC:CN:A:600519", "params": {"code": "600519"}},
    "ENTITY_05_02": {"entity_id": "STYLE:HIGH_DIVIDEND", "params": {}},
    "ENTITY_05_03": {"entity_id": "INDEX:000300", "params": {"code": "000300"}},
    "ENTITY_06_01": {"entity_id": "MACRO:CPI", "params": {}},
    "ENTITY_06_02": {"entity_id": "COMMODITY:GOLD", "params": {}},
    "ENTITY_06_03": {"entity_id": "REGION:HAINAN_FTP", "params": {"keyword": "海南", "days": 3}},
}
