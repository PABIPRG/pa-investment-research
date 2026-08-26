# @deepseek-ai/dsh-electron

English | [中文](README.zh.md)

Electron desktop application for DeepSeek Harness. It boots the selected profile (`web` by default), serves the Host and a relative-path build of the existing Web renderer from its own `dsh://app` URL scheme, and carries the event downlinks over IPC. The desktop application therefore reuses the selected profile's client plugins, sessions, settings, and `$DSH_HOME` while its native patch removes the Web listening carrier.

## Launch from source

From the repository root:

```sh
pnpm install
pnpm run build
pnpm dsh electron
pnpm dsh electron --profile investment-research
```

`electron` is an application selector, not a profile name: `dsh --profile electron` looks for a user profile and does not launch the desktop runtime. `pnpm dsh electron` checks the built main process, sandboxed preload, and renderer, then starts the default `web` profile through its local Electron executable without rebuilding. `pnpm dsh electron --profile investment-research` is the product entry for the five-layer investment profile; use `pnpm dsh --profile investment-research --dump-default-config` separately for configuration diagnostics. `pnpm run start:electron` remains the build-and-launch convenience command; `pnpm --filter @deepseek-ai/dsh-electron run start` launches existing artifacts directly.

## Investment backend deployment

The shipped business rows default to `managed`: stock analysis uses `http://127.0.0.1:8000`, market watch uses `http://127.0.0.1:8100`, and source launches discover their projects in this repository. A packaged or relocated deployment sets each row's absolute `backendProjectDir`; an independently supervised endpoint uses `backendMode: external` plus `backendBaseUrl`, which verifies identity but never starts or stops the process. These fields belong in `$DSH_HOME/profiles/investment-research/cordis.patch.yml`; remember that a row patch replaces its complete `config`.

A missing managed virtual environment fails with the project directory and `./init.sh` or `init.bat` instruction; startup never installs it. Runtime logs and diagnostic state live under `$DSH_HOME/investment-research/<backend-id>/`, and state never authorizes PID takeover. Stock-analysis in-chat brief delivery defaults to `enableInChatPush: false`; Python scheduler and external delivery settings stay backend-owned. See the [Runtime package contract](../../packages/investment-research/python-runtime/README.md) for paths, retention, and ownership details.

## Investment workflow

For a source launch, run `pnpm run investment:python:init` once and `pnpm run investment:python:verify` whenever the environments need checking. Open the existing Models settings page and store the DeepSeek Key once; do not copy it into either backend `.env`. The Investment settings page shows the two backend states, 9 stock tools, 11 market-watch tools, credential readiness, capability level, and each log path. An attached or external service manages its own credentials and never receives the local Key.

After a Key update, the page requests one explicit application restart. Electron first drains IPC, disposes the Profile, waits for tools, leases, and owned process trees, then relaunches with the same profile arguments. Before the restart finishes, new LLM-dependent calls are refused instead of using the old child credential.

Acceptance remains user-driven: in a conversation, check `watch_list`, run `watch_add` and `watch_list` again, run `get_watchlist`, and then explicitly approve one paid `analyze_stock` call plus one market-watch data tool. The settings page lists these steps but never invokes them automatically.

## Package the application

The desktop package pipeline and Electron Forge maker are available from the repository root:

```sh
pnpm run package:electron
pnpm run make:electron
```

`package:electron` builds a self-contained production deployment plus the current native Python sidecar and creates an unpacked application under `apps/electron/out/`. The sidecar is copied to `Resources/investment-python`; build caches and staging directories are never copied. `make:electron` also runs Electron Forge's configured maker to create a ZIP for the current platform and architecture under `apps/electron/out/make/`. Run `node scripts/smoke-investment-python-sidecar.ts --root <Resources/investment-python>` against the final resource directory. The ZIP is unsigned; release signing/notarization remains a distribution gate, while the `Investment packaged sidecar` workflow performs native arm64/x64/Windows artifact smoke and ad-hoc macOS signature verification.

## Runtime structure

- The main process resolves exactly one `--profile <name>` argument (`web` when absent), passes that profile to `runProfile`, and then applies only `electron.patch.yml`. For `investment-research`, the profile first composes base → web-app → investment-runtime → investment-stock-analysis → investment-market-watch → investment-industry-chain; the Electron patch then disables the Web server, static Web runtime, Web Connection provider, adaptive browser directory picker, and client HMR before mounting the native directory-picker pair and Electron Connection provider.
- The main and preload bundles leave the `electron` module external because the Electron executable provides it at runtime.
- The ESM main module schedules application startup without top-level-awaiting `app.whenReady()`, allowing Electron's readiness event to run after initial module evaluation. Registering the `dsh` scheme as standard, secure, and Fetch-capable happens during that module evaluation, because Electron accepts the privilege list only before readiness.
- The profile installation anchor resolves bare plugins from the healed profile dependency directory. App boot uses public Node resolution when Electron does not expose Node's internal module loader.
- `src/protocol.ts` routes one `dsh://app` request in a fixed order: Host paths, the index document with the client boot graph injected, a client plugin bundle, then a renderer asset. It imports no Electron module, so the main process passes `net.fetch` in as the file reader. A path resolving outside the renderer directory is refused.
- Because the renderer has a real origin, everything addressable by URL — unary RPC, uploads, and the session-log ZIP download — uses the ordinary Web client code. Preload exposes only the two event-stream methods. The renderer has context isolation and Chromium sandboxing enabled, with Node integration disabled.
- The main process validates every IPC stream request and accepts messages only from the window's main frame. Navigation stays on the renderer document; HTTP(S) links open externally.

Client-plugin HMR and live profile-patch watching are not active in the desktop application because Electron does not expose the Node loader internals required by Cordis HMR. Rebuild and restart Electron after changing a client bundle; restart it after changing either `cordis.patch.yml` layer.

## macOS native-addon startup

A source checkout copied or downloaded by a GUI client can carry `com.apple.quarantine` onto installed native dependencies. If macOS reports that `pty.node` cannot be verified, finish the dialog and quit that launch; do not move the file to Trash. Confirm that the addon came from this lockfile and a trusted checkout, then reinstall dependencies from a checkout that does not carry quarantine, or have an administrator clear the attribute only from the verified local dependency under the organization's policy. `xattr -p com.apple.quarantine <path-to-pty.node>` is a read-only diagnostic. The application never clears quarantine automatically.

This warning occurs while the shared local subprocess provider eagerly loads `node-pty`; it is not a Python backend health or virtual-environment failure. A distributable macOS application must sign and notarize the application and native addons; the current Forge ZIP is unsigned, so clearing quarantine in a developer checkout is not a production distribution fix.

## Model Experience

The desktop carrier does not change model-visible content; it runs the same Web profile and session protocol.

#### KV Cache effect

None; the Electron layer only changes local transport and application packaging.
