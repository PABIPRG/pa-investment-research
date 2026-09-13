# Deployment capability matrix

English | [中文](deployment-capabilities.zh.md)

Deployment authority is declared by `@deepseek-ai/dsh-host-deployment-capabilities`. Browser code consumes the authenticated `host.describe` snapshot and never infers permissions from `navigator.platform`, the URL, or the bind address.

| Capability | CLI | Local Web | Electron | Cloud Web |
|---|---:|---:|---:|---:|
| Browser upload/download | No | Yes | Yes | Yes |
| Host directory picker/browser | N/A | Yes | Yes | No |
| Reveal absolute Host paths | N/A | Yes | Yes | No |
| Open a Host path in a native app | Yes | Yes | Yes | No |
| Local broker synchronization | Yes | Yes | Yes | No |
| Native holdings adapter | No | No | Yes | No |
| Holdings providers | Manual + platform providers | Manual + platform providers | Manual + platform providers | Manual only |

## Cloud Web boundary

The production investment container declares `DSH_DEPLOYMENT_SURFACE=cloud-web` in Compose. Its entrypoint accepts only that exact value before starting the CLI and explicitly passes the validated declaration to the child process. Starting the image without the declaration, or overriding it with another deployment mode, fails before application state or network services are opened.

Cloud Web retains manual holdings entry, bulk browser import, backup creation, authenticated backup download, browser upload, import preview, explicit import, and reset. Backup storage is presented as managed storage; no server directory is shown or selectable. Managed storage always uses the instance-owned default and ignores a custom directory saved by an earlier local deployment without overwriting that setting.

The Host rejects directory listing/creation/picking, path opening, custom session working directories, workspace adoption by path, settings-document opening, agent-preset directory opening, and local broker/native-holdings operations. Session, Workspace, and investment Runtime readiness projections omit canonical Host paths. These checks are server-side and remain effective if a caller bypasses the UI.

The backup browser protocol is bounded: only a direct `.pabackup` file in the active storage directory can be selected, symlinks and non-files are rejected, archives are validated before transfer, files larger than 64 MiB are rejected, and capacity is reserved atomically before file I/O or decompression. At most two download snapshots and two previews can be active. Uploads allow four concurrent sessions with a 128 MiB aggregate reservation; preview reservations have the same 128 MiB compressed-byte ceiling. The opened file size is checked again and exactly that many bytes are read, so concurrent growth cannot enlarge the allocation. Chunks are ordered and size-checked. Runtime disposal closes the shared creation gate, aborts and waits for in-flight resource creation, then releases memory, reservations, and temporary upload files; later creation attempts fail closed. Completion, cancellation, error, or the active fifteen-minute expiry timer performs the same scoped cleanup without waiting for another request. Backup-list diagnostics are stable and never include raw Host file errors or paths.

Authentication remains the transport boundary supplied by Web auth. Transfer ownership is not yet associated with an authenticated principal, so logout cannot synchronously reclaim that principal's resources after cancel RPCs begin returning 401; global quotas and the active fifteen-minute timer bound that residual lifetime. Closing this limitation requires the Connection/Gateway request Context to carry an authenticated owner into the Runtime. Container/process sandboxing and service health remain separate deployment concerns.
