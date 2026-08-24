/** Electron packaging keeps the Python sidecar outside the application staging tree. */

import { isAbsolute, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import forgeConfig from '../forge.config.ts'
import {
  createPackagerOptions,
  createPackagingPlan,
} from '../src/packaging.ts'

describe('Electron investment sidecar packaging', () => {
  it('deploys before building the current platform sidecar in isolated temporary paths', () => {
    const plan = createPackagingPlan('/tmp/dsh-electron-test', 'win32', 'x64')

    expect(plan.deploy.args).toEqual([
      '--filter',
      '@deepseek-ai/dsh-electron',
      'deploy',
      '--prod',
      '--legacy',
      plan.stagingDir,
    ])
    expect(plan.sidecar.args).toEqual([
      '--workspace-root',
      'run',
      'investment:sidecar:build',
      '--',
      '--target',
      'win32-x64',
      '--output',
      plan.sidecarDir,
      '--cache',
      plan.sidecarCacheDir,
    ])
    expect(isAbsolute(plan.sidecarDir)).toBe(true)
    expect(relative(plan.stagingDir, plan.sidecarDir)).toMatch(/^\.\./)
    expect(relative(plan.stagingDir, plan.sidecarCacheDir)).toMatch(/^\.\./)
  })

  it('copies the built directory as Resources/investment-python', () => {
    const plan = createPackagingPlan('/tmp/dsh-electron-test', 'darwin', 'arm64')
    const options = createPackagerOptions({
      arch: 'arm64',
      electronVersion: '43.2.0',
      electronZipDir: '/tmp/electron',
      outDir: '/tmp/out',
      platform: 'darwin',
      sidecarDir: plan.sidecarDir,
      stagingDir: plan.stagingDir,
    })

    expect(options).toEqual(expect.objectContaining({
      dir: plan.stagingDir,
      extraResource: [plan.sidecarDir],
    }))
  })

  it('keeps sidecar outputs and caches out of ordinary Forge staging', () => {
    const ignore = forgeConfig.packagerConfig?.ignore

    expect(ignore).toEqual(expect.arrayContaining([expect.any(RegExp)]))
    expect((ignore as RegExp[]).some(pattern => pattern.test('/investment-python/runtime.json'))).toBe(true)
    expect((ignore as RegExp[]).some(pattern => pattern.test('/.cache/investment-python/archive'))).toBe(true)
  })
})
