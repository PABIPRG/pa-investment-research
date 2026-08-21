import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { InvestmentBackendId } from './types.ts'

/** Stable log file locations for one backend. */
export interface BackendLogPaths {
  readonly active: string
  readonly previous: string
}

/** Backend log retention limits. */
export interface BackendLogOptions {
  readonly tailBytes: number
  readonly maxBytes: number
}

/**
 * Resolve the active and previous log files beneath DSH_HOME.
 * @param dshHome - explicit Harness home.
 * @param id - backend whose log paths are required.
 * @returns stable active and previous log paths.
 */
export function backendLogPaths(dshHome: string, id: InvestmentBackendId): BackendLogPaths {
  const directory = join(dshHome, 'investment-research', id)
  return {
    active: join(directory, 'backend.log'),
    previous: join(directory, 'backend.previous.log'),
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

function boundedTail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  return bytes.length <= maxBytes ? text : bytes.subarray(bytes.length - maxBytes).toString()
}

/** File-backed backend log with a bounded in-memory diagnostic tail. */
export class BackendLog {
  private retained = ''

  private constructor(
    readonly paths: BackendLogPaths,
    private readonly options: BackendLogOptions,
  ) {}

  /**
   * Open a backend log, rotating an already-oversized active file first.
   * @param paths - stable active and previous paths.
   * @param options - tail and active-file byte limits.
   * @returns the open log owner.
   */
  static async open(paths: BackendLogPaths, options: BackendLogOptions): Promise<BackendLog> {
    await mkdir(join(paths.active, '..'), { recursive: true, mode: 0o700 })
    if (await fileSize(paths.active) >= options.maxBytes) {
      try {
        await rename(paths.active, paths.previous)
      } catch (error) {
        /* v8 ignore next -- only an external unlink racing stat and rename reaches this branch */
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return new BackendLog(paths, options)
  }

  /**
   * Append source-labelled text to disk and the bounded in-memory tail.
   * @param source - diagnostic stream label.
   * @param text - output text to append.
   */
  async append(source: 'stdout' | 'stderr' | 'runtime', text: string): Promise<void> {
    if (text.length === 0) return
    const rendered = text.split(/(?<=\n)/u).map(line => `[${source}] ${line}`).join('')
    await appendFile(this.paths.active, rendered, { mode: 0o600 })
    this.retained = boundedTail(this.retained + rendered, this.options.tailBytes)
  }

  /**
   * Read the retained diagnostic suffix.
   * @returns the current bounded diagnostic tail.
   */
  tail(): string {
    return this.retained
  }
}

/**
 * Render an error without leaking explicitly forwarded environment values.
 * @param error - failure to render.
 * @param env - explicitly forwarded values that must be redacted.
 * @returns bounded-context diagnostic text with forwarded values removed.
 */
export function safeErrorMessage(error: unknown, env: Readonly<Record<string, string | undefined>> = {}): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const value of Object.values(env)) {
    if (value !== undefined && value.length > 0) message = message.replaceAll(value, '[REDACTED]')
  }
  return message
}
