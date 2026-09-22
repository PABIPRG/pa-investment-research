import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('从发布文件加载真实网关，不依赖源码别名或 TypeScript loader', () => {
  const packageDir = fileURLToPath(new URL('..', import.meta.url))
  const manifestPath = resolve(packageDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: string[] }
  // 放在所属包下以复用 pnpm 的真实依赖链接；不复制 src。
  const staged = mkdtempSync(resolve(packageDir, '.observatory-built-'))
  try {
    copyFileSync(manifestPath, resolve(staged, 'package.json'))
    for (const pattern of manifest.files) {
      for (const path of globSync(pattern, { cwd: packageDir })) {
        const target = resolve(staged, path)
        mkdirSync(dirname(target), { recursive: true })
        cpSync(resolve(packageDir, path), target, { recursive: true })
      }
    }
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import * as gateway from '@deepseek-ai/dsh-host-public-observatory'
      assert.equal(gateway.name, 'host-public-observatory')
      assert.equal(typeof gateway.apply, 'function')
      assert.equal(typeof gateway.handlePublicObservatoryRequest, 'function')
      assert.ok(gateway.Config)
      assert.equal('default' in gateway, false)
      console.log('built-observatory-ok')
    `], { cwd: staged, encoding: 'utf8', timeout: 20_000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('built-observatory-ok')
  } finally {
    rmSync(staged, { recursive: true, force: true })
  }
})
