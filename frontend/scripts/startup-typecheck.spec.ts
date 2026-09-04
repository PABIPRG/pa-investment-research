import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { startupProjectConfigs } from './startup-typecheck.ts'

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-startup-typecheck-'))
  temporaryRoots.push(root)
  return root
}

function writeApp(root: string, name: string, withTsconfig = true): void {
  const directory = join(root, 'apps', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}` }))
  if (withTsconfig) writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ files: [] }))
}

describe('startup TypeScript project discovery', () => {
  it('discovers every app project instead of relying on a handwritten allowlist', () => {
    const root = temporaryWorkspace()
    writeApp(root, 'cli')
    writeApp(root, 'electron')
    writeApp(root, 'future-startup')

    expect(startupProjectConfigs(root)).toEqual([
      'apps/cli/tsconfig.json',
      'apps/electron/tsconfig.json',
      'apps/future-startup/tsconfig.json',
    ])
  })

  it('fails closed when a new app has no TypeScript project', () => {
    const root = temporaryWorkspace()
    writeApp(root, 'untyped-startup', false)

    expect(() => startupProjectConfigs(root)).toThrow(
      'apps/untyped-startup/package.json has no sibling tsconfig.json',
    )
  })

  it('covers every current startup application', () => {
    expect(startupProjectConfigs(frontendRoot)).toEqual([
      'apps/cli/tsconfig.json',
      'apps/electron/tsconfig.json',
      'apps/web/tsconfig.json',
    ])
  })
})

describe('startup typecheck gate wiring', () => {
  it('uses the same package command in pre-push and an independent CI job', () => {
    const manifest = JSON.parse(readFileSync(join(frontendRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const lefthook = readFileSync(join(frontendRoot, 'lefthook.yml'), 'utf8')
    const workflow = readFileSync(join(frontendRoot, '..', '.github', 'workflows', 'investment-ci.yml'), 'utf8')

    expect(manifest.scripts?.['typecheck:startup']).toBe('tsx scripts/startup-typecheck.ts')
    expect(manifest.scripts?.['start:electron']).toBe(
      'pnpm run build && pnpm --filter @deepseek-ai/dsh-electron run start',
    )
    expect(lefthook).toMatch(/pre-push:[\s\S]*?run: pnpm run typecheck:startup/)
    expect(workflow).toMatch(/startup-typecheck:\n[\s\S]*?run: pnpm run typecheck:startup/)
  })
})
