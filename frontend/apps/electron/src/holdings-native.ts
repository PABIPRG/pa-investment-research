/** Main-process holdings actions: fixed destinations, durable consent, and opaque previews. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dialog, ipcMain, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

import { HOLDINGS_NATIVE_CHANNEL } from './ipc.ts'

type AccountMode = 'real' | 'simulated'
type NativeRequest = { action: 'read' | 'cancel_read' | 'commit' | 'launch' | 'select_client'; account_mode: AccountMode; operation_id?: string; preview_token?: string; time_overrides?: Record<string, string>; client_path?: string }
type RendererAction = 'read' | 'cancel_read' | 'commit' | 'discard' | 'launch' | 'select_client' | 'download' | 'accessibility' | 'automation' | 'consent_status' | 'revoke_consent'

/** Durable product authorization owned by the Electron main process. */
export interface HoldingsConsentStore {
  persistent: boolean
  setPersistent(value: boolean): Promise<void>
}

/**
 * Load the product-level holdings authorization and persist later changes atomically.
 * @param path - JSON file below Electron's userData directory.
 * @returns mutable main-process authorization store.
 */
export async function createHoldingsConsentStore(path: string): Promise<HoldingsConsentStore> {
  let persistent = false
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    persistent = typeof value === 'object' && value !== null && (value as { persistent?: unknown }).persistent === true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
  return {
    get persistent() { return persistent },
    async setPersistent(value: boolean): Promise<void> {
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: 1, persistent: value })}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
      persistent = value
    },
  }
}

/**
 * Bind one window's holdings actions and return its cleanup.
 * @param window - sole renderer allowed to request these operations.
 * @param run - host-only backend entry, never exposed over general RPC.
 * @param consent - durable product authorization owned by the main process.
 * @returns disposal function for the IPC handler.
 */
