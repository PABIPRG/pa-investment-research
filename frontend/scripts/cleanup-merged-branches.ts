/** Plan or apply fail-closed cleanup of local feature branches already absorbed by a base. */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const MAX_GIT_OUTPUT = 64 * 1024 * 1024
const FEATURE_PREFIXES = ['codex/', 'feature/', 'fix/', 'docs/', 'chore/', 'refactor/', 'perf/', 'test/'] as const
const DEFAULT_PROTECTED_BRANCHES = ['main', 'master'] as const

interface GitResult {
  status: number | null
  stdout: string
  stderr: string
  error: Error | undefined
}

export interface WorktreeSnapshot {
  path: string
  trackedRecords: number
  untrackedPaths: string[]
  kind: 'clean' | 'generated-only' | 'dirty'
}

export type MergeEvidence =
  | { kind: 'ancestor' }
  | { kind: 'patch-equivalent'; equivalentCommits: number }
  | { kind: 'review'; reason: string }
  | { kind: 'unmerged'; uniqueCommits: number }

export interface BranchAssessment {
  name: string
  sha: string
  evidence: MergeEvidence
  worktree: WorktreeSnapshot | undefined
  action: 'delete' | 'keep'
  reason: string
}

export interface CleanupPlan {
  root: string
  baseRef: string
  baseSha: string
  currentBranch: string | undefined
  assessments: BranchAssessment[]
}

export interface CleanupOptions {
  baseRef: string
  apply: boolean
  protectedBranches: string[]
}

function executeGit(cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LANG: 'C', LC_ALL: 'C' },
    maxBuffer: MAX_GIT_OUTPUT,
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  }
}

function failureDetail(result: GitResult): string {
  return result.error?.message ?? (result.stderr.trim() || `Git exited with status ${String(result.status)}`)
}

function requireGit(cwd: string, args: readonly string[], context: string): string {
  const result = executeGit(cwd, args)
  if (result.status !== 0) throw new Error(`${context}: ${failureDetail(result)}`)
  return result.stdout
}

function splitLines(output: string): string[] {
  return output.split(/\r?\n/u).filter(Boolean)
}

function splitNul(output: string): string[] {
  return output.split('\0').filter(Boolean)
}

function branchRef(name: string): string {
  return `refs/heads/${name}`
}

function isManagedFeatureBranch(name: string): boolean {
  return FEATURE_PREFIXES.some(prefix => name.startsWith(prefix))
}

/** Return whether an untracked path is disposable dependency or compiler residue. */
export function isGeneratedResidue(path: string): boolean {
  const normalized = path.replaceAll('\\', '/')
  const parts = normalized.split('/')
  if (parts.includes('node_modules') || parts.includes('__pycache__')) return true
  if (/\.(?:pyc|pyd|pyo|tsbuildinfo)$/u.test(normalized)) return true
  return parts[0] === 'backend'
    && parts.length >= 3
    && (parts[2] === 'env' || parts[2] === '.venv')
}

/** Classify a worktree without treating generated-only untracked files as authored work. */
export function classifyWorktree(
  path: string,
  trackedRecords: number,
  untrackedPaths: readonly string[],
): WorktreeSnapshot {
  const sortedUntracked = [...untrackedPaths].sort()
  if (trackedRecords > 0 || sortedUntracked.some(candidate => !isGeneratedResidue(candidate))) {
    return { path, trackedRecords, untrackedPaths: sortedUntracked, kind: 'dirty' }
  }
  if (sortedUntracked.length > 0) {
    return { path, trackedRecords, untrackedPaths: sortedUntracked, kind: 'generated-only' }
  }
  return { path, trackedRecords, untrackedPaths: [], kind: 'clean' }
}

/** Decide whether local Git evidence proves that a branch is absorbed by the base. */
export function classifyMergeEvidence(input: {
  ancestor: boolean
  uniqueMergeCommits: number
  cherryLines: readonly string[]
}): MergeEvidence {
  if (input.ancestor) return { kind: 'ancestor' }
  if (input.uniqueMergeCommits > 0) {
    return {
      kind: 'review',
      reason: `${input.uniqueMergeCommits} non-ancestor merge commit(s) require review`,
    }
  }
  const uniqueCommits = input.cherryLines.filter(line => line.startsWith('+ ')).length
  if (uniqueCommits > 0) return { kind: 'unmerged', uniqueCommits }
  const equivalentCommits = input.cherryLines.filter(line => line.startsWith('- ')).length
  if (equivalentCommits > 0) return { kind: 'patch-equivalent', equivalentCommits }
  return { kind: 'review', reason: 'Git could not prove ancestry or patch equivalence' }
}

