# @deepseek-ai/dsh-client-ui-settings-investment-research

English | [中文](README.zh.md)

Investment research Settings page for the `investment-research` Profile. Its first section, **Data & backup**, tells users that sent conversations and attachments are saved automatically on the device running the app. **Export current conversation** calls the existing `ctx.sessionLogDownload.download(currentSessionId)` controller. The resulting archive contains only the selected conversation, its related child conversations, and attachments; it is not a full local-data backup and this page does not provide an import or restore flow. The component observes the controller's shared state for disabled and busy feedback, while the existing Session Header action continues to own the one shared result modal.

The localized `settings.section` entry also projects only the secret-free snapshot supplied by `ctx.investmentResearchRuntimeClient`, including backend ownership, health, declared tool count, credential state, capability level, and the Host-provided Runtime log hint. Internal persistence implementation details are deliberately absent from the user interface.

The page never reads, receives, or stores a credential value. A missing `DEEPSEEK_API_KEY` presents only one credential action: `openSection('models')`, which keeps the Settings panel open and navigates to the existing Models page. A changed key presents an explicit application restart action through the facade. Its root-scoped interaction store reports pending, accepted, unavailable, and failed acknowledgements; readiness rechecks are single-flight and report failures independently. The UI never calls Electron directly.

The acceptance checklist asks the user to run health, read, write, stock-engine, and market-interpretation checks explicitly in the conversation. The page does not invoke `analyze_stock` or any other tool automatically, so a paid operation remains a deliberate user action.

## Model Experience

### Investment readiness Settings

#### What the model sees

Nothing. `InvestmentReadinessSnapshot`, the current Session id, and Session export state stay in the browser presentation path, and this package registers nothing model-facing. Checklist text is shown only to the user and is not sent to a model.

#### Token effect

Zero input and output tokens; the page does not make a provider request.

#### KV Cache effect

None; the page neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Source asset label is an increment-one delivery fact** — the current Host readiness DTO does not yet carry Runtime asset provenance. The bundled resolver increment will add `source-env-ready` / `bundled-ready` / `missing` / `invalid` to the Host snapshot and switch this row to that dynamic fact; the browser does not infer it from paths, the platform, or the filesystem.
- **No operation progress beyond restart acknowledgement** — accepted means the launcher took ownership of the quiescent restart request. The current process may exit before any later UI state can be rendered.
