# @deepseek-ai/dsh-client-ui-investment-research

English | [中文](README.zh.md)

The investment product UI for the `investment-research` profile. It keeps the production conversation, message, composer, attachment, tool, and approval surfaces, then adds a default Research Workbench, global security search, seven business modules, session history, and one report center through `shell.overlay`. The Research Workbench aggregates real holdings, portfolio risk, personalized events, explainable strategy matches, and pre-market brief tasks; it is distinct from the internal Workspace storage abstraction. Workspace remains hidden from the sidebar, blank-conversation flow, and product settings. On a first run with no registered Workspace, the profile creates a regular Host-cwd Session so the assistant is immediately usable.

The Research Workbench plus seven business entries form one evidence-driven `1+7` research lifecycle and never create demo data:

- Research Workbench is the default landing page. Its holdings, risk, alerts, personalized-event, and strategy-match regions settle independently; it labels holdings value as cost amount rather than pretending that cost price is a live market price. Personalized events request `comment: false`, so browsing does not depend on an LLM credential.

- Intelligent Analysis reuses the production conversation and model tools. Realtime Watch reads market scans, technical signals, and basic realtime news.
- Strategy Research turns real events into hypotheses and out-of-sample backtests. Opening strategy details is temporary inspection and does not select that card as the downstream work target; actions such as AI Review and Enter Shadow Validation carry the strategy selection explicitly. Shadow Validation reads paper-account state, positions, and equity. Evolution shows attribution and a read-only plan before a second, explicit confirmation can write to the strategy store.
- My Research reads persisted holdings, portfolio risk, and alerts and supports validated CSV, TSV, or pasted-table imports. Industry Chain checks local data status first and downloads about 25 MB of licensed data only after explicit user confirmation on first use. Once ready, it reads statistics, company search, and layered upstream/downstream relations from the `industry-chain` backend while keeping event transmission as a separate secondary reference. Download, search, and chain refreshes expose their own loading, empty, failure, and retained-stale-data states.

Realtime Watch and My Research settle each data region independently, display completed regions immediately, and keep failures and retries local. An unsettled identical request is reused, same-key refreshes retain the last successful value, and late superseded responses cannot replace the current selection. Strategy backtests and shadow runs poll the real task state; successful backend tasks persist formal reports.

Realtime Watch explicitly requests basic news without event enrichment or personalized ranking, so its first view does not wait for the slow complete-source or optional LLM paths. Partial-source and stale-cache responses are labeled; enrichment remains an explicit backend capability.

Ignoring a late response protects browser state; it is not network cancellation. The current Host transport does not accept an `AbortSignal` from this page, so a superseded backend request still runs to settlement.

The browser cannot supply a backend address, port, URL, or arbitrary path. Every request uses a stable operation name that the Host maps to a fixed endpoint while managing the backend lease. The Host also validates dynamic report, strategy, and task identifiers before inserting them into a fixed route.

Session history uses the production Session service for title and content search, opening, renaming, and archival. New Conversation cancels any pending prefill and explicitly clears the new session draft. AI actions prefill only a short tool intent rather than business JSON; after the user sends it, the model reads current state through `investment_context` or the appropriate analysis or watch tool. The global Research Reports entry lists persisted reports from analysis, backtest, and validation tasks.

## 主题与浮层约束

Feature styles use only `--dsw-alias-*` semantic tokens from `ui-theme`, with no React inline styles, literal colors, `--dsw-static-*` palette variables, or component theme selectors. Shared colors are defined in `ui-theme` before this package consumes them. `pnpm run verify-client-theme-styles` scans current and future CSS Modules and TypeScript presentation sources and rejects invalid or unknown tokens.

Theme preference is read and changed only through `ctx.theme`. Application-level modal surfaces render through a React Portal on `document.body` and use the application modal layer and semantic mask token so content, top-bar, and sidebar stacking contexts cannot clip them.

## Model Experience

### Investment workbench

#### What the model sees

The model does not directly see market, portfolio, strategy, or report JSON read by the pages. Only a short tool intent that the user confirms and sends follows the production `ctx.conversation` assembly path. The model then calls `investment_context` or another tool as needed, and the tool result enters context through durable conversation events.

#### Token effect

Browsing and refreshing business pages consumes no model tokens. AI actions only prefill a short intent; after the user sends it, the prompt and subsequent tool results consume tokens under normal conversation rules.

#### KV Cache effect

Business pages do not create model requests, so they do not affect the KV cache. After the user sends a prefilled intent, caching behaves like other messages and tool calls in the same session.

## Known Limitations and Deferred Work

- Pages render backend responses defensively without duplicating strategy, shadow, or evolution policy in the browser.
- Host errors remain visible and retryable; the UI never falls back to prototype data.
- Superseded responses can be ignored but Host requests cannot yet be cancelled. A task that exceeds the UI wait window continues in the backend and can later be found in the report center.
