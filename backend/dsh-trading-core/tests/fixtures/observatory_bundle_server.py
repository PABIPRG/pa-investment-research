"""本机 UAT：真实公开路由与计算，所有行情和账户数据均为虚构。"""
import asyncio
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from unittest.mock import patch

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse
from adapter import public_observatory as public
from adapter.portfolio_performance import record_holdings_snapshot
from adapter.store import JsonStore

os.environ['DSH_PUBLIC_OBSERVATORY_OPERATIONS_SINCE'] = ''
os.environ['DSH_PUBLIC_OBSERVATORY_RESEARCH_SINCE'] = '2026-09-01T00:00:00+08:00'
os.environ['DSH_PUBLIC_OBSERVATORY_SNAPSHOT_IDS'] = '[]'
temporary = tempfile.TemporaryDirectory(prefix='obs-f6a0-data-')
store = JsonStore(Path(temporary.name))
record_holdings_snapshot(store, [{'ticker': '600519', 'quantity': 2, 'cost_price': 10}], 'manual', datetime(2026, 9, 25, tzinfo=ZoneInfo('Asia/Shanghai')))
for i in range(25):
    store.set('reports', f'{i:032x}', {'task_type': 'stock', 'created_at': f'2026-09-28T10:00:{i:02d}+08:00', 'reports': {'body': 'PRIVATE_NEVER_PUBLIC'}})
state = {'mode': 'healthy', 'delay': 0, 'calls': [], 'requests': []}
dates = ['2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-09', '2026-10-12']
patch('adapter.brief_engine.cached_trade_dates', return_value=dates).start()
class Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 10, 13, 12, tzinfo=ZoneInfo('Asia/Shanghai'))
public.datetime = Clock

def prices(ticker, start, end):
    state['calls'].append([ticker, start, end])
    if state['mode'] == 'fail':
        raise RuntimeError('fixture failure')
    days = [] if state['mode'] == 'empty' else ['2026-09-25'] if state['mode'] == 'single' else ['2026-09-25', '2026-09-27', '2026-09-28', '2026-09-30', '2026-10-01', '2026-10-09', '2026-10-12']
    return [{'date': day, 'close': 10 + i, 'private': 'PRIVATE_NEVER_PUBLIC'} for i, day in enumerate(days) if start <= day <= end]

app = FastAPI()
public.register_public_observatory_routes(app, store_factory=lambda: store, price_loader=prices, quote_loader=lambda _: {'600519': {'name': '虚构证券超长中文名称验证', 'price': 99999}})
@app.middleware('http')
async def controls(request: Request, call_next):
    if request.url.path == '/__fixture':
        if request.method == 'POST':
            state.update(await request.json())
        return JSONResponse(state)
    state['requests'].append(str(request.url.path) + '?' + request.url.query)
    await asyncio.sleep(state['delay'])
    return await call_next(request)
class StripApi:
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope['type'] == 'http' and scope['path'].startswith('/api/'):
            scope = {**scope, 'path': scope['path'][4:], 'raw_path': scope['raw_path'][4:]}
        await self.app(scope, receive, send)
app.add_middleware(StripApi)
app.add_middleware(CORSMiddleware, allow_origins=[f'http://127.0.0.1:{sys.argv[2]}'], allow_methods=['GET'])
if __name__ == '__main__':
    import uvicorn
    try: uvicorn.run(app, host='127.0.0.1', port=int(sys.argv[1]), log_level='warning')
    finally: temporary.cleanup()
