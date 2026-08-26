# @deepseek-ai/dsh-client-ui-investment-research

English | [中文](README.zh.md)

Profile-specific investment research workbench UI. The package keeps the production shell's sessions, messages, composer, attachments, tools, approvals, and workspace services. It replaces the business navigation and adds the workbench surfaces through `shell.overlay`.

The sidebar organizes eight product areas into four groups:

- Overview: Research Workbench.
- Analysis and monitoring: Intelligent Analysis and Real-time Monitoring.
- Strategy loop: Strategy Research, Shadow Validation, and Self-evolution.
- Personal research and graph: My Research and Industry Chain.

The Research Workbench is the default route. It combines holdings, risk alerts, personalized market events, strategy matches, and the current risk profile without turning the page into another chat transcript. Real-time Monitoring uses the `market-watch` scan, technical signal, and news operations. My Research reads and edits holdings, watchlist entries, KYC, risk profile, behavioral profile, and portfolio risk on its current page. Industry Chain performs company search, company and entity profiles, five-column chains, multi-level expansion, and network slicing on its current page. Strategy Research, Shadow Validation, and Self-evolution read their corresponding strategy, shadow-position, equity, readiness, and attribution operations.

Each independent data region loads and fails independently. A completed region renders immediately, a failed region keeps its own retry action, and a refresh keeps the last successful value visible while the replacement request runs. Request generations prevent a late response for an old selection from overwriting the current selection. This is a browser state guard, not network cancellation; the current Host transport does not receive an `AbortSignal` from these pages.

The browser never supplies a backend origin, port, or arbitrary path. Every read and business write uses a stable operation name that the Host maps to a fixed route and backend lease. Stock and holdings analysis, briefs, historical backtests, strategy hypotheses and persistence, strategy backtests and state transitions, shadow validation, and evolution all call their backend workflows from their owning pages. Only result interpretation and follow-up research enter the investment assistant.

The floating assistant entry and page-level research actions open the production conversation area beside the current business route without compressing the page, navigation, or state loss. Every entry creates an independent conversation through the Workspace service and then writes structured business context into that conversation's shared composer; historical conversations are never reused. Module context combines the click-time page snapshot, a module backend snapshot, and compact overall data, and explicitly limits the task to financial research rather than code or project analysis. The user reviews and sends the message, so model selection, attachments, approvals, and send policies remain unchanged. The history drawer continues to use the production Session and Workspace services for search, open, rename, and archive actions.

## Theme and overlay constraints

Feature styles in this package use only `--dsw-alias-*` semantic tokens supplied by `ui-theme`. React inline styles, color literals, `--dsw-static-*` palette variables, and feature-level light/dark selectors are not allowed. Shared colors must first be defined as semantic tokens in `ui-theme`. `pnpm run verify-client-theme-styles` scans every current and future CSS Module and TypeScript rendering source in this package, and CI rejects violations or undefined tokens.

Theme preference is read and changed only through `ctx.theme`. Modal overlays that must cover the whole application mount on `document.body` through a React Portal and use the application modal layer and semantic mask token, so content containers, the top bar, or sidebar stacking contexts cannot clip them.

## Model Experience

### Investment workbench

#### What the model sees

The model receives no page data while the user only browses. After an assistant interpretation action, the page snapshot, module backend snapshot, and compact overall data form a structured draft. They enter the normal `ctx.conversation` context assembly path only after the user reviews and sends it.

#### Token effect

Browsing, filtering, refreshing, and running backend workflows consume no model tokens. An assistant interpretation action prefills bounded structured context; after the user sends it, token use depends on the page snapshot size and is counted with ordinary messages in that conversation.

#### KV Cache effect

Direct-data pages do not create model requests and therefore do not affect the KV cache. A sent prefilled prompt follows the same caching behavior as other messages in the active conversation.

## Known Limitations and Deferred Work

- The browser presents backend responses defensively but does not duplicate backend business rules.
- A Host or backend error remains a visible, retryable real-data state; the UI does not substitute fabricated results.
- Superseded responses can be ignored in React state, but the already-dispatched Host request continues until it finishes.
- Unified tasks currently use status polling to retrieve results. If the page closes or the app restarts, an in-memory task must be queried again with the task id returned by the backend.
