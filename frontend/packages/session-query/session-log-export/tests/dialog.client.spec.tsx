// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { SessionLogDownloadController } from '../src/client/controller.ts'
import { SessionLogDownloadDialog } from '../src/client/Dialog.tsx'
import type { SessionLogDownloadDialogProps } from '../src/client/Dialog.tsx'
import { en, zh } from '../src/client/locales.ts'

const SID = 'session-export-dialog' as SessionId

function bench(
  controller = new SessionLogDownloadController(
    async () => new Response('zip', { status: 200 }), vi.fn(),
  ),
  dictionary: typeof en = en,
) {
  const dismiss = vi.fn((sessionId: SessionId) => { controller.dismiss(sessionId) })
  function useSessionLogDownload<T>(selector: (state: ReturnType<typeof controller.store.getSnapshot>) => T): T {
    return useSyncExternalStore(
      listener => controller.store.subscribe(listener),
      () => selector(controller.store.getSnapshot()),
    )
  }
  const t = (key: keyof typeof en): string => dictionary[key]
  const props = { sessionId: SID, useSessionLogDownload, dismiss, t } as unknown as SessionLogDownloadDialogProps
  const view = render(<SessionLogDownloadDialog {...props} />)
  return { controller, dismiss, view }
}

afterEach(cleanup)

describe('SessionLogDownloadDialog', () => {
  it('hides a controller failure behind stable product copy and closes without reading Session history', async () => {
    const b = bench()
    act(() => {
      b.controller.store.set({
        bySession: { [SID]: { open: true, status: 'error', error: 'toolbar failed' } },
      })
    })
    const dialog = await b.view.findByRole('dialog', { name: 'Export failed' })
    expect(dialog.textContent).toContain('Unable to export this conversation right now. Please try again.')
    expect(dialog.textContent).not.toContain('toolbar failed')
    const close = b.view.getAllByRole('button', { name: 'Close' })[0]
    if (close === undefined) throw new Error('Session export dialog has no close button')
    fireEvent.click(close)
    await waitFor(() => { expect(b.dismiss).toHaveBeenCalledWith(SID) })
  })

  it('renders the in-flight state and the settled browser download state', async () => {
    let release!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { release = resolve })
    const controller = new SessionLogDownloadController(() => pending, vi.fn())
    const b = bench(controller)

    const download = controller.download(SID)
    expect(await b.view.findByRole('dialog', { name: 'Preparing conversation backup' })).toBeTruthy()
    release(new Response('zip', { status: 200 }))
    await download
    expect(await b.view.findByRole('dialog', { name: 'Conversation backup download started' })).toBeTruthy()
  })

  it('uses fallback copy when a failure has no detail', async () => {
    const b = bench()
    act(() => {
      b.controller.store.set({
        bySession: { [SID]: { open: true, status: 'error', error: '' } },
      })
    })
    const dialog = await b.view.findByRole('dialog', { name: 'Export failed' })
    expect(dialog.textContent).toContain('Unable to export this conversation right now. Please try again.')
    const close = b.view.getAllByRole('button', { name: 'Close' }).at(-1)
    if (close === undefined) throw new Error('Session export dialog has no footer action')
    fireEvent.click(close)
    await waitFor(() => { expect(b.dismiss).toHaveBeenCalledWith(SID) })
  })

  it('renders the complete Chinese preparation, success, and failure copy', async () => {
    let release!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { release = resolve })
    const controller = new SessionLogDownloadController(() => pending, vi.fn())
    const b = bench(controller, zh)

    const download = controller.download(SID)
    const preparing = await b.view.findByRole('dialog', { name: '正在准备对话备份' })
    expect(preparing.textContent).toContain('正在整理当前对话、关联对话和附件，请稍候。')
    release(new Response('zip', { status: 200 }))
    await download
    const success = await b.view.findByRole('dialog', { name: '对话备份已开始下载' })
    expect(success.textContent).toContain('ZIP 备份已开始下载。')

    act(() => {
      controller.store.set({
        bySession: { [SID]: { open: true, status: 'error', error: 'host-private-detail' } },
      })
    })
    const failure = await b.view.findByRole('dialog', { name: '导出失败' })
    expect(failure.textContent).toContain('暂时无法导出对话，请重试。')
    expect(failure.textContent).not.toContain('host-private-detail')
  })
})
