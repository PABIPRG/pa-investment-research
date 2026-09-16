/** Pure startup-error formatting shared by the Electron dialog and diagnostics. */

export interface StartupFailurePresentation {
  readonly detail: string
  readonly message: string
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

/** Flatten Error causes and AggregateError members without repeating wrapper messages. */
export function startupErrorMessages(error: unknown): readonly string[] {
  const messages: string[] = []
  const seenObjects = new Set<object>()
  const seenMessages = new Set<string>()
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) {
      const message = String(value)
      if (!seenMessages.has(message)) {
        seenMessages.add(message)
        messages.push(message)
      }
      return
    }
    if (seenObjects.has(value)) return
    seenObjects.add(value)
    if (value instanceof Error && value.message !== '' && !seenMessages.has(value.message)) {
      seenMessages.add(value.message)
      messages.push(value.message)
    }
    if (value instanceof AggregateError) {
      for (const member of value.errors) visit(member)
    }
    if ('cause' in value && value.cause !== undefined) visit(value.cause)
  }
  visit(error)
  return messages
}

/** Produce a bounded, readable diagnostic for stderr, the startup log, and the dialog. */
export function formatStartupError(error: unknown): string {
  return startupErrorMessages(error).join('\n') || '未知启动错误'
}

/** Map known startup failures to user-actionable Chinese copy. */
export function presentStartupFailure(error: unknown, logPath?: string): StartupFailurePresentation {
  const diagnostics = formatStartupError(error)
  const logHint = logPath === undefined ? '' : `\n\n诊断日志：${logPath}`
  if (diagnostics.includes('has a healthy process left by a previous managed runtime')) {
    return {
      message: '检测到之前的投研实例仍占用后台',
      detail: `请先关闭旧的 Web 或 Electron 实例，然后重试。${logHint}`,
    }
  }
  if (errorCode(error) === 'DSH_INVESTMENT_INSTANCE_STOP_FAILED') {
    return {
      message: '旧实例未能正常停止',
      detail: `请先关闭旧的 Web 或 Electron 实例，然后重试。${logHint}`,
    }
  }
  if (diagnostics.includes('investment Python packaged runtime is invalid')) {
    return {
      message: '应用内置投研运行时不完整',
      detail: `应用包完整性检查未通过，请重新安装完整应用包。\n\n${diagnostics}${logHint}`,
    }
  }
  return {
    message: '投研组件加载失败',
    detail: `${diagnostics}${logHint}`,
  }
}
