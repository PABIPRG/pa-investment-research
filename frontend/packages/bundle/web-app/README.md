# `@deepseek-ai/dsh-web-app`

English | [中文](README.zh.md)

The dsh browser-surface bundle. [`cordis.patch.yml`](cordis.patch.yml) rides over [`dsh-base`](../base/README.md): it sets the coding persona, inserts the Web host rows and browser plugin roster, keeps the client-plugin reload chain mounted, and mounts this package's `web-runtime` glue plugin. The runtime resolves the built frontend dist, provides only explicitly configured public authorities to the browser-trust fence, mounts the [`frontend-static`](../../host/frontend-static/README.md) fallback owner, registers the model-visible Web surface plus `DSH_WEB_URL`, and prints one canonical URL after Loader settlement. The ordinary `web-startup` provider parses `--host`, `--port`, repeatable `--trusted-host`, repeatable `--trusted-proxy`, and `--help`. Loopback remains the default; `--host 0.0.0.0` is accepted only with required administrator authentication, at least one trusted HTTPS authority, at least one exact trusted reverse-proxy address, and secure cookies. In that mode the announced URL is `https://` plus the first trusted authority; no direct LAN HTTP URL is advertised. See [`docs/web-auth.md`](../../../docs/web-auth.md) for the proxy boundary and credential-file contract.

## Model Experience

### Harness-source and Web-surface context

#### What the model sees

When `surfaceContext` is true, the `harness:source` section identifies the on-disk Harness implementation without claiming it is the working directory, and the `app:web-surface` global section (order −98) orients the model to the GUI: the canonical local URL, the "this page" referent, the update contract (the reload receiver is always on; no-refresh reloads additionally need the `pnpm run dev:web` watcher), and the instruction not to start replacement servers. `DSH_WEB_URL` additionally appears in the managed bash environment with its description, resolved per invocation from the live server. When it is false, neither section nor the variable is registered.

#### Token effect

One source line and one prompt paragraph per session plus two managed-environment variable lines; constant per process.

#### KV Cache effect

The prompt section sits near the system prompt's head and is stable for the life of the process (the port is a boot fact), so it does not invalidate the cache across turns.

## Known Limitations and Deferred Work

- **The frontend dist must be built** — `require.resolve` of the dist fails loud at activation with a build hint; there is no source-serving fallback.
- **TLS terminates upstream** — this bundle validates only forwarding metadata from explicitly trusted proxy sockets; the deployment must prevent clients from reaching the backend HTTP listener directly.
