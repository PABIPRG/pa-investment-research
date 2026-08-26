/** Industry-chain backend lifecycle plugin. @module @deepseek-ai/dsh-investment-industry-chain */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { PythonBackendDefinition, PythonBackendLease } from '@deepseek-ai/dsh-investment-python-runtime'

export const name = 'investment-industry-chain'

/** Industry-chain adapter connection settings. */
export interface Config {
  /** Runtime ownership mode. Defaults to managed. */
  backendMode?: 'managed' | 'external'
  /** Backend origin verified by the runtime. Defaults to `http://127.0.0.1:8200`. */
  backendBaseUrl?: string
  /** Explicit absolute industry-chain checkout when repository discovery is unavailable. */
  backendProjectDir?: string
}

export const Config: Schema<Config> = Schema.object({
  backendMode: Schema.union(['managed', 'external']).default('managed'),
  backendBaseUrl: Schema.string().default('http://127.0.0.1:8200'),
  backendProjectDir: Schema.string(),
})

export const inject = ['investmentPythonRuntime']

function industryChainBackend(config: Config): PythonBackendDefinition {
  return {
    id: 'industry-chain',
    service: 'industry-chain',
    mode: config.backendMode ?? 'managed',
    baseUrl: config.backendBaseUrl ?? 'http://127.0.0.1:8200',
    ...(config.backendProjectDir === undefined ? {} : { projectDir: config.backendProjectDir }),
    repositoryPath: ['backend', 'industry-chain'],
    module: 'industry_chain.app:app',
    healthPath: '/health',
    healthOk: { ok: true },
    initCommand: { posix: './init.sh', windows: 'init.bat' },
  }
}

/** Register, acquire, and release the industry-chain backend in one ordered effect. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  await ctx.effect(async () => {
    const unregister = ctx.investmentPythonRuntime.register(industryChainBackend(config))
    let lease: PythonBackendLease | undefined
    const disposeResources = async (): Promise<void> => {
      try {
        await lease?.release()
      } finally {
        unregister()
      }
    }
    try {
      lease = await ctx.investmentPythonRuntime.acquire('industry-chain')
      return disposeResources
    } catch (error) {
      await disposeResources()
      throw error
    }
  }, 'investment industry-chain runtime lifecycle')
}
