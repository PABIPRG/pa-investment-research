# Agent Note: The desktop renderer runs on an application URL scheme rather than a file page with an IPC Fetch bridge

Status: implemented

English | [中文](2026-08-18-desktop-application-url-scheme.zh.md)

## Problem

The [Electron desktop carrier](2026-08-18-electron-desktop-carrier.md) loaded the renderer from a `file:` document and replaced the Web carrier's Fetch with a preload IPC bridge. That covers every Host request the Connection client makes, and nothing else.

The product does not address the Host only through that client. Session-log export builds `/api/session.export` against the page origin, issues a `HEAD` preflight with ordinary `fetch`, then hands the `GET` URL to the browser's download manager through an anchor, so the ZIP never buffers in JavaScript ([`dsh-session-log-export`](../../../../packages/session-query/session-log-export/README.md)). On a `file:` page those paths resolve against the filesystem root, and the button failed with `ERR_FILE_NOT_FOUND` on `file:///api/session.export`.

The failure is structural, not local to one feature. Any capability that gives Chromium a URL — a download, an `img` or media source, an iframe, a service worker — is unreachable from a `file:` origin no matter how complete the IPC bridge is, and each one would need its own desktop-specific branch. A `file:` page also cannot carry a meaningful Content-Security-Policy.

## Decision

The desktop application owns a URL scheme, `dsh://app`, registered as standard, secure, and Fetch-capable before the readiness event, and serves it with `protocol.handle`. The renderer loads `dsh://app/index.html`, so it has a real origin and the Web carrier's own Fetch and RPC code runs unchanged on the desktop. No socket listens: the handler answers in-process.

`createAppProtocolHandler` in `apps/electron/src/protocol.ts` resolves one request in a fixed order — Host paths, the index document, a client plugin bundle, then a renderer asset — and imports no Electron module, so the routing is unit-tested directly and the main process injects `net.fetch` as the file reader. Path ownership has one owner per layer: `ElectronConnectionService.owns()` answers for the API gateway and every registered RPC channel, and `ClientModuleRegistry.bundleFile()` resolves `/plugins/<id>/client.js[.map]` for both the Web bundle route and this scheme. A request that resolves outside the renderer directory is refused rather than served, because page code can reach the scheme.

Electron therefore stops rewriting the client boot graph into `file:` URLs and stops handing it to preload as a launch argument: the served index document is tapped with the same `injectBootManifest` the Web server uses, and the graph keeps its relative `/plugins/...` URLs.

The preload bridge keeps exactly one job, the Host event downlinks, because a push stream has no URL form the renderer can address and the desktop has no socket for the Web carrier's WebSocket. `ElectronApiClient` subclasses `WebApiClient` and overrides only `openMux`/`openHost`; unary, respond, and generic RPC take the inherited same-origin Fetch path. The removed bridge halves — `electronFetch`, `createElectronConnectionRpc`, the IPC fetch channels, the request/response message types, and the base64url manifest handoff — are deleted rather than kept behind a switch.

## Alternatives considered

- **Route the export feature through the Connection carrier and save from the main process**: the smallest change, but it buffers a whole session archive in renderer memory or invents a second save path, and it leaves the next URL-addressed capability with the same failure. The export controller is carrier-agnostic today precisely because the origin is real.
- **Serve the event streams over the scheme as Server-Sent Events too**: the Host already exposes `/api/events.mux` and `/api/events.host` as SSE, so one carrier could disappear entirely. Rejected for now because the IPC downlinks are proven and tested, and swapping the stream lifecycle is an independent change with its own reconnect semantics.
- **Start the Web server on loopback**: rejected earlier and still rejected — it reintroduces a listening socket, port allocation, and browser trust policy to cross a process-local application boundary. A custom scheme gives a real origin without any of that.
- **Keep `file:` and widen the preload API per feature**: every URL-addressed capability becomes a bespoke IPC method, and page code gains a growing surface that was never designed as a renderer capability.

## Consequences

- Session-log export works on the desktop with no Electron-specific code: the renderer's `HEAD` and `GET` reach the Host over `dsh://app`, and Chromium's download manager writes the ZIP.
- `asar` remains disabled, but the reason narrows: bundles now travel through the scheme rather than as filesystem-path scripts, so packing them behind an archive becomes a packaging decision instead of a renderer-loading one.
- The main process no longer validates IPC Fetch messages or their sender frame; scheme requests are same-origin by construction and the window still refuses navigation away from the index document. IPC validation remains for the two stream channels.
- A Content-Security-Policy is now expressible for the renderer document. None is set yet, so the DevTools insecure-CSP warning stands until one is chosen and verified against the client bundles, inline styles, and attachment blob URLs.
- The keyless proof covers scheme routing (Host paths, injected index, bundle content type, missing bundle, encoded directory escape, foreign authority, non-read method), the renderer carrier's same-origin unary Fetch, the stream lifecycle over IPC, and pre-readiness privilege registration. The desktop run was verified end to end: a resumed session renders, and the export button writes a valid ZIP containing `session.jsonl`.