export function bindHoldingsNative(window: BrowserWindow, run: (request: NativeRequest, signal?: AbortSignal) => Promise<unknown>, consent: HoldingsConsentStore): () => Promise<void> {
  let busy = false
  let activeRead: { account: AccountMode; abort: AbortController; operationId: string } | undefined
  const pending = new Set<Promise<unknown>>()
  const previews = new Map<string, { token: string; account: AccountMode; tickers: Set<string>; count: number; expires: number }>()
  const handle = async (event: IpcMainInvokeEvent, input: unknown): Promise<unknown> => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无权执行本机动作')
    if (typeof input !== 'object' || input === null) throw new Error('无效动作')
    const value = input as Record<string, unknown>
    if (Object.keys(value).some(key => !['action', 'account_mode', 'authorization', 'session_id', 'time_overrides'].includes(key))) throw new Error('不接受自定义路径或命令')
    const action = value.action as RendererAction
    const account = value.account_mode
    if (account !== 'real' && account !== 'simulated') throw new Error('无效账户')
    if (action === 'consent_status') return { persistent_authorization: consent.persistent }
    if (action === 'revoke_consent') {
      await consent.setPersistent(false)
      return { persistent_authorization: false }
    }
    if (action === 'cancel_read') {
      const read = activeRead
      if (read === undefined) return { canceled: true }
      try {
        await run({ action: 'cancel_read', account_mode: read.account, operation_id: read.operationId })
      } finally {
        read.abort.abort()
      }
      return { canceled: true }
    }
    if (busy) return { blocking_reason: 'busy', reason: '另一次操作尚未结束。' }
    busy = true
    try {
      if (action === 'download') {
        if (process.platform !== 'darwin' && process.platform !== 'win32') throw new Error('当前平台不支持')
        await shell.openExternal(process.platform === 'darwin' ? 'https://download.10jqka.com.cn/free/mac/' : 'https://download.10jqka.com.cn/free/')
        return { opened: true }
      }
      if (action === 'accessibility' || action === 'automation') {
        if (process.platform !== 'darwin') throw new Error('当前平台不支持')
        await shell.openExternal(action === 'accessibility'
          ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
          : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation')
        return { opened: true }
      }
      if (action === 'select_client') {
        if (process.platform !== 'win32') throw new Error('当前平台不支持')
        const selection = await dialog.showOpenDialog(window, { title: '选择同花顺 xiadan.exe', properties: ['openFile'], filters: [{ name: '同花顺下单客户端', extensions: ['exe'] }] })
        if (selection.canceled || selection.filePaths.length !== 1) return { canceled: true }
        return await run({ action, account_mode: account, client_path: selection.filePaths[0]! })
      }
      if (action === 'discard') {
        if (typeof value.session_id === 'string') previews.delete(value.session_id)
        return { discarded: true }
      }
      if (action === 'commit') {
        if (typeof value.session_id !== 'string') throw new Error('预览已过期，请重新读取。')
        const preview = previews.get(value.session_id)
        if (preview === undefined || preview.expires <= Date.now() || preview.account !== account) {
          previews.delete(value.session_id)
          throw new Error('预览已过期或账户已变化，请重新读取。')
        }
        const confirmation = await dialog.showMessageBox(window, {
          type: 'question', title: '确认替换持仓', message: `确认替换 ${preview.count} 条持仓？`,
          detail: '确认后将整体替换本地持仓并重新计算组合风险。成交明细和时间来源会随本次快照保存。',
          buttons: ['确认替换', '取消'], defaultId: 1, cancelId: 1, noLink: true,
        })
        if (confirmation.response !== 0) return { canceled: true }
        const rawOverrides = typeof value.time_overrides === 'object' && value.time_overrides !== null && !Array.isArray(value.time_overrides)
          ? value.time_overrides as Record<string, unknown> : {}
        const timeOverrides: Record<string, string> = {}
        for (const [ticker, time] of Object.entries(rawOverrides)) {
          if (!preview.tickers.has(ticker) || typeof time !== 'string' || time.length === 0 || time.length > 64) throw new Error('持仓时间修改无效，请重新检查。')
          timeOverrides[ticker] = time
        }
        previews.delete(value.session_id)
        return await run({ action: 'commit', account_mode: account, preview_token: preview.token, time_overrides: timeOverrides })
      }
      if (action !== 'read' && action !== 'launch') throw new Error('不支持的本机动作')
      if (action === 'read' && !window.isFocused()) throw new Error('请先回到投研智能体，再主动读取持仓。')
      const path = `交易 → ${account === 'simulated' ? '模拟' : 'A股'} → 股票 → 持仓`
      const authorization = value.authorization === 'persistent' ? 'persistent' : 'once'
      if (action === 'launch' || !consent.persistent) {
        const confirmation = await dialog.showMessageBox(window, {
          type: 'question', title: action === 'read' ? '需要前往同花顺读取持仓' : '打开同花顺', message: action === 'read' ? '需要前往同花顺读取持仓' : '打开同花顺',
          detail: action === 'read'
            ? `我们将前往：\n${path}\n\n窗口会短暂切换到同花顺。系统只读取持仓与成交明细，不读取交易密码、不提交任何委托。读取完成或失败后会返回投研智能体。${authorization === 'persistent' ? '\n\n允许后，以后仍须由你主动点击读取，但不再重复询问；可随时关闭。' : '\n\n本次允许不会用于后续读取。'}`
            : `即将打开同花顺，请自行登录并进入：\n${path}\n\n不会自动输入密码或提交委托。完成后请返回投研智能体。`,
          buttons: ['允许并继续', '取消'], defaultId: 1, cancelId: 1, noLink: true,
        })
        if (confirmation.response !== 0) return { canceled: true }
        if (action === 'read' && authorization === 'persistent') await consent.setPersistent(true)
      }
      let operationId: string | undefined
      try {
        operationId = action === 'read' ? randomUUID() : undefined
        const abort = action === 'read' ? new AbortController() : undefined
        if (operationId !== undefined && abort !== undefined) activeRead = { account, abort, operationId }
        let result: unknown
        try {
          const request: NativeRequest = { action, account_mode: account, ...(operationId === undefined ? {} : { operation_id: operationId }) }
          result = abort === undefined ? await run(request) : await run(request, abort.signal)
        } catch (error) {
          if (abort?.signal.aborted === true) return { canceled: true }
          throw error
        }
        if (abort?.signal.aborted === true) return { canceled: true }
        if (action !== 'read' || typeof result !== 'object' || result === null) return result
        const record = result as Record<string, unknown>
        if (typeof record.preview_token !== 'string') return result
        const sessionId = randomUUID()
        const items = Array.isArray(record.items) ? record.items : []
        const tickers = new Set(items.flatMap(item => typeof item === 'object' && item !== null && typeof (item as { ticker?: unknown }).ticker === 'string' ? [(item as { ticker: string }).ticker] : []))
        previews.set(sessionId, { token: record.preview_token, account, tickers, count: items.length, expires: Date.now() + 300_000 })
        const { preview_token: _secret, ...clientSafe } = record
        return { ...clientSafe, session_id: sessionId, persistent_authorization: consent.persistent }
      } finally {
        if (activeRead?.operationId === operationId) activeRead = undefined
        if (action === 'read' && !window.isDestroyed()) { window.show(); window.focus() }
      }
    } finally { busy = false }
  }
  ipcMain.handle(HOLDINGS_NATIVE_CHANNEL, (event, input: unknown) => {
    const operation = handle(event, input)
    pending.add(operation)
    void operation.finally(() => { pending.delete(operation) }).catch(() => {})
    return operation
  })
  return async () => {
    ipcMain.removeHandler(HOLDINGS_NATIVE_CHANNEL)
    if (activeRead !== undefined) {
      const read = activeRead
      try { await run({ action: 'cancel_read', account_mode: read.account, operation_id: read.operationId }) }
      catch { /* Teardown still aborts and joins the in-flight request. */ }
      finally { read.abort.abort() }
    }
    await Promise.allSettled(pending)
    previews.clear()
  }
}
