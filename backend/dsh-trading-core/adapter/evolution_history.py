"""进化动作分页。JSON 集合仍是唯一事实源，按文件版本缓存可重建的只读索引。"""
import base64
import copy
import hashlib
import json
import threading
from collections import OrderedDict
from .store import JsonStore


class HistoryCursorConflict(ValueError):
    """历史已变化，客户端必须显式重新加载。"""


_CACHE = OrderedDict()
_LOCK = threading.RLock()


def history(store: JsonStore | None = None, *, limit: int = 20, cursor: str | None = None) -> dict:
    if type(limit) is not int or not 1 <= limit <= 50:
        raise ValueError('每页动作数必须介于 1 与 50')
    offset, expected = 0, None
    if cursor:
        try:
            if len(cursor) > 512:
                raise ValueError()
            value = json.loads(base64.b64decode(cursor, altchars=b'-_', validate=True))
            expected, offset = value['revision'], value['offset']
            if not isinstance(expected, str) or len(expected) != 64 or type(offset) is not int or offset < 0:
                raise ValueError()
        except (ValueError, KeyError, TypeError) as exc:
            raise ValueError('历史分页游标无效') from exc
    store = store or JsonStore()
    path = store.base_dir.resolve() / 'evolution_previews.json'
    # 与现有提交/导入的事务锁共用，确保版本与读到的记录一致。
    with store.transaction(), _LOCK:
        try:
            stat = path.stat()
            signature = (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
        except FileNotFoundError:
            signature = ()
        revision = hashlib.sha256(repr((str(path), signature)).encode()).hexdigest()
        if expected is not None and expected != revision:
            raise HistoryCursorConflict('历史记录已更新，请刷新后继续查看')
        cached = _CACHE.get(str(path))
        if cached is None or cached[0] != revision:
            rounds = [(str(key), record) for key, record in store.all('evolution_previews').items()
                      if isinstance(record, dict) and record.get('preview_status') == 'applied']
            rounds.sort(key=lambda row: (str(row[1].get('applied_at') or ''), row[0]), reverse=True)
            rows = []
            for key, record in rounds:
                actions = record.get('actions') or []
                if not isinstance(actions, list):
                    continue
                for index, action in enumerate(actions):
                    if not isinstance(action, dict):
                        continue
                    rows.append({'action_id': hashlib.sha256(f'{key}:{index}'.encode()).hexdigest(),
                                 'round_id': key, 'applied_at': record.get('applied_at'),
                                 'action': action})
            _CACHE[str(path)] = (revision, rows)
            _CACHE.move_to_end(str(path))
            while len(_CACHE) > 4:
                _CACHE.popitem(last=False)
        rows = _CACHE[str(path)][1]
        if offset > len(rows):
            raise ValueError('历史分页游标超出范围')
        end = min(offset + limit, len(rows))
        next_cursor = None
        if end < len(rows):
            next_cursor = base64.urlsafe_b64encode(json.dumps({'revision': revision, 'offset': end}).encode()).decode()
        return {'items': copy.deepcopy(rows[offset:end]), 'next_cursor': next_cursor,
                'has_more': next_cursor is not None, 'total': len(rows)}
