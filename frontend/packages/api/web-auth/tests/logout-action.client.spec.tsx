// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LogoutAction } from '../src/client/LogoutAction.tsx'
import { apply, inject } from '../src/client/index.ts'

interface Bridge {
  enabled(): boolean
  logout(): Promise<'signed-out' | 'error'>
}

function setBridge(value: Bridge | undefined): void {
  const target = globalThis as typeof globalThis & { __DSH_WEB_AUTH__?: Bridge }
  if (value === undefined) delete target.__DSH_WEB_AUTH__
  else target.__DSH_WEB_AUTH__ = value
}

afterEach(() => {
  cleanup()
  setBridge(undefined)
})

describe('Web auth logout action', () => {
  const runtimeProps = {
    wide: true,
    useSessions: vi.fn(),
    useWorkspaces: vi.fn(),
  } as unknown as Parameters<typeof LogoutAction>[0]

  it('registers in the sidebar footer-action slot', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root', children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } },
    } as never, () => null)
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(ctx.slots.entries('sidebar.footer.action')).toHaveLength(1)
    expect(ctx.slots.entries('sidebar.footer.action')[0]?.component).toBe(LogoutAction)
    await ctx.fiber.dispose()
  })

  it('stays absent when authentication is disabled', () => {
    setBridge({ enabled: () => false, logout: vi.fn() })
    const view = render(<LogoutAction {...runtimeProps} />)
    expect(view.container.innerHTML).toBe('')
  })

  it('uses a native button and keeps logout failures visible and retryable', async () => {
    const logout = vi.fn()
      .mockResolvedValueOnce('error')
      .mockResolvedValueOnce('signed-out')
    setBridge({ enabled: () => true, logout })
    render(<LogoutAction {...runtimeProps} />)
    const initial = screen.getByRole('button', { name: '退出登录' })
    expect(initial.tagName).toBe('BUTTON')
    fireEvent.click(initial)
    const retry = await screen.findByRole('button', { name: '退出失败，重试' })
    expect(retry.textContent).toContain('退出失败，重试')
    fireEvent.click(retry)
    await waitFor(() => { expect(logout).toHaveBeenCalledTimes(2) })
  })
})
