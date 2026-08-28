# Agent Note: Fail-closed cleanup of local merged branches

Status: implemented

English | [中文](2026-08-28-local-merged-branch-cleanup.zh.md)

## Problem

Merging a pull request updates the shared base but leaves its local branch and any attached worktree in place. Remote-ref pruning does not delete local branches, and Git refuses to delete a branch while another worktree owns it. Repeated agent tasks therefore accumulate branches and temporary worktrees, while a broad force-delete risks losing authored files left after the branch tip was merged.

Ordinary ancestry is not enough to identify every absorbed branch because rebased, squashed, or cherry-picked changes may be patch-equivalent to the base without becoming its ancestors. Patch equivalence alone is also insufficient when a non-ancestor merge commit may carry conflict-resolution changes.

## Decision

The repository owns `pnpm --dir frontend run branch:cleanup` as a local cleanup planner. It is read-only by default and uses `public/master` as its explicit default base. `--apply` is the only mode that removes worktrees and local branches; it never deletes remote branches, fetches refs, switches branches, or updates a base.

The planner protects `master`, `main`, the current branch, and every exact branch supplied through `--protect`. It considers only repository feature prefixes: `codex/`, `feature/`, `fix/`, `docs/`, `chore/`, `refactor/`, `perf/`, and `test/`.

## Safety model

A branch is removable when its tip is an ancestor of the resolved base, or when every non-merge commit outside the base is patch-equivalent to the base and no non-ancestor merge commit remains. Any unique commit, non-ancestor merge commit, or inconclusive Git result keeps the branch for review.

An attached worktree is removable only when it is clean or contains exclusively narrow dependency and compiler residue. Authored tracked changes and every untracked path outside the allowlist keep the worktree and branch. The generated-residue allowlist covers nested `node_modules`, backend `env` or `.venv`, Python bytecode caches, and TypeScript incremental state; it does not classify arbitrary JavaScript, documentation, or generic generated-looking paths as disposable.

Before mutation, the apply phase verifies that the base, every candidate branch tip, and every candidate worktree state still match the dry-run plan. It aborts before the first deletion when any observed state moved. Clean worktrees use ordinary removal; generated-only worktrees require force because their disposable untracked files remain. Ancestor branches use safe branch deletion, while a separately proven patch-equivalent branch uses force deletion only after that proof.

The repository ignore file carries the same narrow dependency and compiler-residue patterns so ordinary installations do not make worktrees appear authored. The root collaboration instructions make the dry run a required post-merge check and retain the existing user-authorization boundary for `--apply`.

## Alternatives considered

**Rely on `fetch --prune` or hosting-provider branch deletion.** Remote pruning removes stale remote-tracking refs, not local branches or worktrees, and a hosting provider cannot mutate a developer's local repository.

**Delete every branch listed by `git branch --merged`.** This misses squash, rebase, and cherry-pick integration and does not inspect attached worktree changes.

**Treat every branch with no positive `git cherry` row as removable.** Non-ancestor merge commits are omitted from ordinary patch-equivalence reasoning and may carry unique conflict resolutions, so the planner keeps them for review.

**Automatically archive dirty worktrees before deletion.** An archive location, retention period, sensitive-file policy, and recovery owner require user judgment. The command instead reports the dirty branch and leaves every byte untouched.

**Fetch, switch to the base, and synchronize mirrors inside the cleanup command.** Those operations mix network credentials and shared-ref mutation into a local deletion tool. The surrounding workflow owns fresh refs and mirror synchronization explicitly.

## Consequences

The command intentionally leaves some obsolete branches for manual review when Git cannot prove safety. This false-negative bias costs occasional human cleanup but prevents uncommitted work or merge-only changes from being silently erased.

Post-merge cleanup becomes repeatable and testable across ordinary merges and patch-equivalent histories. Maintainers still fetch the current public and private refs before planning, inspect the dry-run output, and authorize destructive application separately.
