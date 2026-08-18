# @deepseek-ai/dsh-electron

English | [中文](README.zh.md)

Electron desktop application for DeepSeek Harness. It boots the shipped `web` profile, serves the Host and a relative-path build of the existing Web renderer from its own `dsh://app` URL scheme, and carries the event downlinks over IPC. The desktop application therefore uses the same profile, client plugins, sessions, settings, and `$DSH_HOME` as `dsh web` without opening a listening port.

## Launch from source

From the repository root:

```sh
pnpm install
pnpm run build
pnpm dsh electron
```

`electron` is an application selector, not a profile name: `dsh --profile electron` looks for a user profile and does not launch the desktop runtime. `pnpm dsh electron` checks the built main process, sandboxed preload, and renderer, then starts the application through its local Electron executable without rebuilding. `pnpm run start:electron` remains the build-and-launch convenience command; `pnpm --filter @deepseek-ai/dsh-electron run start` launches existing artifacts directly.

## Package the application

The desktop package pipeline and Electron Forge maker are available from the repository root:

```sh
pnpm run package:electron
pnpm run make:electron
```

`package:electron` builds a self-contained production deployment and creates an unpacked application under `apps/electron/out/`. `make:electron` also runs Electron Forge's configured maker to create a ZIP for the current platform and architecture under `apps/electron/out/make/`. The ZIP is unsigned; add signing/notarization credentials and further Forge makers in `forge.config.ts` when distribution requirements are known.

## Runtime structure

- `electron.patch.yml` disables the Web server, static Web runtime, Web Connection provider, adaptive browser directory picker, and client HMR, then mounts the native directory-picker pair and Electron Connection provider.
- The main and preload bundles leave the `electron` module external because the Electron executable provides it at runtime.
- The ESM main module schedules application startup without top-level-awaiting `app.whenReady()`, allowing Electron's readiness event to run after initial module evaluation. Registering the `dsh` scheme as standard, secure, and Fetch-capable happens during that module evaluation, because Electron accepts the privilege list only before readiness.
- The profile installation anchor resolves bare plugins from the healed profile dependency directory. App boot uses public Node resolution when Electron does not expose Node's internal module loader.
- `src/protocol.ts` routes one `dsh://app` request in a fixed order: Host paths, the index document with the client boot graph injected, a client plugin bundle, then a renderer asset. It imports no Electron module, so the main process passes `net.fetch` in as the file reader. A path resolving outside the renderer directory is refused.
- Because the renderer has a real origin, everything addressable by URL — unary RPC, uploads, and the session-log ZIP download — uses the ordinary Web client code. Preload exposes only the two event-stream methods. The renderer has context isolation and Chromium sandboxing enabled, with Node integration disabled.
- The main process validates every IPC stream request and accepts messages only from the window's main frame. Navigation stays on the renderer document; HTTP(S) links open externally.

Client-plugin HMR and live profile-patch watching are not active in the desktop application because Electron does not expose the Node loader internals required by Cordis HMR. Rebuild and restart Electron after changing a client bundle; restart it after changing either `cordis.patch.yml` layer.

## Model Experience

The desktop carrier does not change model-visible content; it runs the same Web profile and session protocol.

#### KV Cache effect

None; the Electron layer only changes local transport and application packaging.
