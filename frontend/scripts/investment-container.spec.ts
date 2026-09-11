import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertConfiguredPluginResolution,
  configuredPluginNames,
  createContainerAppPlan,
} from './build-investment-container-app.ts'

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(frontendDir, '..')
const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(async root => rm(root, { force: true, recursive: true })))
})

interface EntrypointModule {
  acquireInstanceLock(root: string): Promise<{ release(): Promise<void> }>
  validateConfiguration(environment: Record<string, string | undefined>): { port: number; timezone: string }
}

interface HealthcheckModule {
  checkReadiness(): Promise<void>
}

async function containerModule<T>(name: string): Promise<T> {
  return await import(pathToFileURL(join(repoRoot, 'containers', name)).href) as T
}

describe('investment container delivery contract', () => {
  it('pins the Linux Python archive and exact requirements content', async () => {
    const lock = JSON.parse(await readFile(join(frontendDir, 'config', 'investment-python-runtime-lock.json'), 'utf8')) as {
      targets: Record<string, { archiveSha256: string; archiveUrl: string; requirementsLock: string; requirementsSha256: string }>
    }
    const linux = lock.targets['linux-x64']!
    const requirements = await readFile(join(repoRoot, ...linux.requirementsLock.split('/')))

    expect(linux.archiveUrl).toContain('cpython-3.10.20%2B20260718-x86_64-unknown-linux-gnu-install_only.tar.gz')
    expect(linux.archiveSha256).toBe('9c28d8017eeaf692f24dbaf26fd4679ce496c7f58e48b897d278739661794e37')
    expect(createHash('sha256').update(requirements).digest('hex')).toBe(linux.requirementsSha256)
    expect(requirements.toString('utf8')).not.toMatch(/^pyobjc-/mu)
  })

  it('assembles a relocatable production CLI deployment', () => {
    const output = resolve('/opt/dsh')
    const plan = createContainerAppPlan('/tmp/dsh-container-build', output)

    expect(plan.args).toEqual([
      '--filter', '@deepseek-ai/dsh', 'deploy', '--prod', '--legacy', plan.stagingDir,
    ])
    expect(plan.appSourceDir).toBe(join(plan.workspaceDir, 'apps', 'cli'))
    expect(plan.output).toBe(output)
  })

  it('validates every plugin named by the actual profile from its Loader anchor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-container-plugin-'))
    roots.push(root)
    const profileDir = join(root, 'profiles', 'investment-research')
    const packageRoot = join(root, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-example')
    const profileAnchor = join(profileDir, 'cordis.yml')
    await mkdir(packageRoot, { recursive: true })
    await mkdir(profileDir, { recursive: true })
    await writeFile(profileAnchor, '[]\n')
    await writeFile(join(packageRoot, 'package.json'), '{"name":"@deepseek-ai/dsh-example","main":"index.js"}\n')
    await writeFile(join(packageRoot, 'index.js'), 'export default {}\n')

    const names = configuredPluginNames(`
- id: example
  name: '@deepseek-ai/dsh-example'
- id: example-subpath
  name: "@deepseek-ai/dsh-example/index.js"
`)

    expect(names).toEqual(['@deepseek-ai/dsh-example', '@deepseek-ai/dsh-example/index.js'])
    expect(() => { assertConfiguredPluginResolution(profileAnchor, names) }).not.toThrow()
  })

  it('fails packaging when a configured plugin is absent from the production deployment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-container-missing-plugin-'))
    roots.push(root)
    const profileAnchor = join(root, 'profiles', 'investment-research', 'cordis.yml')
    await mkdir(dirname(profileAnchor), { recursive: true })
    await writeFile(profileAnchor, '[]\n')

    expect(() => { assertConfiguredPluginResolution(profileAnchor, ['@deepseek-ai/dsh-missing']) })
      .toThrow(/configured plugin cannot be resolved/u)
  })

  it('builds once and keeps the runtime image non-root and dependency-install free', async () => {
    const dockerfile = await readFile(join(repoRoot, 'Dockerfile'), 'utf8')
    const dockerignore = await readFile(join(repoRoot, '.dockerignore'), 'utf8')

    const pinnedBase = 'node:24.8.0-bookworm-slim@sha256:81a8fcfa2aa85bc07d22d9ddff227d0a52cfc3b08e571a21b16efc9153842106'
    const sidecarBuild = 'RUN CI=true pnpm run investment:sidecar:build --target linux-x64'
    const applicationDeploy = 'RUN node --import tsx/esm scripts/build-investment-container-app.ts'
    expect(dockerfile).toContain(`FROM ${pinnedBase} AS build`)
    expect(dockerfile).toContain('pnpm install --frozen-lockfile')
    expect(dockerfile).toContain(sidecarBuild)
    expect(dockerfile).toContain(applicationDeploy)
    expect(dockerfile.indexOf(sidecarBuild)).toBeLessThan(dockerfile.indexOf(applicationDeploy))
    expect(dockerfile).not.toContain('confirmModulesPurge=false')
    expect(dockerfile).not.toMatch(/^ENV CI=/mu)
    expect(dockerfile).toContain(`FROM ${pinnedBase} AS runtime`)
    expect(dockerfile).toMatch(/^USER dsh$/mu)
    expect(dockerfile).toContain('install -d -m 0700 -o dsh -g dsh /var/lib/dsh')
    expect(dockerfile).toContain('ENTRYPOINT ["/opt/container/investment-entrypoint.mjs"]')
    expect(dockerfile).not.toContain('ln -s /opt/container/investment-entrypoint.mjs')
    expect(dockerfile).toContain('org.opencontainers.image.revision="$VCS_REF"')
    expect(dockerfile.split(`FROM ${pinnedBase} AS runtime`)[1]).not.toMatch(/pnpm install|pip install/u)
    expect(dockerignore).toMatch(/^\.git$/mu)
    expect(dockerignore).toMatch(/^\.env\*$/mu)
    expect(dockerignore).toMatch(/^\*\*\/\.npmrc$/mu)
    expect(dockerignore).toMatch(/^!frontend\/\.npmrc$/mu)
    expect(dockerignore).toMatch(/^\*\*\/\.netrc$/mu)
    expect(dockerignore).toMatch(/^\*\*\/\.pypirc$/mu)
    expect(dockerignore).toMatch(/^\*\*\/node_modules$/mu)
  })

  it('publishes only the authenticated web edge and mounts one persistent state root', async () => {
    const compose = load(await readFile(join(repoRoot, 'compose.yaml'), 'utf8')) as {
      services: Record<string, Record<string, unknown>>
      volumes: Record<string, unknown>
    }
    const service = compose.services.investment!

    expect(service.ports).toEqual(['127.0.0.1:${PORT:-3080}:${PORT:-3080}'])
    expect(service.expose).toBeUndefined()
    expect(service.read_only).toBe(true)
    expect(service.init).toBe(true)
    expect(service.environment).toEqual(expect.objectContaining({
      DSH_HOME: '/var/lib/dsh',
      DSH_WEB_AUTH: 'required',
      DSH_WEB_INSECURE_COOKIES: '0',
    }))
    expect(service.volumes).toContain('dsh-data:/var/lib/dsh')
    expect(service.secrets).toContain('web-admin-password-hash')
    expect(service.healthcheck).toEqual(expect.objectContaining({
      test: ['CMD', 'node', '/opt/container/investment-healthcheck.mjs'],
    }))
    expect(compose.volumes).toHaveProperty('dsh-data')
  })

  it('exports the verified commit image without publishing it', async () => {
    const workflow = await readFile(join(repoRoot, '.github', 'workflows', 'investment-container.yml'), 'utf8')

    expect(load(workflow)).toBeTypeOf('object')
    expect(workflow).toContain('pa-investment-research:${{ github.sha }}')
    expect(workflow).toContain('docker compose up -d --no-build')
    expect(workflow).toContain('container_id=$(docker compose ps -aq investment)')
    expect(workflow).toContain("'status={{.State.Status}} exitCode={{.State.ExitCode}} error={{json .State.Error}}")
    expect(workflow).toContain('docker logs "$failed_container_id"')
    expect(workflow).toContain('container-lock=present')
    expect(workflow).toContain('application-lock=present')
    expect(workflow).toContain('test "$(docker inspect --format \'{{.State.Status}}\' "$container_id")" = running')
    expect(workflow).toContain('docker save "$IMAGE"')
    expect(workflow).toContain('investment-container-build.json')
    expect(workflow).toContain('sudo chmod 0400 "$DSH_WEB_ADMIN_PASSWORD_HASH_FILE"')
    expect(workflow).toContain('test "$exit_code" = 0')
    expect(workflow).toContain('test ! -e /state/investment-research/.container-instance.lock')
    expect(workflow).toContain("-H 'Host: investment.test:39080'")
    expect(workflow).not.toContain('chmod 0644')
    expect(workflow).not.toContain('test "$exit_code" = 0 || test "$exit_code" = 143')
    expect(workflow).not.toMatch(/(?:^|\s)--push(?:\s|$)/mu)
  })

  it('fails closed for inconsistent timezone or missing remote-auth inputs', async () => {
    const entrypoint = await containerModule<EntrypointModule>('investment-entrypoint.mjs')
    const valid = {
      DSH_HOME: '/var/lib/dsh',
      DSH_WEB_ADMIN_PASSWORD_HASH_SOURCE_FILE: '/run/secrets/web-admin-password-hash',
      DSH_WEB_ADMIN_USERNAME: 'admin',
      DSH_WEB_AUTH: 'required',
      DSH_WEB_TRUSTED_HOSTS: 'research.example.test',
      DSH_WEB_TRUSTED_PROXIES: '172.20.0.1',
      PORT: '3080',
      TIMEZONE: 'Asia/Shanghai',
      TZ: 'Asia/Shanghai',
    }

    expect(entrypoint.validateConfiguration(valid)).toEqual(expect.objectContaining({ port: 3080, timezone: 'Asia/Shanghai' }))
    expect(() => entrypoint.validateConfiguration({ ...valid, TIMEZONE: 'UTC' })).toThrow(/TZ and TIMEZONE/u)
    expect(() => entrypoint.validateConfiguration({ ...valid, TZ: 'Mars/Olympus', TIMEZONE: 'Mars/Olympus' })).toThrow(/IANA/u)
    expect(() => entrypoint.validateConfiguration({ ...valid, DSH_WEB_AUTH: 'optional' })).toThrow(/DSH_WEB_AUTH/u)
    expect(() => entrypoint.validateConfiguration({ ...valid, DSH_WEB_TRUSTED_PROXIES: '' })).toThrow(/DSH_WEB_TRUSTED_PROXIES/u)
  })

  it('allows only one live owner for a persistent volume lock', async () => {
    const entrypoint = await containerModule<EntrypointModule>('investment-entrypoint.mjs')
    const root = await mkdtemp(join(tmpdir(), 'dsh-container-lock-'))
    roots.push(root)

    const first = await entrypoint.acquireInstanceLock(root)
    await expect(entrypoint.acquireInstanceLock(root)).rejects.toThrow(/already owns/u)
    await first.release()
    const second = await entrypoint.acquireInstanceLock(root)
    await second.release()
  })

  it('replaces only an expired volume lease', async () => {
    const entrypoint = await containerModule<EntrypointModule>('investment-entrypoint.mjs')
    const root = await mkdtemp(join(tmpdir(), 'dsh-container-stale-lock-'))
    roots.push(root)
    const lockDir = join(root, '.container-instance.lock')
    const ownerPath = join(lockDir, 'owner.json')
    await mkdir(lockDir)
    await writeFile(ownerPath, `${JSON.stringify({ version: 1, token: 'stale-owner-token', pid: 9 })}\n`)
    const expired = new Date(Date.now() - 60_000)
    await utimes(ownerPath, expired, expired)

    const lease = await entrypoint.acquireInstanceLock(root)
    await lease.release()
  })

  it('requires all four runtime services to be ready', async () => {
    const payloads = new Map([
      ['web', { status: 'ok' }],
      ['trading-core', { status: 'ok', service: 'trading-core' }],
      ['market-watch', { ok: true, service: 'market-watch' }],
      ['industry-chain', { ok: true, service: 'industry-chain' }],
    ])
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const name = url.includes('8000') ? 'trading-core'
        : url.includes('8100') ? 'market-watch'
          : url.includes('8200') ? 'industry-chain' : 'web'
      return new Response(JSON.stringify(payloads.get(name)), {
        headers: { 'content-type': 'application/json' }, status: 200,
      })
    }))
    const healthcheck = await containerModule<HealthcheckModule>('investment-healthcheck.mjs')

    await expect(healthcheck.checkReadiness()).resolves.toBeUndefined()
    payloads.set('market-watch', { ok: false, service: 'market-watch' })
    await expect(healthcheck.checkReadiness()).rejects.toThrow(/market-watch/u)
  })
})
