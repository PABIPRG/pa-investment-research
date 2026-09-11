# Agent Note: Single-image investment container runtime

Status: implemented

English | [中文](2026-09-11-single-image-container-runtime.zh.md)

## Problem

The investment profile composes one Node Host and three Host-owned Python services, while a server deployment needs one auditable artifact identity, one durable state owner, one scheduler owner, and one authenticated network edge. Installing dependencies during startup, publishing backend ports, or starting several containers against one state root would make the running system differ from the reviewed artifact and break process or scheduler ownership.

## Decision

The root `Dockerfile` builds one Linux x86_64 image in two stages. The build stage installs the lockfile-governed pnpm graph, compiles the Host and Web application, materializes a relocatable production CLI closure, and assembles a checksum-pinned Python 3.10 runtime with exact-version Python requirements and all three backends. The runtime stage contains those outputs and OS libraries selected during the build; it runs as the unprivileged `dsh` user and performs no dependency installation or compilation.

`compose.yaml` publishes only the Web port on host loopback, requires the existing Web authentication and trusted Host/proxy boundary, declares `DSH_DEPLOYMENT_SURFACE=cloud-web`, mounts one named volume at `$DSH_HOME`, and keeps the root filesystem read-only. The entrypoint accepts only that exact deployment value and passes the validated declaration to the CLI child process; direct image starts with a missing, padded, or different value fail before acquiring application resources. A tmpfs receives the copied administrator hash and temporary files. `TZ` and `TIMEZONE` must name the same zone so Node and Python schedulers share wall-clock behavior.

The container entrypoint claims an atomic lock directory under the mounted investment state and refreshes a token-bearing heartbeat every two seconds. A second container rejects a live lease; an abandoned lease becomes replaceable after ten seconds. The CLI records that outer token in its existing application-instance lock. A successor may quarantine an inner lock only when it carries the expired outer token, even if its namespace-local PID was reused; an unmarked or current-token owner retains the ordinary conflict behavior. The token controls release, so a stale owner cannot delete a successor's lease. The entrypoint forwards termination signals to the CLI and bounds shutdown inside the Compose grace period.

The image health command checks the Web authentication readiness endpoint and the identity-bearing health endpoints of trading-core, market-watch, and industry-chain over container loopback. Pull Request CI builds and starts the commit-tagged image without pushing it, asserts the runtime and network boundaries, then exports the exact verified image plus archive checksum, image ID, and BuildKit metadata. The operational procedure lives in the [container deployment and rollback guide](../../../../../docs/maintainers/容器部署与回滚.md).

## Alternatives considered

**Install Node or Python dependencies at container startup.** Rejected because registry availability and mutable dependency resolution would change startup behavior and separate the running bytes from the reviewed image.

**Run each Python backend in its own container.** Rejected because the shipped Runtime already owns backend lifecycle and state assignment; splitting services would add an orchestration protocol and cross-container ownership model outside this release.

**Use PID files or the existing localhost control port as the cross-container lock.** Rejected because container PID and network namespaces do not provide shared liveness. A heartbeat in the already shared durable filesystem preserves one scheduler owner without adopting another namespace's process.

**Publish the image from Pull Request CI.** Rejected because PR validation is not release authorization. The workflow exports a content-verifiable image archive that can be promoted by an explicitly authorized delivery process.

**Infer Cloud Web from the container image, authentication mode, or bind address.** Rejected because packaging and network topology do not grant product capabilities. The same explicit deployment declaration consumed by the Host is validated before the container starts its application process.

## Verification

Container contract tests pin the Dockerfile stages, non-root runtime, Compose port and volume surface, exact Cloud Web declaration and child-process inheritance, fail-closed startup configuration, and exclusive lease behavior. Sidecar tests pin the Linux descriptor and existing package privacy rules. Pull Request CI provides the real Linux image build, symlink closure, non-root/read-only assertions, Compose aggregate health, graceful stop, and commit-addressed export evidence. PAB-21 owns the reverse-proxy browser path and full business UAT in a real container environment.

## Consequences

One image and one volume give operators a small deployment and rollback unit while retaining the Host's existing backend authority. Builds are larger because the image carries three Python dependency sets and a complete Node production closure. Exact Python versions do not pin every wheel hash, and Debian packages are resolved during the build, so separate builds are not claimed to be byte-for-byte reproducible; the exported image digest and checksums identify the bytes that CI actually verified. The lease assumes storage with atomic directory creation, consistent modification times, and durable writes; unsuitable network filesystems are unsupported. A ten-second stale-lease interval trades immediate crash restart for protection against overlapping scheduler owners. Registry publication and multi-host orchestration remain separate, authorized delivery decisions.
