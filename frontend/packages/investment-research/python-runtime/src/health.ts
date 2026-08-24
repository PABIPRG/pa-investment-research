import type { BackendHealthResult, PythonBackendDefinition } from './types.ts'

/** Dependencies and cancellation for one health probe. */
export interface BackendHealthOptions {
  /** Fetch implementation for the execution environment. */
  readonly fetch?: typeof globalThis.fetch
  /** Optional caller cancellation. */
  readonly signal?: AbortSignal
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isConnectionRefused(error: unknown): boolean {
  let current = error
  while (isRecord(current)) {
    if (current.code === 'ECONNREFUSED') return true
    current = current.cause
  }
  return false
}

/**
 * Probe one backend and classify identity, occupancy, and transport failures.
 * @param definition - backend identity and health expectations.
 * @param options - injected fetch implementation and cancellation signal.
 * @returns a classification in which only `refused` is safe for managed spawn.
 */
export async function checkBackendHealth(
  definition: PythonBackendDefinition,
  options: BackendHealthOptions = {},
): Promise<BackendHealthResult> {
  const healthUrl = new URL(definition.healthPath, definition.baseUrl).toString()
  const fetchImpl = options.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await fetchImpl(healthUrl, options.signal === undefined ? {} : { signal: options.signal })
  } catch (error) {
    return isConnectionRefused(error)
      ? { status: 'refused', healthUrl, error }
      : { status: 'unavailable', healthUrl, error }
  }

  if (!response.ok) {
    return { status: 'occupied', healthUrl, httpStatus: response.status }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    return { status: 'unavailable', healthUrl, error }
  }
  if (!isRecord(payload)) {
    return { status: 'unavailable', healthUrl, error: new Error('health response must be a JSON object') }
  }

  if (payload.service !== definition.service) {
    return { status: 'occupied', healthUrl, httpStatus: response.status }
  }
  for (const [key, expected] of Object.entries(definition.healthOk)) {
    if (payload[key] !== expected) {
      return { status: 'occupied', healthUrl, httpStatus: response.status }
    }
  }
  return { status: 'healthy', healthUrl, httpStatus: response.status }
}