function parseWorktreeMap(root: string): Map<string, string> {
  const fields = splitNul(requireGit(root, ['worktree', 'list', '--porcelain', '-z'], 'cannot list worktrees'))
  const worktrees = new Map<string, string>()
  let path: string | undefined
  for (const field of fields) {
    if (field.startsWith('worktree ')) {
      path = field.slice('worktree '.length)
    } else if (field.startsWith('branch refs/heads/') && path !== undefined) {
      worktrees.set(field.slice('branch refs/heads/'.length), path)
    }
  }
  return worktrees
}

function countNulRecords(output: string): number {
  return splitNul(output).length
}

function sameWorktree(left: WorktreeSnapshot | undefined, right: WorktreeSnapshot | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.path === right.path
    && left.trackedRecords === right.trackedRecords
    && left.kind === right.kind
    && left.untrackedPaths.length === right.untrackedPaths.length
    && left.untrackedPaths.every((path, index) => path === right.untrackedPaths[index])
}

export class MergedBranchCleaner {
  readonly root: string

  constructor(cwd: string) {
    this.root = requireGit(cwd, ['rev-parse', '--show-toplevel'], 'cannot locate repository').trim()
  }

  plan(options: CleanupOptions): CleanupPlan {
    const baseSha = this.resolveCommit(options.baseRef)
    const currentBranch = this.currentBranch()
    const protectedBranches = new Set([...DEFAULT_PROTECTED_BRANCHES, ...options.protectedBranches])
    if (currentBranch !== undefined) protectedBranches.add(currentBranch)
    const worktrees = parseWorktreeMap(this.root)
    const branches = splitLines(requireGit(
      this.root,
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
      'cannot list local branches',
    )).sort()
    const assessments = branches.map(name => this.assessBranch(
      name,
      baseSha,
      worktrees.get(name),
      protectedBranches,
    ))
    return { root: this.root, baseRef: options.baseRef, baseSha, currentBranch, assessments }
  }

  apply(plan: CleanupPlan): string[] {
    const currentBaseSha = this.resolveCommit(plan.baseRef)
    if (currentBaseSha !== plan.baseSha) {
      throw new Error(`cleanup aborted: base ${plan.baseRef} moved from ${plan.baseSha} to ${currentBaseSha}`)
    }
    const deletions = plan.assessments.filter(assessment => assessment.action === 'delete')
    const worktrees = parseWorktreeMap(this.root)
    for (const assessment of deletions) this.assertUnchanged(assessment, worktrees.get(assessment.name))

    const removed: string[] = []
    for (const assessment of deletions) {
      if (assessment.worktree !== undefined) {
        const force = assessment.worktree.kind === 'generated-only' ? ['--force'] : []
        requireGit(
          this.root,
          ['worktree', 'remove', ...force, assessment.worktree.path],
          `cannot remove worktree for ${assessment.name}`,
        )
      }
      const deleteFlag = assessment.evidence.kind === 'ancestor' ? '-d' : '-D'
      requireGit(
        this.root,
        ['branch', deleteFlag, '--', assessment.name],
        `cannot delete branch ${assessment.name}`,
      )
      removed.push(assessment.name)
    }
    return removed
  }

  private resolveCommit(ref: string): string {
    return requireGit(
      this.root,
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      `cannot resolve base ${JSON.stringify(ref)}`,
    ).trim()
  }

