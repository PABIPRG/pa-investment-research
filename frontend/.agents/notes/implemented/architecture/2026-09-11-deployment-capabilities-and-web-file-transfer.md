# Agent Note: Deployment capabilities are explicit and browser backup transfer is bounded

Status: implemented

English | [中文](2026-09-11-deployment-capabilities-and-web-file-transfer.zh.md)

## Problem

Local Web, Electron, CLI, and Cloud Web shared UI and Host methods but had no authoritative deployment classification. Browser platform inference could select a local broker adapter, while an authenticated cloud client could still discover or submit server paths. Investment backups supported Host-local files only, so a cloud browser could import neither a selected file nor download an existing archive.

## Decision

`@deepseek-ai/dsh-host-deployment-capabilities` provides one immutable snapshot for the process. Base composition declares CLI, Web startup explicitly declares `local-web` or `cloud-web` through `DSH_DEPLOYMENT_SURFACE`, and Electron overrides it with `electron`. `host.describe` carries the snapshot to the Client.

Consumers fail closed from that snapshot. Cloud Web mounts no directory picker, omits Host paths from Host, Session, and Workspace projections, rejects path-bearing creation and native-open methods, and limits holdings to manual entry or bulk import. Local surfaces preserve their existing platform-specific provider roster.

Investment backup upload keeps the established chunked Remote flow and import preview. Stored backup download uses a separate bounded Remote session so the authenticated transport protects every chunk without buffering an unbounded request body. Before its first file await, the Host atomically reserves one of two slots, rechecks the opened file size, then performs a fixed-size read and validates a direct `.pabackup` archive. Two compressed snapshots have a 128 MiB resident ceiling; concurrent validation can transiently reach a 384 MiB logical payload ceiling including bounded decompression, excluding allocator overhead. It requires exact offsets and removes the session on completion, cancellation, error, active-timer expiry, or Runtime disposal. The browser propagates cancellation into each Remote, validates declared spans, assembles a Blob, downloads it, and revokes the object URL.

## Consequences

- UI visibility is only an affordance; Host checks enforce the same cloud restrictions against crafted requests.
- Cloud users see managed backup storage and can download, upload, preview, cancel, retry, import, or reset without learning a server directory.
- Broker discovery and synchronization never execute in Cloud Web. The UI directs the user to manual entry or bulk import.
- The deployment matrix is documented in [`docs/deployment-capabilities.md`](../../../../docs/deployment-capabilities.md).
- Web authentication remains unchanged. Container isolation and health/readiness remain separate deployment concerns.

## Verification

Package tests cover the four capability snapshots, explicit startup parsing, the no-picker cloud composition, Host path refusal/redaction, cloud holdings refusal, bounded backup download and cleanup, client chunk validation/cancellation, and managed-storage/manual-only UI states. The Web bundle is also built and exercised on an isolated Cloud Web port before delivery.
