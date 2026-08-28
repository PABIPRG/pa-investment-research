import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalTelemetry } from '../src/client/telemetry.ts'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function ids(): () => string {
  let value = 0
  return () => `id-${++value}`
}

describe('本地学习记录器', () => {
  it('只构造白名单事件，不产生用户身份或客户端时间字段', async () => {
    const requestData = vi.fn(async (_request: InvestmentDataRequest) => ({}))
    const recorder = createLocalTelemetry(requestData, { id: ids() })

    await recorder.track({
      action: 'open', surface: 'search', targetType: 'security', targetId: '600519',
      context: { ticker: '600519', industries: ['白酒'], position: 1 },
    })

    expect(recorder.sessionId).toBe('session:id-1')
    expect(requestData).toHaveBeenCalledWith({
      operation: 'trading-core.local-learning-events',
      input: {
        events: [{
          event_id: 'event:id-2', schema_version: 1, action: 'open', surface: 'search',
          target_type: 'security', target_id: '600519', session_id: 'session:id-1',
          context: { ticker: '600519', industries: ['白酒'], position: 1 },
        }],
      },
    })
    const event = (requestData.mock.calls[0]?.[0].input?.events as Array<Record<string, unknown>>)[0]
    expect(event).not.toHaveProperty('occurred_at')
    expect(event).not.toHaveProperty('user_id')
  })

  it('按会话去重曝光，并让普通打开保持逐次记录', async () => {
    const requestData = vi.fn(async () => ({}))
    const recorder = createLocalTelemetry(requestData, { id: ids() })
    const impression = {
      action: 'impression' as const, surface: 'dashboard' as const,
      targetType: 'event' as const, targetId: 'card-1', dedupe: 'session' as const,
    }

    await recorder.track(impression)
    await recorder.track(impression)
    await recorder.track({ ...impression, targetId: 'card-2' })
    await recorder.track({ ...impression, action: 'open', dedupe: 'none' })
    await recorder.track({ ...impression, action: 'open', dedupe: 'none' })

    expect(requestData).toHaveBeenCalledTimes(4)
  })

  it('短窗去重吸收严格模式重放，并允许稍后真实返回', async () => {
    let clock = 1_000
    const requestData = vi.fn(async () => ({}))
    const recorder = createLocalTelemetry(requestData, {
      id: ids(), now: () => clock, momentWindowMs: 750,
    })
    const page = {
      action: 'page_view' as const, surface: 'portfolio' as const,
      targetType: 'page' as const, targetId: 'portfolio', dedupe: 'moment' as const,
    }

    await recorder.track(page)
    clock += 200
    await recorder.track(page)
    clock += 800
    await recorder.track(page)

    expect(requestData).toHaveBeenCalledTimes(2)
  })

  it('去重缓存有界，淘汰后允许旧对象再次记录', async () => {
    const requestData = vi.fn(async () => ({}))
    const recorder = createLocalTelemetry(requestData, { id: ids(), dedupeCapacity: 2 })
    const track = (targetId: string) => recorder.track({
      action: 'impression', surface: 'dashboard', targetType: 'event', targetId, dedupe: 'session',
    })

    await track('a'); await track('b'); await track('c'); await track('a')

    expect(requestData).toHaveBeenCalledTimes(4)
  })

  it('记录失败始终被吞吐，不改变调用方动作', async () => {
    const requestData = vi.fn(async () => { throw new Error('offline') })
    const recorder = createLocalTelemetry(requestData, { id: ids() })

    await expect(recorder.track({
      action: 'analyze', surface: 'assistant', targetType: 'page', targetId: 'assistant-prompt',
    })).resolves.toBeUndefined()
  })

  it('默认标识优先使用浏览器随机 UUID，并在不可用时使用无身份回退', async () => {
    const requestData = vi.fn(async () => ({}))
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'uuid-value') })
    const native = createLocalTelemetry(requestData)
    await native.track({ action: 'open', surface: 'dashboard', targetType: 'event', targetId: 'card-1' })
    expect(native.sessionId).toBe('session:uuid-value')

    vi.stubGlobal('crypto', {})
    vi.spyOn(Date, 'now').mockReturnValue(1234)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const fallback = createLocalTelemetry(requestData)
    await fallback.track({ action: 'open', surface: 'dashboard', targetType: 'event', targetId: 'card-2' })
    expect(fallback.sessionId).toMatch(/^session:y[a-z0-9-]+$/)
  })
})