  private currentBranch(): string | undefined {
    const result = executeGit(this.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (result.status === 1) return undefined
    if (result.status !== 0) throw new Error(`cannot inspect current branch: ${failureDetail(result)}`)
    return result.stdout.trim()
  }

  private assessBranch(
    name: string,
    baseSha: string,
    worktreePath: string | undefined,
    protectedBranches: ReadonlySet<string>,
  ): BranchAssessment {
    const sha = requireGit(
      this.root,
      ['rev-parse', '--verify', '--end-of-options', `${branchRef(name)}^{commit}`],
      `cannot resolve branch ${name}`,
    ).trim()
    const worktree = worktreePath === undefined ? undefined : this.inspectWorktree(worktreePath)
    const evidence = this.inspectMergeEvidence(baseSha, sha)

    if (protectedBranches.has(name)) {
      return { name, sha, evidence, worktree, action: 'keep', reason: 'protected branch' }
    }
    if (!isManagedFeatureBranch(name)) {
      return { name, sha, evidence, worktree, action: 'keep', reason: 'branch prefix is not cleanup-managed' }
    }
    if (evidence.kind === 'review') {
      return { name, sha, evidence, worktree, action: 'keep', reason: evidence.reason }
    }
    if (evidence.kind === 'unmerged') {
      return {
        name,
        sha,
        evidence,
        worktree,
        action: 'keep',
        reason: `${evidence.uniqueCommits} unique commit(s) remain`,
      }
    }
    if (worktree?.kind === 'dirty') {
      return {
        name,
        sha,
        evidence,
        worktree,
        action: 'keep',
        reason: `worktree has ${worktree.trackedRecords} tracked and ${worktree.untrackedPaths.length} untracked change(s)`,
      }
    }
    const reason = evidence.kind === 'ancestor'
      ? 'branch is an ancestor of the base'
      : `${evidence.equivalentCommits} commit(s) are patch-equivalent to the base`
    return { name, sha, evidence, worktree, action: 'delete', reason }
  }

  private inspectMergeEvidence(baseSha: string, branchSha: string): MergeEvidence {
    const ancestorResult = executeGit(this.root, ['merge-base', '--is-ancestor', branchSha, baseSha])
    if (ancestorResult.status !== 0 && ancestorResult.status !== 1) {
      throw new Error(`cannot compare branch ancestry: ${failureDetail(ancestorResult)}`)
    }
    const uniqueMergeCommits = Number.parseInt(requireGit(
      this.root,
      ['rev-list', '--merges', '--count', `${baseSha}..${branchSha}`],
      'cannot inspect branch merge commits',
    ).trim(), 10)
    const cherryLines = splitLines(requireGit(
      this.root,
      ['cherry', baseSha, branchSha],
      'cannot inspect patch equivalence',
    ))
    return classifyMergeEvidence({
      ancestor: ancestorResult.status === 0,
      uniqueMergeCommits,
      cherryLines,
    })
  }

  private inspectWorktree(path: string): WorktreeSnapshot {
    const trackedRecords = countNulRecords(requireGit(
      path,
      ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=none'],
      `cannot inspect tracked changes in ${path}`,
    ))
    const untrackedPaths = splitNul(requireGit(
      path,
      ['ls-files', '--others', '--exclude-standard', '-z', '--'],
      `cannot inspect untracked files in ${path}`,
    ))
    return classifyWorktree(path, trackedRecords, untrackedPaths)
  }

  private assertUnchanged(assessment: BranchAssessment, currentWorktreePath: string | undefined): void {
    const currentSha = requireGit(
      this.root,
      ['rev-parse', '--verify', '--end-of-options', `${branchRef(assessment.name)}^{commit}`],
      `cleanup aborted because branch ${assessment.name} disappeared`,
    ).trim()
    if (currentSha !== assessment.sha) {
      throw new Error(`cleanup aborted: branch ${assessment.name} moved from ${assessment.sha} to ${currentSha}`)
    }
    if (assessment.worktree?.path !== currentWorktreePath) {
      throw new Error(`cleanup aborted: worktree binding for ${assessment.name} changed after planning`)
    }
    const currentWorktree = currentWorktreePath === undefined
      ? undefined
      : this.inspectWorktree(currentWorktreePath)
    if (!sameWorktree(assessment.worktree, currentWorktree)) {
      throw new Error(`cleanup aborted: worktree for ${assessment.name} changed after planning`)
    }
  }
}

function parseOptions(args: string[]): CleanupOptions & { help: boolean } {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      apply: { type: 'boolean', default: false },
      base: { type: 'string', default: 'public/master' },
      help: { type: 'boolean', short: 'h', default: false },
      protect: { type: 'string', multiple: true, default: [] },
    },
  })
  return {
    apply: values.apply,
    baseRef: values.base,
    help: values.help,
    protectedBranches: values.protect,
  }
}

function renderAssessment(assessment: BranchAssessment): string {
  const label = assessment.action === 'delete' ? 'DELETE' : 'KEEP'
  const worktree = assessment.worktree === undefined ? '' : `; worktree=${assessment.worktree.kind}`
  return `${label.padEnd(6)} ${assessment.name}: ${assessment.reason}${worktree}`
}

function usage(): string {
  return [
    'Usage: pnpm --dir frontend run branch:cleanup [--base <ref>] [--protect <branch>] [--apply]',
    '',
    'Default mode is read-only. Pass --apply only after reviewing DELETE rows.',
  ].join('\n')
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  try {
    const options = parseOptions(process.argv.slice(2))
    if (options.help) {
      console.log(usage())
    } else {
      const cleaner = new MergedBranchCleaner(process.cwd())
      const plan = cleaner.plan(options)
      console.log(`branch-cleanup: base ${plan.baseRef} (${plan.baseSha.slice(0, 12)})`)
      for (const assessment of plan.assessments) console.log(renderAssessment(assessment))
      const deletions = plan.assessments.filter(assessment => assessment.action === 'delete')
      if (options.apply) {
        const removed = cleaner.apply(plan)
        console.log(`branch-cleanup: removed ${removed.length} branch(es)`)
      } else if (deletions.length > 0) {
        console.log(`branch-cleanup: dry run; pass --apply to remove ${deletions.length} safe candidate(s)`)
      } else {
        console.log('branch-cleanup: no safe candidates')
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
