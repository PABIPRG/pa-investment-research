// 阶段F：dsh 对话内主动推送简报（可选增强）
//
// 轮询适配器 /brief/latest → 未 dsh-pushed 的简报 → ctx.get('agents').roots() 逐 agent
// followup 播报 → 成功后 POST /brief/{id}/dsh-pushed 去重。重启可重放：`dsh_pushed`
// 标记持久化在适配器侧，已播报的简报不会重复推送。
//
// untrusted framing：简报正文是 LLM/模板生成的数据，一律包裹在「插件播报」文本里
// 并带 source: plugin，避免模型把简报内容误当用户指令执行。
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { getLatestBrief, httpJson } from './client.ts'

/** In-chat brief polling and audience settings. */
export interface BriefPusherConfig {
  /** Adapter origin used for brief reads and delivery markers. */
  adapterBaseUrl: string
  /** Enable periodic in-chat delivery; external channels remain adapter-owned. */
  enableInChatPush: boolean
  /** Requested polling interval in milliseconds, clamped to at least 30000. */
  pushPollMs: number
  /** Target session ids; an empty list selects every active root agent. */
  pushSessions: string[]
}

interface LatestBrief {
  id?: string
  period?: string
  trade_date?: string
  summary?: string
  dsh_pushed?: boolean
}

const PERIOD_LABEL: Record<string, string> = { pre_market: '盘前', post_market: '盘后', now: '盘中' }

function briefBody(label: string, tradeDate: string | undefined, summary: string | undefined): string {
  return `${label}简报 · ${tradeDate ?? ''}\n\n${summary ?? ''}`.trim()
}

/**
 * Start effect-owned brief polling when in-chat delivery is enabled.
 * The effect polls immediately and then at the clamped interval, skips overlap, marks only delivered briefs,
 * contains per-session and polling failures, and aborts then awaits in-flight delivery during disposal.
 * @param ctx - Plugin context supplying agents, logging, and effect disposal.
 * @param config - Resolved adapter, interval, enablement, and audience settings.
 * @returns asynchronous quiescent disposer when enabled, otherwise undefined.
 */
export function createBriefPusher(ctx: Context, config: BriefPusherConfig): (() => Promise<void>) | undefined {
  if (!config.enableInChatPush) return undefined
  if (ctx.get('agents') === undefined) {
    ctx.logger.warn('[stock-analysis] 对话内播报已开启但 agents 服务不可用，忽略')
    return undefined
  }

  const pollMs = Math.max(config.pushPollMs, 30_000)
  const controller = new AbortController()
  let delivering = false
  let disposed = false
  let inFlight: Promise<void> | undefined

  const deliver = async (): Promise<void> => {
    delivering = true
    try {
      const brief = (await getLatestBrief(config.adapterBaseUrl, controller.signal)) as LatestBrief
      if (disposed || !brief.id || brief.dsh_pushed) return

      const label = PERIOD_LABEL[brief.period ?? ''] ?? '盘中'
      const body = briefBody(label, brief.trade_date, brief.summary)
      if (!body) return

      const msg = createUserMessage({
        content: [{ type: 'text', text: `[插件播报 · ${label}简报]\n${body}` }],
        source: { kind: 'plugin', plugin: 'stock-analysis' },
      })

      const roots = ctx.get('agents')?.roots() ?? []
      const targets =
        config.pushSessions.length > 0
          ? roots.filter(agent => config.pushSessions.includes(String(agent.id)))
          : roots
      let sent = 0
      for (const agent of targets) {
        if (disposed) return
        try {
          agent.followup(msg)
          sent++
        } catch {
          /* 单个会话播报失败不影响其它会话 */
        }
      }
      if (sent > 0 && !disposed) {
        await httpJson(
          config.adapterBaseUrl,
          `/brief/${encodeURIComponent(brief.id)}/dsh-pushed`,
          'POST',
          undefined,
          controller.signal,
        )
        ctx.logger.info(`[stock-analysis] 已向 ${sent} 个会话播报简报 ${brief.id}`)
      }
    } catch {
      /* 轮询失败静默，下个周期重试 */
    } finally {
      delivering = false
    }
  }

  const trigger = (): void => {
    if (disposed || delivering) return
    const current = deliver()
    inFlight = current
    void current.finally(() => {
      inFlight = undefined
    })
  }
  const timer = setInterval(() => {
    trigger()
  }, pollMs)
  trigger()
  return async () => {
    if (disposed) return
    disposed = true
    clearInterval(timer)
    controller.abort(new Error('stock-analysis brief pusher disposed'))
    await inFlight
  }
}

/**
 * Start effect-owned polling for callers that do not compose a larger ordered lifecycle.
 * @param ctx - Plugin context supplying agents and effect disposal.
 * @param config - Resolved adapter, interval, enablement, and audience settings.
 */
export function setupBriefPusher(ctx: Context, config: BriefPusherConfig): void {
  const dispose = createBriefPusher(ctx, config)
  if (dispose !== undefined) ctx.effect(() => dispose)
}
