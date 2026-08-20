// 插件核心链路验证（不依赖 dsh Web UI）：
//   startAnalysis → consumeSse(SSE 进度) → injectProgress → renderFullReport
//   set_watchlist / get_watchlist / get_latest_brief（轻量 HTTP）
//   可选：market_brief（RUN_BRIEF=1）/ analyze_holdings quick（RUN_HOLDINGS=1）
// 用法：ADAPTER_URL=http://127.0.0.1:8000 npx tsx test/plugin.e2e.ts
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
  type BriefSignal,
  type HoldingsSignal,
} from '../src/render.ts'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

const BASE = process.env.ADAPTER_URL ?? 'http://127.0.0.1:8000'
const ticker = process.env.TICKER ?? '600519'
const timeoutMs = Number(process.env.SSE_TIMEOUT_MS ?? 60_000)
const runBrief = process.env.RUN_BRIEF === '1'
const runHoldings = process.env.RUN_HOLDINGS === '1'

const injected: string[] = []
const sink = {
  signal: new AbortController().signal,
  agent: {
    inject(msg: UserMessage) {
      for (const block of msg.content ?? []) {
        if (block.type === 'text') injected.push(block.text)
      }
    },
  },
}

async function main() {
  console.log(`== 插件核心链路验证 适配器=${BASE} ticker=${ticker} ==`)
  const failures: string[] = []

  // ── 1) analyze_stock：SSE 全链路 ───────────────────────────────────
  const taskId = await startAnalysis(BASE, { ticker, research_depth: 'standard' }, sink.signal)
  console.log(`✅ POST /analyze → task_id=${taskId}`)

  const result = (await consumeSse(`${BASE}/analyze/${taskId}/stream`, sink, timeoutMs)) as {
    signal: Record<string, unknown>
    reports?: Record<string, string>
  }

  console.log(`✅ SSE 消费完成；注入模型上下文的进度条数=${injected.length}`)
  console.log('   进度示例:', injected[0], '…')
  console.log(`✅ signal.action=${result.signal.action} company=${result.signal.company_name}`)
  console.log(`✅ reports 键=${Object.keys(result.reports ?? {}).join(',')}`)

  console.log('\n===== renderSignalCard（UI 结果卡）=====')
  console.log(renderSignalCard(result.signal))
  console.log('\n===== renderFullReport 开头（模型侧完整 Markdown）=====')
  console.log(renderFullReport(result).split('\n').slice(0, 30).join('\n'))

  if (injected.length === 0) failures.push('未收到进度 stage 事件')
  if (!result.signal?.action) failures.push('signal 缺 action')
  if (!result.reports || Object.keys(result.reports).length === 0) failures.push('缺 reports')

  // ── 2) set_watchlist / get_watchlist ───────────────────────────────
  console.log('\n── 自选列表工具 ──')
  const saved = (await setWatchlist(BASE, ['600519', '000858', '300750'], sink.signal)) as {
    saved?: number
  }
  console.log(`✅ POST /watchlist → saved=${saved.saved}`)
  const wl = (await getWatchlist(BASE, sink.signal)) as { tickers?: string[] }
  console.log(`✅ GET /watchlist → tickers=${JSON.stringify(wl.tickers)}`)
  if (saved.saved !== 3) failures.push(`set_watchlist 期望 saved=3 实得 ${saved.saved}`)
  if (!wl.tickers?.includes('600519')) failures.push('get_watchlist 缺 600519')

  // ── 3) get_latest_brief ────────────────────────────────────────────
  console.log('\n── 最近简报工具 ──')
  const brief = (await getLatestBrief(BASE, sink.signal)) as {
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

  // ── 4) market_brief（可选，RUN_BRIEF=1）───────────────────────────
  if (runBrief) {
    console.log('\n── 市场简报（RUN_BRIEF=1）──')
    const bTask = await startTask(BASE, '/brief', { period: 'now', scope: 'all' }, sink.signal)
    const bRes = (await consumeSse(`${BASE}/analyze/${bTask}/stream`, sink, timeoutMs)) as {
      signal: BriefSignal & { opportunities: unknown[] }
    }
    const summary = bRes.signal.summary ?? ''
    console.log(`✅ POST /brief → period=${bRes.signal.period} trade_date=${bRes.signal.trade_date}`)
    console.log(`   summary 长度=${summary.length} 机会点=${(bRes.signal.opportunities as unknown[]).length}`)
    console.log('\n===== renderBrief 开头（模型侧完整简报）=====')
    console.log(renderBrief(bRes).split('\n').slice(0, 20).join('\n'))
    if (!summary) failures.push('简报 summary 为空')
  } else {
    console.log('（跳过 /brief：RUN_BRIEF=1 开启）')
  }

  // ── 5) analyze_holdings quick（可选，RUN_HOLDINGS=1）───────────────
  if (runHoldings) {
    console.log('\n── 持仓风险分析 quick（RUN_HOLDINGS=1）──')
    const hTask = await startTask(
      BASE,
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
    const hRes = (await consumeSse(`${BASE}/analyze/${hTask}/stream`, sink, timeoutMs)) as {
      signal: HoldingsSignal
      reports?: Record<string, string>
    }
    console.log(
      `✅ POST /holdings/analyze → 市值=${hRes.signal.total_market_value} HHI=${hRes.signal.concentration_hhi} risk_profile=${hRes.signal.risk_profile}`,
    )
    console.log('\n===== renderHoldingsCard（持仓卡）=====')
    console.log(renderHoldingsCard(hRes.signal))
    console.log('\n===== renderHoldingsReport 开头=====')
    console.log(renderHoldingsReport(hRes).split('\n').slice(0, 15).join('\n'))
    if (!hRes.signal?.total_market_value) failures.push('持仓 signal 缺 total_market_value')
    if (hRes.signal?.risk_profile !== 'conservative') {
      failures.push(`持仓 risk_profile 期望 conservative 实得 ${hRes.signal?.risk_profile}`)
    }
    const per = hRes.signal.per_stock
    if (!per || !Object.values(per).some(p => p.risk_level)) failures.push('逐股缺 risk_level 标签')
  } else {
    console.log('（跳过 /holdings/analyze：RUN_HOLDINGS=1 开启）')
  }

  // ── 6) set_risk_profile / get_risk_profile 往返 ────────────────────
  console.log('\n── 风险偏好工具 ──')
  const orig = (await getRiskProfile(BASE, sink.signal)) as { risk_profile?: string; label?: string }
  console.log(`✅ GET /risk_profile → ${orig.risk_profile}（${orig.label}）`)
  const setRes = (await setRiskProfile(BASE, 'aggressive', sink.signal)) as {
    risk_profile?: string
    label?: string
  }
  const after = (await getRiskProfile(BASE, sink.signal)) as { risk_profile?: string }
  console.log(`✅ POST /risk_profile → ${setRes.risk_profile}（${setRes.label}），GET 后=${after.risk_profile}`)
  if (after.risk_profile !== 'aggressive') failures.push('set_risk_profile 未持久化')
  // 恢复原偏好（不污染全局状态）
  await setRiskProfile(BASE, orig.risk_profile ?? 'balanced', sink.signal)
  const restored = (await getRiskProfile(BASE, sink.signal)) as { risk_profile?: string }
  console.log(`✅ 已恢复 → ${restored.risk_profile}`)
  if (restored.risk_profile !== orig.risk_profile) failures.push('set_risk_profile 恢复失败')

  if (failures.length) {
    console.log('\n❌ 验证失败:', failures.join('; '))
    process.exit(1)
  }
  console.log('\n✅ 全部通过')
}

main().catch((error: unknown) => {
  console.error('❌', error)
  process.exit(1)
})
