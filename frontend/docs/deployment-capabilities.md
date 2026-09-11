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

Cloud Web retains manual holdings entry, bulk browser import, backup creation, authenticated backup download, browser upload, import preview, explicit import, and reset. Backup storage is presented as managed storage; no server directory is shown or selectable.

The Host rejects directory listing/creation/picking, path opening, custom session working directories, workspace adoption by path, settings-document opening, agent-preset directory opening, and local broker/native-holdings operations. Session and Workspace projections omit canonical Host paths. These checks are server-side and remain effective if a caller bypasses the UI.

The backup browser protocol is bounded: only a direct `.pabackup` file in the configured backup directory can be selected, symlinks and non-files are rejected, archives are validated before transfer, files larger than 64 MiB are rejected, and capacity is reserved atomically before file I/O. The opened file size is checked again and exactly that many bytes are read, so concurrent growth cannot enlarge the allocation. At most two immutable downloads remain resident (128 MiB aggregate compressed-archive ceiling). Concurrent validation may transiently retain those 128 MiB plus at most 256 MiB of bounded uncompressed archive payload (384 MiB logical payload ceiling, excluding allocator overhead); the validation payload is released before chunk transfer. Chunks are ordered and size-checked; completion, cancellation, expiry, or error releases the resident session. A live expiry timer removes abandoned snapshots even when no later request arrives.

Authentication remains the transport boundary supplied by Web auth. This capability matrix narrows deployment behavior; it does not widen authentication policy. Container/process sandboxing and service health belong to the cloud deployment work that follows this change.
