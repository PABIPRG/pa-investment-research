// 插件核心链路验证（不依赖 dsh Web UI）：
//   startAnalysis → consumeSse(SSE 进度) → injectProgress → renderFullReport
//   set_watchlist / get_watchlist / get_latest_brief（轻量 HTTP）
//   可选：market_brief（RUN_BRIEF=1）/ analyze_holdings quick（RUN_HOLDINGS=1）
// 用法：ADAPTER_URL=http://127.0.0.1:8000 pnpm exec vitest run --config vitest.e2e.config.ts \
//   packages/investment-research/stock-analysis/tests/adapter.e2e.ts
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import {
  consumeSse,
  getLatestBrief,
  getRiskProfile,
  getWatchlist,
  setRiskProfile,
  setWatchlist,
  startAnalysis,
  startTask,
} from '../src/client.ts'
import {
  renderBrief,
  renderBriefCard,
  renderFullReport,
  renderHoldingsCard,
  renderHoldingsReport,
  renderSignalCard,
  type AnalyzeResult,
  type BriefSignal,
  type HoldingsSignal,
} from '../src/render.ts'

const adapterUrl = process.env.ADAPTER_URL
const ticker = process.env.TICKER ?? '600519'
const timeoutMs = Number(process.env.SSE_TIMEOUT_MS ?? 60_000)
const runBrief = process.env.RUN_BRIEF === '1'
const runHoldings = process.env.RUN_HOLDINGS === '1'
const enabledSseFlowCount = 1 + (runBrief ? 1 : 0) + (runHoldings ? 1 : 0)
const HTTP_AND_CLEANUP_GRACE_MS = 30_000
// Vitest needs one total budget for all enabled workflows. Each consumeSse call
// keeps timeoutMs as its independent per-stream deadline.
const e2eTotalTimeoutMs = enabledSseFlowCount * timeoutMs + HTTP_AND_CLEANUP_GRACE_MS

