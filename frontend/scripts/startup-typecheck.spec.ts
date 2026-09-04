import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  prepareStartupTypeContracts,
  startupContractPackages,
  startupProjectConfigs,
  writeStartupTypeContracts,
} from './startup-typecheck.ts'

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

function writePackage(root: string, group: string, name: string, remote: boolean): void {
  const directory = join(root, 'packages', group, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: `@deepseek-ai/dsh-${name}`,
    exports: remote ? { './remote': { types: './lib/typert.remote-client.d.ts' } } : {},
  }))
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

describe('startup Typert contract preparation', () => {
  it('discovers every remote contract producer from package manifests', () => {
    const root = temporaryWorkspace()
    writePackage(root, 'domain', 'commands', true)
    writePackage(root, 'domain', 'ordinary', false)
    writePackage(root, 'future', 'new-remote', true)

    expect(startupContractPackages(root)).toEqual([
      '@deepseek-ai/dsh-commands',
      '@deepseek-ai/dsh-new-remote',
    ])
  })

  it('writes declarations required by type checking without emitting runtime bundles', () => {
    const root = temporaryWorkspace()
    writeStartupTypeContracts(root, [{
      package: '@deepseek-ai/dsh-commands',
      packageRoot: 'packages/domain/commands',
      face: 'host',
      exports: [],
      js: 'runtime host bundle',
      dts: 'export declare const host: true\n',
      remote: {
        js: 'runtime remote bundle',
        dts: 'export declare const remote: true\n',
        dtsMap: '{"version":3}\n',
      },
    }])

    const output = join(root, 'packages/domain/commands/lib')
    expect(readFileSync(join(output, 'typert.host.d.ts'), 'utf8')).toContain('host: true')
    expect(readFileSync(join(output, 'typert.remote-client.d.ts'), 'utf8')).toContain('remote: true')
    expect(readFileSync(join(output, 'typert.remote-client.d.ts.map'), 'utf8')).toContain('"version":3')
    expect(() => readFileSync(join(output, 'typert.host.js'), 'utf8')).toThrow()
    expect(() => readFileSync(join(output, 'typert.remote-client.js'), 'utf8')).toThrow()
  })

  it('reuses unchanged contracts and invalidates them when source inputs change', () => {
    const root = temporaryWorkspace()
    writePackage(root, 'domain', 'commands', true)
    const source = join(root, 'packages/domain/commands/src/index.ts')
    mkdirSync(dirname(source), { recursive: true })
    writeFileSync(source, 'export const version = 1\n')
    let generations = 0
    const generate = () => {
      generations += 1
      return [{
        package: '@deepseek-ai/dsh-commands',
        packageRoot: 'packages/domain/commands',
        face: 'host' as const,
        exports: [],
        js: '',
        dts: 'export declare const host: true\n',
        remote: { js: '', dts: 'export declare const remote: true\n', dtsMap: '{}\n' },
      }]
    }

    prepareStartupTypeContracts(root, generate)
    prepareStartupTypeContracts(root, generate)
    expect(generations).toBe(1)

    writeFileSync(source, 'export const version = 2\n')
    prepareStartupTypeContracts(root, generate)
    expect(generations).toBe(2)
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
