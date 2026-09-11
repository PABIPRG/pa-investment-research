# Agent Note: Investment desktop releases lock one master commit

Status: implemented

English | [中文](2026-09-07-investment-desktop-github-release.zh.md)

## Problem

The investment desktop package workflow produced short-lived pull request artifacts but did not create a durable, identifiable release. A product version can span several commits while it is being prepared, so a version string alone cannot answer which source revision users downloaded. Publishing on every commit would turn ordinary integration activity into an unbounded release stream, while rebuilding an existing version would make its contents mutable.

## Decision

### Manual release intent and repository-owned version

`.github/workflows/investment-release.yml` is manual-only. It accepts an expected version and a `prerelease` or `stable` channel while `frontend/package.json` remains the version source of truth. The run must be dispatched from `master`; the expected value must equal the repository value; prerelease versions and stable versions must use their matching channels.

The preflight records the complete `github.sha`, and every platform job checks out that value. Later commits on `master` cannot change an in-progress release. Pull request package artifacts carry the seven-character commit prefix so multiple builds with one development version remain distinguishable.

### Immutable public identity and verified bytes

A release uses `investment-v<version>` and contains ZIP files for macOS arm64, macOS x64, and Windows x64 plus `SHA256SUMS`. The publish job consumes only the build matrix artifacts, verifies the exact platform set, writes and verifies the checksums, and creates GitHub artifact attestations before publication.

The workflow refuses an existing published GitHub Release. It creates a marked draft, uploads every asset, and then publishes it; after an interrupted upload, a later run deletes and rebuilds only a draft carrying this workflow's marker and the same locked commit. Human drafts are untouched. The workflow may reuse a tag only when that tag already points to the locked commit, which permits recovery after tag creation. A tag that points elsewhere fails the run; the workflow never moves a tag or replaces published Release assets.

### Narrow publication authority and signing boundary

The workflow defaults to read-only repository access. Only the publish job receives repository-content, OIDC, and attestation write permissions, and that job is attached to the `github-release` Environment. Before the first release, repository administrators enable GitHub immutable releases, pre-create and protect that Environment, and set its `INVESTMENT_RELEASE_GUARDS_READY` variable to `true`; without that acknowledgement, the publish job exits before any write. Repository administrators own the reviewer policy on the Environment.

The package retains the repository's existing ad-hoc macOS signature and ZIP format. Apple Developer ID signing, notarization, Windows Authenticode, and installer formats require release identities and credentials that this repository does not currently define; their absence remains explicit rather than being represented as production signing.

## Alternatives considered

**Release on every commit.** This makes test builds permanent, consumes Release history for ordinary integration, and does not express deliberate release intent. Pull request CI remains automatic and keeps time-limited artifacts instead.

**Use the manually entered version as the authority.** This permits the selected label to disagree with the built manifests. The input is only a confirmation; committed source owns the value.

**Build the latest `master` separately in each matrix job.** New merges could make one release contain different revisions. Capturing one full SHA before the matrix gives every platform the same source identity.

**Replace assets when a version is rebuilt.** Users could receive different bytes under one version and checksum history would become ambiguous. Existing releases are immutable, and a correction requires a new version.

**Claim production signing without credentials.** A packaging success would overstate platform trust and distribution readiness. The first sequence publishes the already-supported ZIPs and keeps credential-backed signing as a distinct follow-up.

## Consequences

Maintainers merge a version change before dispatching the workflow, select `master`, enter the same version, and choose its matching channel. Of several commits that carried the same development version, only the commit referenced by the immutable release tag is official.

The build is reproducible by source identity and auditable by checksum and GitHub attestation, but the first sequence does not remove operating-system warnings associated with ad-hoc or unsigned distribution. Release immutability and approval depend on repository settings outside version control; the Environment variable is the fail-closed acknowledgement that an administrator configured those settings.
