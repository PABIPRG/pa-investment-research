# Agent Note: Investment sidecar downloads tolerate transient network failures

Status: implemented

English | [中文](2026-09-24-investment-sidecar-download-recovery.zh.md)

## Problem

Native desktop packaging needs a locked Python archive even when a CI runner starts with an empty cache. A short connection timeout and three near-immediate attempts can exhaust before a temporary GitHub connection problem clears. Coupling that archive cache to the frontend dependency lock also forces unrelated dependency changes to repeat the download.

## Decision

The sidecar builder downloads the immutable archive with an explicit 30-second connection timeout, 60-second header timeout, 120-second body inactivity timeout, and eight-minute overall deadline. It retries transient network failures and retryable HTTP statuses at most five times, waiting 2, 4, 8, then 16 seconds. Permanent HTTP responses and archive SHA-256 mismatches remain terminal. Each failed attempt removes its partial file; the verified archive is the only file published to the shared cache.

The packaged-sidecar and manual-release workflows cache Python downloads separately under a key derived from the native target and Python runtime lock. Pip and Electron downloads retain a key that also includes the frontend dependency lock. Restored Python archives are hashed against the runtime lock before use, since a CI cache is an optimization rather than a trusted source.

## Alternatives considered

**Retry the entire packaging job.** Rebuilding the frontend and reinstalling dependencies wastes runner time and can repeat the same cold download without changing its short connection window. The retry belongs to the archive download.

**Keep one cache key for all packaging downloads.** A frontend dependency change would still discard a valid Python archive. Separate keys preserve the archive while allowing the other downloads to follow their dependency inputs.

**Accept a cached file without hashing it.** Cache contents can be missing, stale, or corrupted. The runtime lock remains the authority for archive bytes.

## Consequences

A cold runner can spend longer on a transient outage before failing, while retries remain bounded and permanent failures remain visible. Cache misses can still occur because GitHub scopes caches by ref and may evict them; the packaging path must continue to work without a cache.
