# Task 4 report — Python-only backend wrappers

## Scope

- Worktree: `/private/tmp/pa-investment-research-dsh-migration`
- Baseline commit: `98b02f35fb8379f915c71e98ab3fe8db4bb3b69d`
- Changed only the Task 4 backend wrappers, listed backend documents, and the stale Python docstring that named the old host source. `backend/market-watch/market_watch/app.py` was not enumerated in the Files list, but its one-line old-path docstring was the minimal necessary change to satisfy Task 4's explicit backend-wide purity scan.

## RED baseline

Command:

```sh
rg -n 'dsh-plugin|npx @deepseek-ai/dsh|--patch|:3080|:3081' backend
```

Exit code: `0` (expected RED).

Key output showed both backends still owning dsh lifecycle: `backend/dsh-trading-core/start_all.bat` generated a patch and started a Web UI on the old extra port; `backend/market-watch/start.sh` and `start_all.bat` started a Web UI on the other old extra port. `init.*` installed host dependencies, `verify.*` ran host smoke tests, `stop_all.*` stopped both ports, and selected documentation retained the old source references.

Node/TypeScript manifest check at RED time:

```sh
rg --files backend | rg '(^|/)(package(-lock)?\.json|pnpm-lock\.yaml|cordis\.ya?ml)$|\.tsx?$'
```

Exit code: `1`; there were already no matching backend manifest or TypeScript files. The failure was expected because the command lists matches.

## GREEN verification

```sh
rg -n 'dsh-plugin|npx @deepseek-ai/dsh|--patch|:3080|:3081' backend
```

Exit code: `1` (no matches).

```sh
test -z "$(rg --files backend | rg '(^|/)(package(-lock)?\.json|pnpm-lock\.yaml|cordis\.ya?ml)$|\.tsx?$')"
```

Exit code: `0` (no backend Node manifest, lockfile, Cordis config, TypeScript, or TSX file).

```sh
bash -n backend/dsh-trading-core/init.sh backend/dsh-trading-core/verify.sh \
  backend/dsh-trading-core/start.sh backend/dsh-trading-core/stop_all.sh \
  backend/market-watch/init.sh backend/market-watch/verify.sh \
  backend/market-watch/start.sh backend/market-watch/stop_all.sh
```

Exit code: `0`.

```sh
(cd backend/dsh-trading-core && ./verify.sh)
```

Exit code: `0`. Key output: `Ran 1 test ... OK`; Python import verification completed.

```sh
(cd backend/market-watch && ./verify.sh)
```

Exit code: `0`. Key output: `Ran 1 test ... OK` and `Python imports OK`.

Static Windows wrapper review confirmed that `init.bat` installs Python requirements and imports Python modules; `verify.bat` runs only the health-contract unittest and import; `start_all.bat` starts only the corresponding uvicorn API; and `stop_all.bat` addresses only `8000` or `8100`. No BAT command was run on macOS.

## Concerns

- `stop_all.*` intentionally remains a manual, port-based backend convenience wrapper. It can affect a listener on that port, so the documents and comments explicitly state that it is not the Phase 2 Runtime's owned-handle implementation.
- Windows command execution was not performed on macOS. Its syntax and ownership semantics were checked statically; Windows CI or a Windows host should execute the wrappers when that platform is in scope.
- `dsh electron --profile investment-research` is documented uniformly as a Phase 2 deliverable and is not enabled by this task.
