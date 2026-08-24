# bundle/ — profile plugin bundles

English | [中文](README.zh.md)

Profile bundles: npm packages whose manifest declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, making them installable patch layers for `dsh --profile` compositions ([profile contract](../boot/app-boot/README.md#profiles)). A bundle's substance is its patch list; some also ship runtime glue plugins their patch mounts.

| Package | Role | ctx key |
|---|---|---|
| [`base/`](base/README.md) | The shared dsh core every profile applies first | — (patch only) |
| [`web-app/`](web-app/README.md) | Browser surface: web patch layer + runtime glue plugin | mounts rows |
| [`headless/`](headless/README.md) | Direct one-shot task mode over base, with no Host or Web layer | mounts `headless-runner` |
| [`investment-runtime/`](investment-runtime/README.md) | Shared investment Python Runtime; must precede the capability bundles | mounts `investment-python-runtime` |
| [`investment-stock-analysis/`](investment-stock-analysis/README.md) | Independently removable stock-analysis capability | mounts `investment-stock-analysis` |
| [`investment-market-watch/`](investment-market-watch/README.md) | Independently removable market-watch capability | mounts `investment-market-watch` |

In-box bundles resolve from the dsh installation; out-of-tree bundles install into a profile through `dsh plugin --profile <name> add <package>`.

The shipped `investment-research` profile applies `base`, `web-app`, `investment-runtime`, `investment-stock-analysis`, then `investment-market-watch`. The last two bundles contain no process or business implementation; each business plugin acquires its backend from the preceding Runtime layer.
