// 阶段F：dsh 对话内主动推送简报（可选增强）
//
// 轮询适配器 /brief/latest → 未 dsh-pushed 的简报 → ctx.agents.roots() 逐 agent
// followup 播报 → 成功后 POST /brief/{id}/dsh-pushed 去重。重启可重放：`dsh_pushed`
// 标记持久化在适配器侧，已播报的简报不会重复推送。
//
// untrusted framing：简报正文是 LLM/模板生成的数据，一律包裹在「插件播报」文本里
// 并带 source: plugin，避免模型把简报内容误当用户指令执行。
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { getLatestBrief, httpJson } from './client.ts'

export interface BriefPusherConfig {
  adapterBaseUrl: string
  /** 是否开启 dsh 对话内定时播报。默认 false（外部推送由适配器 scheduler 负责）。 */
  enableInChatPush: boolean
  /** 轮询周期 ms，最小 30s。 */
  pushPollMs: number
  /** 播报目标会话 id 列表；空数组 = 所有活跃会话。 */
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

export function setupBriefPusher(ctx: Context, config: BriefPusherConfig): void {
  if (!config.enableInChatPush) return
  if (!ctx.agents) {
    ctx.logger?.warn?.('[stock-analysis] 对话内播报已开启但 agents 服务不可用，忽略')
    return
  }

  const pollMs = Math.max(config.pushPollMs, 30_000)
  let delivering = false

  const deliver = async (): Promise<void> => {
    if (delivering) return
    delivering = true
    try {
      const brief = (await getLatestBrief(config.adapterBaseUrl)) as LatestBrief
      if (!brief.id || brief.dsh_pushed) return

      const label = PERIOD_LABEL[brief.period ?? ''] ?? '盘中'
      const body = `${label}简报 · ${brief.trade_date ?? ''}\n\n${brief.summary ?? ''}`.trim()
      if (!body) return

      const msg = createUserMessage({
        content: [{ type: 'text', text: `[插件播报 · ${label}简报]\n${body}` }],
        source: { kind: 'plugin', plugin: 'stock-analysis' },
      })

      const roots = ctx.agents?.roots?.() ?? []
      const targets =
        config.pushSessions.length > 0
          ? roots.filter((agent) => config.pushSessions.includes(String(agent.id)))
          : roots
      let sent = 0
      for (const agent of targets) {
        try {
          agent.followup(msg)
          sent++
        } catch {
          /* 单个会话播报失败不影响其它会话 */
        }
      }
      if (sent > 0) {
        await httpJson(
          config.adapterBaseUrl,
          `/brief/${encodeURIComponent(brief.id)}/dsh-pushed`,
          'POST',
          undefined,
        )
        ctx.logger?.info?.(`[stock-analysis] 已向 ${sent} 个会话播报简报 ${brief.id}`)
      }
    } catch {
      /* 轮询失败静默，下个周期重试 */
    } finally {
      delivering = false
    }
  }

  // 绑定到上下文生命周期：dispose 时自动清掉定时器
  ctx.effect(() => {
    const timer = setInterval(deliver, pollMs)
    void deliver() // 启动立即试一次：dsh 打开时若有未播报的盘前简报则补播
    return () => clearInterval(timer)
  })
}
