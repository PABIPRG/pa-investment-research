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
    expect(preflightSteps).toContain('git/ref/tags/')
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
