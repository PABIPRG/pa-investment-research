#!/usr/bin/env node
/**
 * dsh — command-line entry. Dynamic imports per mode keep unrelated modes out
 * of each dispatch path; the adapter prints and exits for
 * `--help`/`--version`/a parse error, so only a valid mode reaches the switch.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { parseDshArgs } from './args.ts'

// Both the source tree (apps/cli/src) and the bundled bin (apps/cli/lib) sit
// one directory under apps/cli, so the checked-in manifest resolves with the
// same relative hop from either artifact.
/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

const invocation = parseDshArgs(process.argv.slice(2), readVersion())

function investmentConflictOwner(error: unknown): { mode: 'web' | 'electron'; pid: number } | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error) || !('owner' in error)) return undefined
  if (error.code !== 'DSH_INVESTMENT_INSTANCE_CONFLICT') return undefined
  const owner = error.owner
  if (typeof owner !== 'object' || owner === null || !('mode' in owner) || !('pid' in owner)) return undefined
  if ((owner.mode !== 'web' && owner.mode !== 'electron') || typeof owner.pid !== 'number') return undefined
  return { mode: owner.mode, pid: owner.pid }
}

switch (invocation.mode) {
  case 'electron': {
    const { runElectronApplication } = await import('./electron.ts')
    process.exit(await runElectronApplication({ profile: invocation.profile }))
    break
  }
  case 'profile': {
    const { runProfile } = await import('./profile-boot.ts')
    const investmentProduct = invocation.profile === 'investment-research'
    const instanceOptions = investmentProduct
      ? {
        instanceMode: 'web' as const,
        onInstanceConflict: (await import('./investment-instance-prompt.ts')).confirmInvestmentInstanceReplacement,
      }
      : {}
    try {
      await runProfile({
        environment: loadLayeredEnv('dsh'),
        profile: invocation.profile,
        patchFiles: invocation.patches,
        args: invocation.args,
        ...instanceOptions,
      })
    } catch (error) {
      const owner = investmentConflictOwner(error)
      if (owner === undefined) throw error
      const surface = owner.mode === 'web' ? 'Web 版' : 'Electron 版'
      if (process.stdin.isTTY && process.stderr.isTTY) {
        process.stderr.write(`\n已取消启动，现有${surface}投研继续运行。\n`)
      } else {
        process.stderr.write(
          `检测到${surface}投研正在运行（PID ${String(owner.pid)}）。`
          + '请先关闭旧实例，或在交互终端中确认替换。\n',
        )
        process.exitCode = 1
      }
    }
    break
  }
  case 'plugin': {
    const { runPlugin } = await import('./plugin.ts')
    process.exit(runPlugin(invocation.profile, invocation.args))
    break
  }
  case 'dump-config': {
    const { runDumpConfig } = await import('./dump-config.ts')
    runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches)
    break
  }
  default:
    invocation satisfies never
    throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
}
