# Agent Note: Investment product lifecycle workbench

Status: implemented

English | [中文](2026-08-26-investment-product-lifecycle-workbench.zh.md)

## Problem

The investment profile exposed real market and portfolio data but presented the remaining research capabilities as unrelated placeholders. Reports produced by asynchronous analysis had no product-wide retrieval point, strategy evidence did not flow into paper validation or evolution, and browser-generated context would have required copying business JSON into the conversation composer. Workspace selection also occupied primary navigation and blank-conversation space even though it only controls local storage.

Independent stock inputs shared one route value, so a selection or edit on one surface could unexpectedly change another surface. Starting a fresh conversation could also race with a pending assistant prefill and leave old draft text in the new session.

## Decision

The investment sidebar presents one ordered lifecycle: Intelligent Analysis, Realtime Watch, Strategy Research, Shadow Validation, Evolution, My Research, and Industry Chain. Existing route ids remain an internal presentation detail, while selection state carries the chosen stock and strategy across the relevant transitions. Strategy Research uses fixed Host operations for hypotheses, backtests, and lifecycle updates; Shadow Validation uses paper-account status, positions, equity, and tasks; Evolution reads attribution and requires a read-only preview before an explicit write confirmation.

The browser owns only view state, independent module drafts, and selected opaque ids. Trading facts, strategy lifecycle decisions, paper-account records, attribution, and reports remain backend-owned. Browser requests use the compile-time `InvestmentDataOperation` list; the Host rejects unknown keys and validates dynamic report, strategy, and task ids before encoding them into fixed routes.

Every successful asynchronous trading-core task is projected into a durable report record. The global Research Reports entry lists stable report metadata and reads one report as ordered sections, so analysis, backtest, and validation output has one retrieval path without copying internal task payloads into the browser.

Quantitative runners return auditable Markdown sections in their normal task result. The report store derives human-readable subjects from the strategy name, strategy id, validation scope, and trading date; the client localizes report types and timestamps and renders headings, lists, and tables as document structure. A strategy backtest only claims successful archival when report sections are actually returned, while Shadow Validation fails closed for an explicitly selected candidate strategy and reports a skipped reason instead of implying that paper trading ran.

Assistant actions convert typed UI intents into short natural-language instructions. They never serialize business data into the composer. The model calls `investment_context` with one fixed domain—`portfolio`, `strategy`, `shadow`, `evolution`, `reports`, or `industry`—or an existing stock or watch tool to read current backend state. The tool accepts no JSON context, URL, or path, and its result follows the normal logged tool-call lifecycle.

The profile marks workspace context as a Settings concern. The shared conversation keeps the agent preset visible but hides its workspace chip and picker under that generic placement marker; Investment settings uses the production Workspace and Session services to switch the local storage location. A first-run user can start with an implicit session target before choosing a storage location, and a visually covered workspace surface is also removed from keyboard and accessibility navigation. New Conversation cancels pending prefill ownership and clears the new session draft explicitly. Global security search, intelligent-analysis stock input, watch selection, and industry filter keep separate state.

Ordinary web subprocesses no longer eagerly load the optional PTY native module. The local subprocess adapter imports `node-pty` only when a terminal is requested, keeping product startup and browser regression independent from terminal-native availability.

The existing [progressive investment data loading decision](2026-08-24-investment-data-progressive-loading.md) continues to own independent resource settlement and stale-response protection for Realtime Watch and My Research. This note does not supersede the workspace product flow; it changes only where this profile presents workspace selection.

## Verification

Component contracts cover all seven navigation entries, report retrieval and Markdown rendering, typed assistant intents without JSON injection, independent drafts, fresh-session draft clearing, settings-only workspace selection, focus ownership for dialogs and drawers, and explicit-only strategy selection continuity. Host and tool tests cover operation allow-listing, input rejection before lease acquisition, context-domain routing, report projection, task id validation, active-only Shadow Validation, and real Loader composition. The keyless investment headless scenario assembles the production tool set and replays `investment_context`, stock analysis, and market-watch calls through durable session events.

The built investment profile was also exercised as a real browser product. The verification covered all seven modules, a real strategy backtest and persisted report round trip, a direct Shadow Validation entry with no stale candidate, a first-run session with no workspace configured, independent global/analysis/composer input state, blank New Conversation behavior, Settings-only storage placement, dark mode, and responsive widths from desktop down to 390 pixels. The final page session produced no browser errors.

## Alternatives considered

**Keep the four unimplemented navigation placeholders until separate products exist.** The backend already owns strategy, shadow, evolution, and impact data. Keeping inert pages would conceal working capabilities and preserve a broken research handoff rather than reduce product risk.

**Copy the page's complete JSON state into a prefilled prompt.** This duplicates backend facts in browser state, makes the composer unreadable, consumes tokens before the model knows which facts it needs, and bypasses durable tool-call provenance.

**Maintain reports only inside the originating page or conversation.** A user would need to remember which module and session launched each task, and completed background work would remain undiscoverable after navigation. A backend report index gives every product surface the same durable source.

**Apply evolution actions immediately after calculation.** Attribution can be incomplete and evolution changes strategy lifecycle state. Preview-first confirmation preserves operator authority and separates model interpretation from writes.

**Hide workspace controls with an investment-specific selector.** Coupling the shared conversation package to a profile name would make storage placement a theme exception. A generic placement marker expresses the product choice while retaining the normal workspace surface for every other profile.

## Consequences

The profile exposes a continuous evidence path from discovery through portfolio action, keeps model context concise and reconstructable, and gives generated reports a stable home. Users can move between strategy research, paper validation, and evolution without reselecting the strategy, while independent inputs cannot overwrite each other.

The UI depends on the Host operation list and backend response fields for all business pages; unsupported or unhealthy services remain visible as retryable empty or error states rather than simulated content. Task polling cannot cancel backend work and has a bounded foreground wait, but the durable report center preserves results that complete later. Workspace creation and advanced management stay with the existing workspace product; this profile exposes only storage selection in Settings.
