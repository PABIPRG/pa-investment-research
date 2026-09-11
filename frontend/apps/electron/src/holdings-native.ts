/** Main-process holdings actions: fixed destinations and consent for each foreground read. */
import { dialog, ipcMain, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

import { HOLDINGS_NATIVE_CHANNEL } from './ipc.ts'

type NativeRequest = { action: 'read' | 'launch' | 'select_client'; account_mode: 'real' | 'simulated'; client_path?: string }

/**
 * Bind one window's holdings actions and return its cleanup.
 * @param window - sole renderer allowed to request these operations.
 * @param run - host-only backend entry, never exposed over general RPC.
 * @returns disposal function for the IPC handler.
 */
export function bindHoldingsNative(window: BrowserWindow, run: (request: NativeRequest) => Promise<unknown>): () => Promise<void> {
  let busy = false
  const pending = new Set<Promise<unknown>>()
  const handle = async (event: IpcMainInvokeEvent, input: unknown): Promise<unknown> => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无权执行本机动作')
    if (typeof input !== 'object' || input === null) throw new Error('无效动作')
    const value = input as Record<string, unknown>
    if (Object.keys(value).some(key => key !== 'action' && key !== 'account_mode')) throw new Error('不接受自定义路径或命令')
    const action = value.action
    const account = value.account_mode
    if (account !== 'real' && account !== 'simulated') throw new Error('无效账户')
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
      if (action !== 'read' && action !== 'launch') throw new Error('不支持的本机动作')
      const path = `交易 → ${account === 'simulated' ? '模拟' : 'A股'} → 股票 → 持仓`
      const confirmation = await dialog.showMessageBox(window, {
        type: 'question', title: '需要前往同花顺读取持仓', message: action === 'read' ? '需要前往同花顺读取持仓' : '打开同花顺',
        detail: action === 'read'
          ? `我们将前往：\n${path}\n\n窗口会短暂切换到同花顺。系统只读取持仓表格，不读取交易密码、不提交任何委托。读取完成或失败后会返回投研智能体。本次允许不会用于后续读取。`
          : `即将打开同花顺，请自行登录并进入：\n${path}\n\n不会自动输入密码或提交委托。完成后请返回投研智能体。`,
        buttons: ['允许并继续', '取消'], defaultId: 1, cancelId: 1, noLink: true,
      })
      if (confirmation.response !== 0) return { canceled: true }
      try {
        return await run({ action, account_mode: account })
      } finally {
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
    await Promise.allSettled(pending)
  }
}
