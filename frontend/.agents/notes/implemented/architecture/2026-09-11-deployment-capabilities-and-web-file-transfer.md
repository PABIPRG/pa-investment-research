# Agent Note: Deployment capabilities are explicit and browser backup transfer is bounded

Status: implemented

English | [中文](2026-09-11-deployment-capabilities-and-web-file-transfer.zh.md)

## Problem

Local Web, Electron, CLI, and Cloud Web shared UI and Host methods but had no authoritative deployment classification. Browser platform inference could select a local broker adapter, while an authenticated cloud client could still discover or submit server paths. Investment backups supported Host-local files only, so a cloud browser could import neither a selected file nor download an existing archive.

## Decision

`@deepseek-ai/dsh-host-deployment-capabilities` provides one immutable snapshot for the process. Base composition declares CLI, Web startup explicitly declares `local-web` or `cloud-web` through `DSH_DEPLOYMENT_SURFACE`, and Electron overrides it with `electron`. `host.describe` carries the snapshot to the Client.

Consumers fail closed from that snapshot. Cloud Web mounts no directory picker, omits Host paths from Host, Session, Workspace, and investment Runtime readiness projections, rejects path-bearing creation and native-open methods, and limits holdings to manual entry or bulk import. Local surfaces preserve their existing platform-specific provider roster and readiness diagnostics.

Investment backup transfer keeps the established chunked Remote flow and import preview. Stored backup download uses a separate bounded Remote session so the authenticated transport protects every chunk without buffering an unbounded request body. Before file I/O or archive decompression, the Host atomically reserves capacity: two download sessions, two preview sessions with a 128 MiB aggregate compressed-byte ceiling, and four uploads with a 128 MiB aggregate reservation. It rechecks opened file sizes, performs fixed-size reads, validates direct `.pabackup` archives, and requires exact offsets. All resource-creating entry points share a lifecycle gate: Runtime disposal closes the gate, aborts and waits for in-flight creation, and only then clears sessions, reservations, and temporary files. New creation attempts fail closed after disposal. Backup-list file failures use stable, path-free descriptions rather than raw Node errors.

The browser propagates cancellation into each Remote, validates declared spans, assembles a Blob, downloads it, and revokes the object URL. Preview ownership transfers to the Host when import is confirmed: a successful import consumes it, an expiry closes the dialog, a recoverable failure leaves it available for retry while mounted, and a failure after unmount releases it. Storage location controls remain hidden while capability is unknown or failed and appear only after the Host explicitly reports local storage.

Cloud managed storage always resolves to the instance-owned default directory. A custom directory persisted by an earlier local deployment is ignored in Cloud Web but remains stored for a later local deployment. Expected backup failures cross the Remote boundary as explicitly trusted, caller-safe payloads; unexpected exceptions become a stable generic rejection, while the original cause remains Host-only.

## Alternatives considered

- Inferring the deployment from browser APIs, URLs, or bind addresses was rejected because those are presentation and topology details rather than deployment authority.
- Relying on browser cancellation, request activity, or a 24-hour lazy expiry was rejected because abandoned sessions could retain memory and temporary files for too long. Global reservations and active fifteen-minute timers bound the residual lifetime without a follow-up request.
- Attaching a guessed owner to transfers was rejected because the Runtime does not receive a trustworthy authenticated principal. Ownership must be added to the Connection/Gateway request Context before logout can synchronously reclaim only that principal's resources.

## Consequences

- UI visibility is only an affordance; Host checks enforce the same cloud restrictions against crafted requests.
- Cloud users see managed backup storage and can download, upload, preview, cancel, retry, import, or reset without learning a server directory.
- Broker discovery and synchronization never execute in Cloud Web. The UI directs the user to manual entry or bulk import.
- The deployment matrix is documented in [`docs/deployment-capabilities.md`](../../../../docs/deployment-capabilities.md).
- Web authentication remains unchanged. Transfers are not yet associated with an authenticated owner, so logout may leave resources until the global quota or active fifteen-minute timer reclaims them. Closing that limitation requires carrying the authenticated owner through the Connection/Gateway request Context. Container isolation and health/readiness remain separate deployment concerns.

## Verification

Package tests cover the four capability snapshots, direct and Loader composition, explicit startup parsing, the no-picker cloud composition, Host path refusal/redaction including investment readiness, cloud holdings refusal, trusted and generic Remote error mapping, atomic transfer reservations, disposal linearized with blocked creation, stable path-free list diagnostics, active expiry cleanup, import-preview ownership across retries and unmount, client chunk validation/cancellation, fail-closed storage loading, managed-storage isolation, focus restoration, and accessible progress. The Web bundle is built as a separate delivery gate; full real-product Cloud Web UAT is tracked by PAB-21.
