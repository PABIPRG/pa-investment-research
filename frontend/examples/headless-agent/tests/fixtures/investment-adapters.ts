import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    investmentAdapters: true
  }
}

function json(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

function tradingAdapter(): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === '/health') {
      json(response, { service: 'trading-core', status: 'ok' })
      return
    }
    if (request.method === 'POST' && request.url === '/analyze') {
      json(response, { task_id: 'snapshot-stock' })
      return
    }
    if (request.url === '/analyze/snapshot-stock/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end([
        'event: stage\ndata: {"message":"正在分析 600519"}',
        'event: result\ndata: {"signal":{"ticker":"600519","company_name":"贵州茅台","action":"持有","target_price":1688,"confidence":0.8,"risk_score":0.2,"reasoning":"确定性快照"},"reports":{"market":"市场阶段 Markdown"},"performance_metrics":{"total_ms":1}}',
        'event: done\ndata: {}',
        '',
      ].join('\n\n'))
      return
    }
    json(response, { tickers: ['600519'] })
  })
}

function marketAdapter(): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === '/health') {
      json(response, { service: 'market-watch', ok: true })
      return
    }
    if (request.url === '/watchlist') {
      json(response, { items: [{ code: '000001', name: '平安银行' }], count: 1 })
      return
    }
    json(response, { ok: true })
  })
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => { resolve() }))
}

class SnapshotSubprocessRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }

  resolveExecutable(): Promise<string> {
    return Promise.reject(new Error('snapshot external runtime must not resolve executables'))
  }

  spawn(): never {
    throw new Error('snapshot external runtime must not spawn')
  }

  spawnTerminal(): Promise<never> {
    return Promise.reject(new Error('snapshot external runtime must not allocate terminals'))
  }
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const trading = tradingAdapter()
  const market = marketAdapter()
  const tradingPort = Number(process.env.DSH_INVESTMENT_TRADING_PORT)
  const marketPort = Number(process.env.DSH_INVESTMENT_MARKET_PORT)
  if (!Number.isInteger(tradingPort) || !Number.isInteger(marketPort)) {
    throw new Error('investment snapshot adapter ports are required')
  }
  await Promise.all([listen(trading, tradingPort), listen(market, marketPort)])
  const disposeService = ctx.provide('investmentAdapters', true)
  new SnapshotSubprocessRuntime(ctx)
  return async () => {
    disposeService()
    await Promise.all([close(trading), close(market)])
  }
}
