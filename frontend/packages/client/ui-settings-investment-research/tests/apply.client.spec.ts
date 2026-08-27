import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore, SlotRegistry, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionLogDownloadState } from '@deepseek-ai/dsh-session-log-export/client'
import { apply, inject } from '../src/client/index.ts'
import { InvestmentReadinessSection } from '../src/client/InvestmentReadinessSection.tsx'
import type { InvestmentReadinessSnapshot } from '../src/client/store.ts'

const EMPTY: InvestmentReadinessSnapshot = { runtimeAsset: { status: 'missing' }, backends: [] }

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const facade = {
    getSnapshot: () => EMPTY,
    subscribe: vi.fn(() => () => {}),
    refresh: vi.fn(() => Promise.resolve()),
    requestRestart: vi.fn(() => Promise.resolve({ status: 'accepted' as const })),
  }
  ctx.provide('investmentResearchRuntimeClient', facade)
  const sessionLogDownload = {
    store: createSnapshotStore<SessionLogDownloadState>({ bySession: {} }),
    download: vi.fn(() => Promise.resolve()),
  }
  ctx.provide('sessionLogDownload', sessionLogDownload as never)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, facade, sessionLogDownload }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-investment-research apply', () => {
  it('declares only its four required services', () => {
    expect(inject).toEqual([
      'slots', 'locale', 'investmentResearchRuntimeClient', 'sessionLogDownload',
    ])
  })

  it('waits for the section declaration and injects the facade through the hooks channel', async () => {
    const before = await bench()
    declare(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = before.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(InvestmentReadinessSection)
    expect(entry.options).toMatchObject({ id: 'investment-research', order: 20 })
    expect(resolveSlotLabel(entry.options.label)).toBe('投研')
    expect(entry.store).toBeDefined()
    const face = (entry.inject as unknown as (actions: unknown) => {
      hooks: { investmentReadiness: unknown; sessionLogDownload: unknown }
      downloadSession: (sessionId: SessionId) => Promise<void>
      requestRestart: () => Promise<unknown>
      refresh: () => Promise<void>
    })({})
    expect(face.hooks.investmentReadiness).toBe(before.facade)
    expect(face.hooks.sessionLogDownload).toBe(before.sessionLogDownload.store)
    const sessionId = 'session-settings-export' as SessionId
    await face.downloadSession(sessionId)
    await face.requestRestart()
    await face.refresh()
    expect(before.sessionLogDownload.download).toHaveBeenCalledOnce()
    expect(before.sessionLogDownload.download).toHaveBeenCalledWith(sessionId)
    expect(before.facade.requestRestart).toHaveBeenCalledOnce()
    expect(before.facade.refresh).toHaveBeenCalledOnce()

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    expect(after.slots.entries('settings.section')).toHaveLength(0)
    declare(after.slots)
    await Promise.resolve()
    expect(after.slots.entries('settings.section')).toHaveLength(1)
  })

  it('follows locale changes and withdraws on section HMR collapse and plugin disposal', async () => {
    const b = await bench()
    const collapse = declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('投研')
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('Investment research')

    collapse()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    declare(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('settings.section')).toHaveLength(1)

    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(() => b.locale.register('settings.investmentResearch', 'zh', {})).not.toThrow()
    expect(() => b.locale.register('settings.investmentResearch', 'en', {})).not.toThrow()
  })

  it('does not read readiness or invoke restart during registration', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.facade.subscribe).not.toHaveBeenCalled()
    expect(b.facade.refresh).not.toHaveBeenCalled()
    expect(b.facade.requestRestart).not.toHaveBeenCalled()
    expect(b.sessionLogDownload.download).not.toHaveBeenCalled()
  })
})