describe.skipIf(!adapterUrl)('stock-analysis adapter e2e', () => {
  it('verifies all six adapter workflows', async () => {
    if (!adapterUrl) throw new Error('ADAPTER_URL is required for this real-adapter test')

    const injected: string[] = []
    const sink = {
      signal: new AbortController().signal,
      agent: {
        inject(message: UserMessage) {
          for (const block of message.content ?? []) {
            if (block.type === 'text') injected.push(block.text)
          }
        },
      },
    }

    console.log(`== 插件核心链路验证 适配器=${adapterUrl} ticker=${ticker} ==`)

    // ── 1) analyze_stock：SSE 全链路 ─────────────────────────────────
    const taskId = await startAnalysis(adapterUrl, { ticker, research_depth: 'standard' }, sink.signal)
    console.log(`✅ POST /analyze → task_id=${taskId}`)

    const result = (await consumeSse(
      `${adapterUrl}/analyze/${taskId}/stream`,
      sink,
      timeoutMs,
    )) as AnalyzeResult

    console.log(`✅ SSE 消费完成；注入模型上下文的进度条数=${injected.length}`)
    console.log('   进度示例:', injected[0], '…')
    console.log(`✅ signal.action=${result.signal.action} company=${result.signal.company_name}`)
    console.log(`✅ reports 键=${Object.keys(result.reports ?? {}).join(',')}`)

    console.log('\n===== renderSignalCard（UI 结果卡）=====')
    console.log(renderSignalCard(result.signal))
    console.log('\n===== renderFullReport 开头（模型侧完整 Markdown）=====')
    console.log(renderFullReport(result).split('\n').slice(0, 30).join('\n'))

    expect(injected.length).toBeGreaterThan(0)
    expect(result.signal.action).toBeTruthy()
    expect(Object.keys(result.reports ?? {}).length).toBeGreaterThan(0)

    // ── 2) set_watchlist / get_watchlist ─────────────────────────────
    console.log('\n── 自选列表工具 ──')
    const saved = (await setWatchlist(adapterUrl, ['600519', '000858', '300750'], sink.signal)) as {
      saved?: number
    }
    console.log(`✅ POST /watchlist → saved=${saved.saved}`)
    const watchlist = (await getWatchlist(adapterUrl, sink.signal)) as { tickers?: string[] }
    console.log(`✅ GET /watchlist → tickers=${JSON.stringify(watchlist.tickers)}`)
    expect(saved.saved).toBe(3)
    expect(watchlist.tickers).toContain('600519')

    // ── 3) get_latest_brief ──────────────────────────────────────────
    console.log('\n── 最近简报工具 ──')
    const brief = (await getLatestBrief(adapterUrl, sink.signal)) as {
      id?: string
      period?: string
      trade_date?: string
      dsh_pushed?: boolean
    }
    console.log(`✅ GET /brief/latest → id=${brief.id ?? '（暂无）'} dsh_pushed=${brief.dsh_pushed}`)
    if (brief.id) {
      console.log('\n===== renderBriefCard（简报卡）=====')
      console.log(renderBriefCard(brief))
    }

    // ── 4) market_brief（可选，RUN_BRIEF=1）─────────────────────────
    if (runBrief) {
      console.log('\n── 市场简报（RUN_BRIEF=1）──')
      const briefTask = await startTask(adapterUrl, '/brief', { period: 'now', scope: 'all' }, sink.signal)
      const briefResult = (await consumeSse(
        `${adapterUrl}/analyze/${briefTask}/stream`,
        sink,
        timeoutMs,
      )) as { signal: BriefSignal & { opportunities: unknown[] } }
      const summary = briefResult.signal.summary ?? ''
      console.log(
        `✅ POST /brief → period=${briefResult.signal.period} trade_date=${briefResult.signal.trade_date}`,
      )
      console.log(`   summary 长度=${summary.length} 机会点=${briefResult.signal.opportunities.length}`)
      console.log('\n===== renderBrief 开头（模型侧完整简报）=====')
      console.log(renderBrief(briefResult).split('\n').slice(0, 20).join('\n'))
      expect(summary).not.toBe('')
    } else {
      console.log('（跳过 /brief：RUN_BRIEF=1 开启）')
    }

    // ── 5) analyze_holdings quick（可选，RUN_HOLDINGS=1）─────────────
    if (runHoldings) {
      console.log('\n── 持仓风险分析 quick（RUN_HOLDINGS=1）──')
      const holdingsTask = await startTask(
        adapterUrl,
        '/holdings/analyze',
        {
          mode: 'quick',
          risk_profile: 'conservative',
          holdings: [
            { ticker: '600519', quantity: 200, cost_price: 1500 },
            { ticker: '000858', quantity: 300, cost_price: 120 },
          ],
        },
        sink.signal,
      )
      const holdingsResult = (await consumeSse(
        `${adapterUrl}/analyze/${holdingsTask}/stream`,
        sink,
        timeoutMs,
      )) as { signal: HoldingsSignal; reports?: Record<string, string> }
      console.log(
        `✅ POST /holdings/analyze → 市值=${holdingsResult.signal.total_market_value} ` +
          `HHI=${holdingsResult.signal.concentration_hhi} risk_profile=${holdingsResult.signal.risk_profile}`,
      )
      console.log('\n===== renderHoldingsCard（持仓卡）=====')
      console.log(renderHoldingsCard(holdingsResult.signal))
      console.log('\n===== renderHoldingsReport 开头=====')
      console.log(renderHoldingsReport(holdingsResult).split('\n').slice(0, 15).join('\n'))
      expect(holdingsResult.signal.total_market_value).toBeTruthy()
      expect(holdingsResult.signal.risk_profile).toBe('conservative')
      expect(Object.values(holdingsResult.signal.per_stock ?? {}).some(position => position.risk_level)).toBe(true)
    } else {
      console.log('（跳过 /holdings/analyze：RUN_HOLDINGS=1 开启）')
    }

    // ── 6) set_risk_profile / get_risk_profile 往返 ──────────────────
    console.log('\n── 风险偏好工具 ──')
    const original = (await getRiskProfile(adapterUrl, sink.signal)) as {
      risk_profile?: string
      label?: string
    }
    console.log(`✅ GET /risk_profile → ${original.risk_profile}（${original.label}）`)
    let changed!: { risk_profile?: string; label?: string }
    let persisted!: { risk_profile?: string }
    try {
      changed = (await setRiskProfile(adapterUrl, 'aggressive', sink.signal)) as {
        risk_profile?: string
        label?: string
      }
      persisted = (await getRiskProfile(adapterUrl, sink.signal)) as { risk_profile?: string }
    } finally {
      await setRiskProfile(adapterUrl, original.risk_profile ?? 'balanced', sink.signal)
    }
    const restored = (await getRiskProfile(adapterUrl, sink.signal)) as { risk_profile?: string }
    console.log(
      `✅ POST /risk_profile → ${changed.risk_profile}（${changed.label}），GET 后=${persisted.risk_profile}`,
    )
    console.log(`✅ 已恢复 → ${restored.risk_profile}`)
    expect(persisted.risk_profile).toBe('aggressive')
    expect(restored.risk_profile).toBe(original.risk_profile)

    console.log('\n✅ 全部通过')
  }, e2eTotalTimeoutMs)
})
