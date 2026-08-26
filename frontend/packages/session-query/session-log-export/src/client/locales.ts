/** Locale namespace owned by Session export browser feedback. */
export const NS = 'session-log-download'

/** Simplified-Chinese Session export strings. */
export const zh = {
  'action.export': '导出对话',
  'action.exporting': '正在导出…',
  'dialog.preparingTitle': '正在准备对话备份',
  'dialog.preparingDescription': '正在整理当前对话、关联对话和附件，请稍候。',
  'dialog.successTitle': '对话备份已开始下载',
  'dialog.successDescription': 'ZIP 备份已开始下载。',
  'dialog.errorTitle': '导出失败',
  'dialog.errorDescription': '暂时无法导出对话，请重试。',
  'dialog.close': '关闭',
} as const

/** English Session export strings. */
export const en: Record<keyof typeof zh, string> = {
  'action.export': 'Export conversation',
  'action.exporting': 'Exporting…',
  'dialog.preparingTitle': 'Preparing conversation backup',
  'dialog.preparingDescription': 'Organizing this conversation, related conversations, and attachments. Please wait.',
  'dialog.successTitle': 'Conversation backup download started',
  'dialog.successDescription': 'The ZIP backup download has started.',
  'dialog.errorTitle': 'Export failed',
  'dialog.errorDescription': 'Unable to export this conversation right now. Please try again.',
  'dialog.close': 'Close',
}

/** Stable locale keys consumed by the shared modal. */
export type SessionLogDownloadKey = keyof typeof zh
