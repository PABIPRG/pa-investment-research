import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyMergeEvidence,
  classifyWorktree,
  isGeneratedResidue,
  MergedBranchCleaner,
} from './cleanup-merged-branches.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => rm(root, { recursive: true, force: true })))
})

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

async function write(path: string, value: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, value)
}

async function commitFile(root: string, path: string, value: string, message: string): Promise<string> {
  await write(join(root, path), value)
  git(root, 'add', '--', path)
  git(root, 'commit', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}

async function repositoryFixture(): Promise<{
  root: string
  generatedWorktree: string
  dirtyWorktree: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'merged-branch-cleanup-'))
  roots.push(root)
  git(root, 'init', '-b', 'master')
  git(root, 'config', 'user.name', 'Branch Cleanup Test')
  git(root, 'config', 'user.email', 'branch-cleanup@example.invalid')
  await commitFile(root, 'base.txt', 'base\n', 'base')
  const baseSha = git(root, 'rev-parse', 'HEAD')

  git(root, 'switch', '-c', 'codex/merged')
  await commitFile(root, 'merged.txt', 'merged\n', 'merged change')
  git(root, 'switch', 'master')
  git(root, 'merge', '--no-ff', '-m', 'merge candidate', 'codex/merged')

  git(root, 'switch', '-c', 'codex/equivalent', baseSha)
  const equivalentSha = await commitFile(root, 'equivalent.txt', 'same patch\n', 'equivalent change')
  git(root, 'switch', 'master')
  git(root, 'cherry-pick', equivalentSha)

  git(root, 'switch', '-c', 'codex/unmerged')
  await commitFile(root, 'unique.txt', 'unique\n', 'unique change')
  git(root, 'switch', 'master')

  git(root, 'branch', 'codex/generated')
  const generatedWorktree = join(root, 'generated worktree')
  git(root, 'worktree', 'add', generatedWorktree, 'codex/generated')
  await write(join(generatedWorktree, 'frontend/node_modules/example/index.js'), 'generated\n')

  git(root, 'branch', 'codex/dirty')
  const dirtyWorktree = join(root, 'dirty worktree')
  git(root, 'worktree', 'add', dirtyWorktree, 'codex/dirty')
  await write(join(dirtyWorktree, 'notes.txt'), 'authored\n')
  return { root, generatedWorktree, dirtyWorktree }
}

describe('branch cleanup safety classifiers', () => {
  it('recognizes only narrow generated residue', () => {
    expect(isGeneratedResidue('frontend/packages/example/node_modules/pkg/index.js')).toBe(true)
    expect(isGeneratedResidue('backend/market-watch/env/bin/python')).toBe(true)
    expect(isGeneratedResidue('backend/market-watch/.venv/bin/python')).toBe(true)
    expect(isGeneratedResidue('backend/market-watch/src/__pycache__/app.pyc')).toBe(true)
    expect(isGeneratedResidue('backend/market-watch/env/native.pyd')).toBe(true)
    expect(isGeneratedResidue('frontend/tsconfig.tsbuildinfo')).toBe(true)
    expect(isGeneratedResidue('docs/release/report.md')).toBe(false)
    expect(isGeneratedResidue('frontend/src/generated.js')).toBe(false)
  })

  it('fails closed for dirty worktrees and non-ancestor merge commits', () => {
    expect(classifyWorktree('/tmp/worktree', 1, [])).toMatchObject({ kind: 'dirty' })
    expect(classifyWorktree('/tmp/worktree', 0, ['frontend/node_modules/a'])).toMatchObject({ kind: 'generated-only' })
    expect(classifyWorktree('/tmp/worktree', 0, ['notes.txt'])).toMatchObject({ kind: 'dirty' })
    expect(classifyMergeEvidence({
      ancestor: false,
      uniqueMergeCommits: 1,
      cherryLines: ['- abc'],
    })).toMatchObject({ kind: 'review' })
  })
})

describe('MergedBranchCleaner', () => {
  it('plans and removes only absorbed branches with safe worktrees', async () => {
    const setup = await repositoryFixture()
    const cleaner = new MergedBranchCleaner(setup.root)
    const plan = cleaner.plan({ baseRef: 'master', apply: false, protectedBranches: [] })
    const byName = new Map(plan.assessments.map(assessment => [assessment.name, assessment]))

    expect(byName.get('master')).toMatchObject({ action: 'keep', reason: 'protected branch' })
    expect(byName.get('codex/merged')).toMatchObject({ action: 'delete', evidence: { kind: 'ancestor' } })
    expect(byName.get('codex/equivalent')).toMatchObject({
      action: 'delete',
      evidence: { kind: 'patch-equivalent', equivalentCommits: 1 },
    })
    expect(byName.get('codex/generated')).toMatchObject({
      action: 'delete',
      worktree: { kind: 'generated-only' },
    })
    expect(byName.get('codex/dirty')).toMatchObject({ action: 'keep', worktree: { kind: 'dirty' } })
    expect(byName.get('codex/unmerged')).toMatchObject({
      action: 'keep',
      evidence: { kind: 'unmerged', uniqueCommits: 1 },
    })

    expect(cleaner.apply(plan).sort()).toEqual([
      'codex/equivalent',
      'codex/generated',
      'codex/merged',
    ])
    expect(git(setup.root, 'branch', '--format=%(refname:short)').split('\n').sort()).toEqual([
      'codex/dirty',
      'codex/unmerged',
      'master',
    ])
    expect(() => git(setup.root, 'worktree', 'list')).not.toThrow()
  })

  it('aborts before deletion when a planned branch moves', async () => {
    const setup = await repositoryFixture()
    const cleaner = new MergedBranchCleaner(setup.root)
    const plan = cleaner.plan({ baseRef: 'master', apply: false, protectedBranches: [] })
    git(setup.root, 'branch', '-f', 'codex/merged', 'codex/unmerged')

    expect(() => cleaner.apply(plan)).toThrow(/branch codex\/merged moved/u)
    expect(git(setup.root, 'show-ref', '--verify', 'refs/heads/codex/equivalent')).not.toBe('')
    expect(git(setup.root, 'show-ref', '--verify', 'refs/heads/codex/generated')).not.toBe('')
  })

  it('aborts before deletion when a worktree binding changes', async () => {
    const setup = await repositoryFixture()
    const cleaner = new MergedBranchCleaner(setup.root)
    const plan = cleaner.plan({ baseRef: 'master', apply: false, protectedBranches: [] })
    git(setup.generatedWorktree, 'switch', '--detach')

    expect(() => cleaner.apply(plan)).toThrow(/worktree binding for codex\/generated changed/u)
    expect(git(setup.root, 'show-ref', '--verify', 'refs/heads/codex/equivalent')).not.toBe('')
    expect(git(setup.root, 'show-ref', '--verify', 'refs/heads/codex/merged')).not.toBe('')
  })
})
