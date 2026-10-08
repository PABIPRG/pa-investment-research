export interface RefreshPolicy { intervalMs: number | null; retry: boolean }
export interface RefreshResult { failed: boolean; retryAfterMs?: number }
export interface RefreshTask { updatePolicy: (policy: RefreshPolicy) => void; dispose: () => void }

/** 每个查询独立计时；请求结束后再等待，后台与离线期间不启动新请求。 */
export function startRefreshTask(run: (signal: AbortSignal) => Promise<RefreshResult>, initialPolicy: RefreshPolicy): RefreshTask {
  const controller = new AbortController()
  let policy = initialPolicy
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let finishedAt: number | null = null
  let failures = 0
  let retryAfterMs = 0

  function schedule(): void {
    clearTimeout(timer)
    if (controller.signal.aborted || running || document.visibilityState === 'hidden' || !navigator.onLine) return
    if (finishedAt === null) { void execute(); return }
    const delay = failures > 0
      ? policy.retry ? Math.max(Math.min(30_000 * 2 ** Math.min(failures - 1, 2), 120_000), retryAfterMs) : null
      : policy.intervalMs
    if (delay === null) return
    timer = setTimeout(() => { void execute() }, Math.max(0, finishedAt + delay - Date.now()))
  }
  async function execute(): Promise<void> {
    if (controller.signal.aborted || running || document.visibilityState === 'hidden' || !navigator.onLine) return
    running = true
    try {
      const result = await run(controller.signal)
      failures = result.failed ? failures + 1 : 0
      retryAfterMs = result.retryAfterMs ?? 0
    }
    catch {
      failures += 1
      retryAfterMs = 0
    }
    finally {
      running = false
      finishedAt = Date.now()
      schedule()
    }
  }
  document.addEventListener('visibilitychange', schedule)
  window.addEventListener('online', schedule)
  window.addEventListener('offline', schedule)
  schedule()
  return {
    updatePolicy(next) { policy = next; schedule() },
    dispose() {
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', schedule)
      window.removeEventListener('online', schedule)
      window.removeEventListener('offline', schedule)
    },
  }
}
