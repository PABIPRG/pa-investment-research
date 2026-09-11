import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  createInvestmentReleasePlan,
  investmentReleaseAssetName,
  stageInvestmentReleaseAsset,
} from './investment-release.js'

const frontendRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(frontendRoot, '..')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function loadWorkflow(name: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(repositoryRoot, '.github/workflows', name), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${name} must contain a workflow object`)
  return workflow
}

describe('investment release contract', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567'

  it('stages through the workflow Node entrypoint without development dependencies', () => {
    const workflow = loadWorkflow('investment-release.yml')
    const jobs = workflow.jobs as Record<string, { steps: { name?: string; run?: string }[] }>
    const command = jobs.build!.steps.find(step => step.name === 'Stage immutable release asset')!.run!
    expect(command).toMatch(/^node scripts\/investment-release\.ts stage/)
    const fixture = mkdtempSync(resolve(tmpdir(), 'release-no-deps-'))
    try {
      writeFileSync(resolve(fixture, 'release.ts'), readFileSync(resolve(frontendRoot, 'scripts/investment-release.ts')))
      mkdirSync(resolve(fixture, 'make'))
      writeFileSync(resolve(fixture, 'make/package.zip'), 'zip fixture')
      const result = spawnSync(process.execPath, ['release.ts', 'stage', '--version', '0.1.0-rc.11',
        '--target', 'darwin-arm64', '--source-root', 'make', '--destination-root', 'assets'], {
        cwd: fixture, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' },
      })
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(readFileSync(resolve(fixture, 'assets/investment-agent-0.1.0-rc.11-darwin-arm64.zip'), 'utf8')).toBe('zip fixture')
    } finally { rmSync(fixture, { recursive: true, force: true }) }
  })

  it('skips CI hooks before resolving missing development dependencies', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'hooks-no-deps-'))
    try {
      writeFileSync(resolve(fixture, 'install.mjs'), readFileSync(resolve(frontendRoot, 'scripts/install-lefthook.mjs')))
      const result = spawnSync(process.execPath, ['install.mjs'], {
        cwd: fixture, encoding: 'utf8', env: { ...process.env, CI: 'true' },
      })
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
    } finally { rmSync(fixture, { recursive: true, force: true }) }
  })

  it('locks a prerelease to the requested master commit', () => {
    expect(createInvestmentReleasePlan({
      channel: 'prerelease',
      expectedVersion: '0.2.0-alpha.1',
      refName: 'master',
      repositoryVersion: '0.2.0-alpha.1',
      sha,
    })).toEqual({
      channel: 'prerelease',
      prerelease: true,
      sha,
      shortSha: '0123456',
      tag: 'investment-v0.2.0-alpha.1',
      version: '0.2.0-alpha.1',
    })
  })

  it('rejects an unexpected version, branch, channel, or commit identity', () => {
    const base = {
      channel: 'prerelease' as const,
      expectedVersion: '0.2.0-alpha.1',
      refName: 'master',
      repositoryVersion: '0.2.0-alpha.1',
      sha,
    }
    expect(() => createInvestmentReleasePlan({ ...base, expectedVersion: '0.2.0-alpha.2' })).toThrow(/does not match/)
    expect(() => createInvestmentReleasePlan({ ...base, refName: 'feature/release' })).toThrow(/master/)
    expect(() => createInvestmentReleasePlan({ ...base, channel: 'stable' })).toThrow(/stable/)
    expect(() => createInvestmentReleasePlan({ ...base, sha: '0123456' })).toThrow(/40-character/)
  })

  it('keeps stable and prerelease asset identities deterministic', () => {
    expect(investmentReleaseAssetName('0.2.0', 'darwin-arm64')).toBe('investment-agent-0.2.0-darwin-arm64.zip')
    expect(investmentReleaseAssetName('0.2.0-alpha.1', 'win32-x64')).toBe('investment-agent-0.2.0-alpha.1-win32-x64.zip')
  })

  it('stages exactly one Forge ZIP under the public asset identity', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'investment-release-'))
    try {
      const sourceRoot = resolve(fixture, 'make', 'zip', 'darwin', 'arm64')
      const destinationRoot = resolve(fixture, 'release-assets')
      mkdirSync(sourceRoot, { recursive: true })
      writeFileSync(resolve(sourceRoot, 'DeepSeek Harness-darwin-arm64-0.2.0-alpha.1.zip'), 'release bytes')

      expect(stageInvestmentReleaseAsset({
        destinationRoot,
        sourceRoot: resolve(fixture, 'make'),
        target: 'darwin-arm64',
        version: '0.2.0-alpha.1',
      })).toBe(resolve(destinationRoot, 'investment-agent-0.2.0-alpha.1-darwin-arm64.zip'))
      expect(readFileSync(resolve(destinationRoot, 'investment-agent-0.2.0-alpha.1-darwin-arm64.zip'), 'utf8')).toBe('release bytes')

      writeFileSync(resolve(sourceRoot, 'unexpected.zip'), 'extra')
      expect(() => stageInvestmentReleaseAsset({
        destinationRoot,
        sourceRoot: resolve(fixture, 'make'),
        target: 'darwin-arm64',
        version: '0.2.0-alpha.1',
      })).toThrow(/exactly one ZIP/)
    }
    finally {
      rmSync(fixture, { force: true, recursive: true })
    }
  })
})

describe('investment release workflow', () => {
  it('publishes one immutable, attested release from a manually locked master SHA', () => {
    const workflow = loadWorkflow('investment-release.yml')
    const dispatch = isRecord(workflow.on) ? workflow.on.workflow_dispatch : undefined
    const jobs = workflow.jobs
    if (!isRecord(dispatch) || !isRecord(dispatch.inputs) || !isRecord(jobs)) {
      throw new TypeError('release workflow must define workflow_dispatch inputs and jobs')
    }
    const build = jobs.build
    const preflight = jobs.preflight
    const publish = jobs.publish
    if (!isRecord(preflight) || !Array.isArray(preflight.steps)
      || !isRecord(build) || !isRecord(build.strategy)
      || !isRecord(publish) || !Array.isArray(publish.steps)) {
      throw new TypeError('release workflow must define preflight, build strategy, and publish steps')
    }

    expect(dispatch.inputs).toMatchObject({
      channel: { type: 'choice', options: ['prerelease', 'stable'] },
      expected_version: { required: true, type: 'string' },
    })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    const actionReferences = Object.values(jobs).flatMap((job) => {
      if (!isRecord(job) || !Array.isArray(job.steps)) return []
      return job.steps
        .filter(isRecord)
        .map(step => step.uses)
        .filter((uses): uses is string => typeof uses === 'string')
    })
    expect(actionReferences.length).toBeGreaterThan(0)
    for (const actionReference of actionReferences) {
      expect(actionReference).toMatch(/^[^@]+@[0-9a-f]{40}$/)
    }
    const planStep = preflight.steps
      .filter(isRecord)
      .find(step => step.name === 'Validate version and lock commit')
    const preflightSteps = JSON.stringify(preflight.steps)
    expect(planStep).toMatchObject({
      env: {
        EXPECTED_VERSION: '${{ inputs.expected_version }}',
        RELEASE_CHANNEL: '${{ inputs.channel }}',
        RELEASE_REF_NAME: '${{ github.ref_name }}',
        RELEASE_SHA: '${{ github.sha }}',
      },
    })
    expect(JSON.stringify(planStep)).not.toContain('--expected-version "${{ inputs.expected_version }}"')
    expect(JSON.stringify(planStep)).not.toContain('--channel "${{ inputs.channel }}"')
    expect(preflightSteps).toContain('gh release view')
    expect(preflightSteps).toContain('git/matching-refs/tags/')
    expect(build.strategy).toMatchObject({
      'fail-fast': false,
      matrix: {
        include: [
          { runner: 'macos-14', target: 'darwin-arm64' },
          { runner: 'macos-15-intel', target: 'darwin-x64' },
          { runner: 'windows-latest', target: 'win32-x64' },
        ],
      },
    })
    expect(JSON.stringify(build)).toContain('${{ needs.preflight.outputs.sha }}')
    expect(publish).toMatchObject({
      environment: 'github-release',
      permissions: {
        attestations: 'write',
        contents: 'write',
        'id-token': 'write',
      },
    })
    const serializedSteps = JSON.stringify(publish.steps)
    expect(serializedSteps).toContain('SHA256SUMS')
    expect(actionReferences.some(reference => reference.startsWith('actions/attest@'))).toBe(true)
    expect(serializedSteps).toContain('INVESTMENT_RELEASE_GUARDS_READY')
    expect(serializedSteps).toContain('investment-release-workflow sha=')
    expect(serializedSteps).toContain('-F draft=true')
    expect(serializedSteps).toContain('upload_url')
    expect(serializedSteps).toContain('--data-binary')
    expect(serializedSteps).not.toContain('gh release upload')
    expect(serializedSteps).toContain('--method DELETE')
    expect(serializedSteps).toContain('--method PATCH')
    expect(serializedSteps).not.toContain('gh release create')
    expect(serializedSteps).toContain('refs/tags/')
  })

  it('identifies short-lived pull request packages by commit', () => {
    const workflow = loadWorkflow('investment-sidecar.yml')
    expect(JSON.stringify(workflow)).toContain('short_sha')
    expect(JSON.stringify(workflow)).toContain('${{ steps.commit.outputs.short_sha }}')
  })
})

// Execute the exact workflow lookup with a local gh stub; no GitHub state is changed.
describe.skipIf(process.platform === 'win32')('release tag lookup shell behavior', () => {
  it.each([
    ['absent', [], false, 0],
    ['same', [{ ref: 'refs/tags/investment-v0.1.0-rc.11', object: { sha: 'expected' } }], false, 0],
    ['conflicting', [{ ref: 'refs/tags/investment-v0.1.0-rc.11', object: { sha: 'different' } }], false, 9],
    ['prefix-only', [{ ref: 'refs/tags/investment-v0.1.0-rc.110', object: { sha: 'different' } }], false, 0],
    ['API failure', [], true, 1],
  ])('%s preserves release guard behavior', (_name, refs, denied, expectedStatus) => {
    const source = readFileSync(resolve(repositoryRoot, '.github/workflows/investment-release.yml'), 'utf8')
    const lookups = source.split('\n').filter(line => line.trimStart().startsWith('existing_sha='))
    expect(lookups).toHaveLength(2)
    for (const lookup of lookups) {
      const result = spawnSync('bash', ['-c', `
set -euo pipefail
gh() {
  if [ "$DENIED" = true ]; then
    echo '{"message":"Forbidden"}'
    return 1
  fi
  case "$2" in
    */git/matching-refs/tags/*) printf '%s' "$REFS" | jq -r "$4" ;;
    *) echo '{"message":"Not Found"}'; return 1 ;;
  esac
}
${lookup}
if [ -n "$existing_sha" ] && [ "$existing_sha" != "$RELEASE_SHA" ]; then exit 9; fi
`], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_REPOSITORY: 'test/repo', RELEASE_TAG: 'investment-v0.1.0-rc.11', RELEASE_SHA: 'expected', REFS: JSON.stringify(refs), DENIED: String(denied) },
      })
      expect(result.status, result.stderr).toBe(expectedStatus)
    }
  })
})
