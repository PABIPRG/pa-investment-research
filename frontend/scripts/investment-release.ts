import { appendFileSync, cpSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type InvestmentReleaseChannel = 'prerelease' | 'stable'
export type InvestmentReleaseTarget = 'darwin-arm64' | 'darwin-x64' | 'win32-x64'

export interface InvestmentReleaseInput {
  channel: InvestmentReleaseChannel
  expectedVersion: string
  refName: string
  repositoryVersion: string
  sha: string
}

export interface InvestmentReleasePlan {
  channel: InvestmentReleaseChannel
  prerelease: boolean
  sha: string
  shortSha: string
  tag: string
  version: string
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/
const SHA_PATTERN = /^[0-9a-f]{40}$/i

export function createInvestmentReleasePlan(input: InvestmentReleaseInput): InvestmentReleasePlan {
  if (input.refName !== 'master') {
    throw new Error(`Investment releases must be dispatched from master, received ${JSON.stringify(input.refName)}`)
  }
  if (!VERSION_PATTERN.test(input.repositoryVersion)) {
    throw new Error(`Repository version is not release-shaped: ${JSON.stringify(input.repositoryVersion)}`)
  }
  if (input.expectedVersion !== input.repositoryVersion) {
    throw new Error(`Expected version ${JSON.stringify(input.expectedVersion)} does not match repository version ${JSON.stringify(input.repositoryVersion)}`)
  }
  if (!SHA_PATTERN.test(input.sha)) {
    throw new Error('Release SHA must be a complete 40-character hexadecimal commit identity')
  }

  const hasPrereleaseSuffix = input.repositoryVersion.includes('-')
  if (input.channel === 'stable' && hasPrereleaseSuffix) {
    throw new Error(`The stable channel requires a stable version, received ${JSON.stringify(input.repositoryVersion)}`)
  }
  if (input.channel === 'prerelease' && !hasPrereleaseSuffix) {
    throw new Error(`The prerelease channel requires a prerelease version, received ${JSON.stringify(input.repositoryVersion)}`)
  }

  return {
    channel: input.channel,
    prerelease: input.channel === 'prerelease',
    sha: input.sha.toLowerCase(),
    shortSha: input.sha.slice(0, 7).toLowerCase(),
    tag: `investment-v${input.repositoryVersion}`,
    version: input.repositoryVersion,
  }
}

export function investmentReleaseAssetName(version: string, target: InvestmentReleaseTarget): string {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid release version: ${JSON.stringify(version)}`)
  return `investment-agent-${version}-${target}.zip`
}

function argument(name: string): string {
  const position = process.argv.indexOf(`--${name}`)
  const value = position >= 0 ? process.argv[position + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`Missing --${name}`)
  return value
}

function readRepositoryVersion(): string {
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version?: unknown }
  if (typeof packageJson.version !== 'string') throw new TypeError('package.json must define a string version')
  return packageJson.version
}

function findZipFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.zip'))
    .map(entry => join(entry.parentPath, entry.name))
    .sort()
}

export function stageInvestmentReleaseAsset(options: {
  destinationRoot: string
  sourceRoot: string
  target: InvestmentReleaseTarget
  version: string
}): string {
  const sourceRoot = resolve(options.sourceRoot)
  const destinationRoot = resolve(options.destinationRoot)
  const candidates = findZipFiles(sourceRoot)
  const candidate = candidates[0]
  if (!candidate || candidates.length !== 1) {
    throw new Error(`Expected exactly one ZIP under ${sourceRoot}, found ${candidates.length}: ${candidates.map(candidate => basename(candidate)).join(', ')}`)
  }
  mkdirSync(destinationRoot, { recursive: true })
  const destination = join(destinationRoot, investmentReleaseAssetName(options.version, options.target))
  cpSync(candidate, destination)
  return destination
}

function runPreflight(): void {
  const channel = argument('channel')
  if (channel !== 'prerelease' && channel !== 'stable') throw new Error(`Unsupported release channel: ${JSON.stringify(channel)}`)
  const plan = createInvestmentReleasePlan({
    channel,
    expectedVersion: argument('expected-version'),
    refName: argument('ref-name'),
    repositoryVersion: readRepositoryVersion(),
    sha: argument('sha'),
  })
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required')
  appendFileSync(outputPath, [
    `channel=${plan.channel}`,
    `prerelease=${String(plan.prerelease)}`,
    `sha=${plan.sha}`,
    `short_sha=${plan.shortSha}`,
    `tag=${plan.tag}`,
    `version=${plan.version}`,
    '',
  ].join('\n'))
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    appendFileSync(summaryPath, [
      '## Investment release plan',
      '',
      `- Version: \`${plan.version}\``,
      `- Channel: \`${plan.channel}\``,
      `- Tag: \`${plan.tag}\``,
      `- Commit: \`${plan.sha}\``,
      '',
    ].join('\n'))
  }
}

function runStage(): void {
  const target = argument('target') as InvestmentReleaseTarget
  if (!['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(target)) {
    throw new Error(`Unsupported release target: ${JSON.stringify(target)}`)
  }
  stageInvestmentReleaseAsset({
    destinationRoot: argument('destination-root'),
    sourceRoot: argument('source-root'),
    target,
    version: argument('version'),
  })
}

function main(): void {
  const command = process.argv[2]
  if (command === 'preflight') {
    runPreflight()
    return
  }
  if (command === 'stage') {
    runStage()
    return
  }
  throw new Error(`Expected command preflight or stage, received ${JSON.stringify(command)}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
