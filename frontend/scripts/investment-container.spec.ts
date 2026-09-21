import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shouldWatchProfilePatches } from '../apps/cli/src/profile-boot.ts'
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
  validateConfiguration(environment: Record<string, string | undefined>): {
    deploymentSurface: 'cloud-web'
    port: number
    timezone: string
  }
}

interface HealthcheckModule {
  checkReadiness(): Promise<void>
}

interface ContainerCheckModule {
  assertNoBrokenSymlinks(roots: string[]): Promise<void>
  lockState(root: string): Promise<{ application: boolean; container: boolean }>
}

async function containerModule<T>(name: string): Promise<T> {
  return await import(pathToFileURL(join(repoRoot, 'containers', name)).href) as T
}

describe('investment container delivery contract', () => {
  it('pins every Python requirement source and target lock', async () => {
    const lock = JSON.parse(await readFile(join(frontendDir, 'config', 'investment-python-runtime-lock.json'), 'utf8')) as {
      requirements: Record<string, string>
      targets: Record<string, { archiveSha256: string; archiveUrl: string; requirementsLock: string; requirementsSha256: string }>
    }
    for (const [path, expected] of Object.entries(lock.requirements)) {
      const source = await readFile(join(repoRoot, ...path.split('/')))
      expect(createHash('sha256').update(source).digest('hex'), path).toBe(expected)
    }
    for (const [target, targetLock] of Object.entries(lock.targets)) {
      const requirements = await readFile(join(repoRoot, ...targetLock.requirementsLock.split('/')))
      expect(createHash('sha256').update(requirements).digest('hex'), target).toBe(targetLock.requirementsSha256)
    }
    const linux = lock.targets['linux-x64']!
    const requirements = await readFile(join(repoRoot, ...linux.requirementsLock.split('/')))

    expect(linux.archiveUrl).toContain('cpython-3.10.20%2B20260718-x86_64-unknown-linux-gnu-install_only.tar.gz')
    expect(linux.archiveSha256).toBe('9c28d8017eeaf692f24dbaf26fd4679ce496c7f58e48b897d278739661794e37')
    expect(requirements.toString('utf8')).not.toMatch(/^pyobjc-/mu)
    for (const omitted of [
      'bcrypt', 'build', 'chromadb', 'coloredlogs', 'durationpy', 'filelock', 'flatbuffers', 'fsspec',
      'googleapis-common-protos', 'grpcio', 'hf-xet', 'huggingface_hub', 'humanfriendly',
      'importlib_resources', 'jsonschema', 'jsonschema-specifications', 'kubernetes', 'mmh3', 'mpmath',
      'oauthlib', 'onnxruntime', 'opentelemetry-api', 'opentelemetry-exporter-otlp-proto-common',
      'opentelemetry-exporter-otlp-proto-grpc', 'opentelemetry-proto', 'opentelemetry-sdk',
      'opentelemetry-semantic-conventions', 'overrides', 'pybase64', 'pydantic-settings', 'PyPika',
      'pyproject_hooks', 'referencing', 'requests-oauthlib', 'rpds-py', 'sympy', 'tokenizers',
    ]) {
      expect(requirements.toString('utf8')).not.toMatch(new RegExp(`^${omitted}==`, 'mu'))
    }
    for (const target of ['darwin-arm64', 'win32-x64'] as const) {
      const desktopRequirements = await readFile(
        join(repoRoot, ...lock.targets[target]!.requirementsLock.split('/')),
        'utf8',
      )
      expect(desktopRequirements).toMatch(/^chromadb==1\.5\.9$/mu)
    }
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

    const pinnedBuildBase = 'node:24.21.0-trixie-slim@sha256:b64fccfbcd1ae10d11b969a868b50e1c2530a7054813d5cdea04ac3bce551697'
    const pinnedRuntimeBase = 'gcr.io/distroless/nodejs24-debian13:nonroot@sha256:4ac45c93b6c4b2304876569196e5962e55e8ba4ba095e7dde7bf6d7e00efc3b8'
    const sidecarBuild = 'RUN CI=true pnpm run investment:sidecar:build --target linux-x64'
    const applicationDeploy = 'RUN node --import tsx/esm scripts/build-investment-container-app.ts'
    expect(dockerfile).toContain(`FROM ${pinnedBuildBase} AS build`)
    expect(dockerfile).toContain('pnpm install --frozen-lockfile')
    expect(dockerfile).toContain(sidecarBuild)
    expect(dockerfile).toContain(applicationDeploy)
    expect(dockerfile.indexOf(sidecarBuild)).toBeLessThan(dockerfile.indexOf(applicationDeploy))
    expect(dockerfile).not.toContain('confirmModulesPurge=false')
    expect(dockerfile).not.toMatch(/^ENV CI=/mu)
    expect(dockerfile).toContain(`FROM ${pinnedRuntimeBase} AS runtime`)
    expect(dockerfile).toMatch(/^USER 10001:10001$/mu)
    expect(dockerfile).toMatch(/^\s+HOME=\/var\/lib\/dsh \\/mu)
    expect(dockerfile).toContain('install -d -m 0700 -o 10001 -g 10001 /opt/runtime-root/var/lib/dsh')
    expect(dockerfile).toContain('ENTRYPOINT ["/nodejs/bin/node", "/opt/container/investment-entrypoint.mjs"]')
    expect(dockerfile).not.toContain('ln -s /opt/container/investment-entrypoint.mjs')
    expect(dockerfile).toContain('org.opencontainers.image.revision="$VCS_REF"')
    expect(dockerfile.split(`FROM ${pinnedRuntimeBase} AS runtime`)[1]).not.toMatch(/^RUN |pnpm install|pip install/mu)
    expect(dockerfile).not.toContain('AS npm-release')
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
      DSH_DEPLOYMENT_SURFACE: 'cloud-web',
      DSH_WEB_AUTH: 'required',
      DSH_WEB_INSECURE_COOKIES: '0',
    }))
    expect(service.volumes).toContain('dsh-data:/var/lib/dsh')
    expect(service.secrets).toContain('web-admin-password-hash')
    expect(service.healthcheck).toEqual(expect.objectContaining({
      test: ['CMD', '/nodejs/bin/node', '/opt/container/investment-healthcheck.mjs'],
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
    expect(workflow).toContain('investment-container-check.mjs state')
    expect(workflow).toContain('test "$(docker inspect --format \'{{.State.Status}}\' "$container_id")" = running')
    expect(workflow).toContain('docker save "$IMAGE"')
    expect(workflow).toContain('investment-container-build.json')
    expect(workflow).toContain('sudo chmod 0400 "$DSH_WEB_ADMIN_PASSWORD_HASH_FILE"')
    expect(workflow).toContain('test "$exit_code" = 0')
    expect(workflow).toContain('investment-container-check.mjs state-clean')
    expect(workflow).toContain('/opt/container/investment-container-check.mjs')
    expect(workflow).toContain('--entrypoint /nodejs/bin/node "$IMAGE" --version')
    expect(workflow).not.toContain('--entrypoint sh')
    expect(workflow).toContain("-H 'Host: investment.test:39080'")
    expect(workflow).not.toContain('chmod 0644')
    expect(workflow).not.toContain('test "$exit_code" = 0 || test "$exit_code" = 143')
    expect(workflow).not.toMatch(/(?:^|\s)--push(?:\s|$)/mu)
  })

  it('blocks all image uploads and publication until the exact archive passes security checks', async () => {
    const workflow = await readFile(join(repoRoot, '.github/workflows/investment-container.yml'), 'utf8')
    const parsed = load(workflow) as { jobs: Record<string, {
      needs?: string
      steps: { name?: string; uses?: string; run?: string; if?: string; 'continue-on-error'?: boolean }[]
    }> }
    const smoke = parsed.jobs['image-smoke']!
    const scanIndex = smoke.steps.findIndex(step => step.run?.includes('image_security.py scan'))
    expect(scanIndex).toBeGreaterThan(0)
    expect(smoke.steps[scanIndex]?.if).toBeUndefined()
    expect(smoke.steps[scanIndex]?.['continue-on-error']).toBeUndefined()
    for (const [index, step] of smoke.steps.entries()) {
      if (step.uses?.includes('upload-artifact')) expect(index).toBeGreaterThan(scanIndex)
      expect(step.run ?? '').not.toContain('--cache-to')
    }
    expect(parsed.jobs.publish?.needs).toBe('image-smoke')
    const publish = parsed.jobs.publish!.steps
    const verifyIndex = publish.findIndex(step => step.run?.includes('image_security.py verify'))
    const loginIndex = publish.findIndex(step => step.uses?.includes('docker/login-action'))
    expect(verifyIndex).toBeGreaterThan(0)
    expect(verifyIndex).toBeLessThan(loginIndex)
    expect(workflow).toContain('investment-container.security.json')
  })

  it('fails closed for an invalid deployment surface, timezone, or remote-auth input', async () => {
    const entrypoint = await containerModule<EntrypointModule>('investment-entrypoint.mjs')
    const valid = {
      DSH_HOME: '/var/lib/dsh',
      DSH_DEPLOYMENT_SURFACE: 'cloud-web',
      DSH_WEB_ADMIN_PASSWORD_HASH_SOURCE_FILE: '/run/secrets/web-admin-password-hash',
      DSH_WEB_ADMIN_USERNAME: 'admin',
      DSH_WEB_AUTH: 'required',
      DSH_WEB_TRUSTED_HOSTS: 'research.example.test',
      DSH_WEB_TRUSTED_PROXIES: '172.20.0.1',
      PORT: '3080',
      TIMEZONE: 'Asia/Shanghai',
      TZ: 'Asia/Shanghai',
    }

    expect(entrypoint.validateConfiguration(valid)).toEqual(expect.objectContaining({
      deploymentSurface: 'cloud-web',
      port: 3080,
      timezone: 'Asia/Shanghai',
    }))
    expect(() => entrypoint.validateConfiguration({ ...valid, DSH_DEPLOYMENT_SURFACE: undefined }))
      .toThrow(/DSH_DEPLOYMENT_SURFACE must be exactly cloud-web/u)
    expect(() => entrypoint.validateConfiguration({ ...valid, DSH_DEPLOYMENT_SURFACE: 'local-web' }))
      .toThrow(/DSH_DEPLOYMENT_SURFACE must be exactly cloud-web/u)
    expect(() => entrypoint.validateConfiguration({ ...valid, DSH_DEPLOYMENT_SURFACE: ' cloud-web ' }))
      .toThrow(/DSH_DEPLOYMENT_SURFACE must be exactly cloud-web/u)
    expect(() => entrypoint.validateConfiguration({ ...valid, TIMEZONE: 'UTC' })).toThrow(/TZ and TIMEZONE/u)
    expect(() => entrypoint.validateConfiguration({ ...valid, TZ: 'Mars/Olympus', TIMEZONE: 'Mars/Olympus' })).toThrow(/IANA/u)
    expect(() => entrypoint.validateConfiguration({ ...valid, DSH_WEB_AUTH: 'optional' })).toThrow(/DSH_WEB_AUTH/u)
    expect(() => entrypoint.validateConfiguration({ ...valid, DSH_WEB_TRUSTED_PROXIES: '' })).toThrow(/DSH_WEB_TRUSTED_PROXIES/u)

    const entrypointSource = await readFile(join(repoRoot, 'containers', 'investment-entrypoint.mjs'), 'utf8')
    expect(entrypointSource.indexOf('validateConfiguration(process.env)'))
      .toBeLessThan(entrypointSource.indexOf('acquireInstanceLock(join(configuration.dshHome'))
    expect(entrypointSource).toMatch(
      /env:\s*\{\s*\.\.\.process\.env,\s*DSH_DEPLOYMENT_SURFACE: configuration\.deploymentSurface,/u,
    )
  })

  it('checks distroless runtime trees and volume lock state without a shell', async () => {
    const check = await containerModule<ContainerCheckModule>('investment-container-check.mjs')
    const root = await mkdtemp(join(tmpdir(), 'investment-container-check-'))
    roots.push(root)
    const runtime = join(root, 'runtime')
    const state = join(root, 'state')
    await mkdir(join(runtime, 'nested'), { recursive: true })
    await writeFile(join(runtime, 'nested', 'module.js'), 'export default true\n')
    await expect(check.assertNoBrokenSymlinks([runtime])).resolves.toBeUndefined()
    await symlink(join(runtime, 'nested', 'module.js'), join(runtime, 'linked.js'))
    await expect(check.assertNoBrokenSymlinks([runtime])).resolves.toBeUndefined()
    await symlink(join(runtime, 'nested', 'missing.js'), join(runtime, 'broken.js'))
    await expect(check.assertNoBrokenSymlinks([runtime])).rejects.toThrow(/broken symbolic link/u)

    expect(await check.lockState(state)).toEqual({ application: false, container: false })
    await mkdir(join(state, 'investment-research', '.container-instance.lock'), { recursive: true })
    expect(await check.lockState(state)).toEqual({ application: false, container: true })
  })

  it('never mounts profile-file HMR inside the container runtime', () => {
    expect(shouldWatchProfilePatches({ containerLeaseFile: '/state/.container-instance.lock/owner.json' })).toBe(false)
    expect(shouldWatchProfilePatches({
      containerLeaseFile: '/state/.container-instance.lock/owner.json',
      watchPatches: true,
    })).toBe(false)
    expect(shouldWatchProfilePatches({})).toBe(true)
    expect(shouldWatchProfilePatches({ watchPatches: false })).toBe(false)
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
