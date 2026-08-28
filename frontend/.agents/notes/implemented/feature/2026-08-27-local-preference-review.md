# Agent Note: Local preference review and learning facts

Status: implemented

English | [中文](2026-08-27-local-preference-review.zh.md)

## Problem

The investment product could attribute strategy outcomes and content performance, but it had no governed local fact stream for the user's own research behavior. Users could not inspect what they repeatedly opened, analyzed, or explicitly marked as relevant, and later self-evolution work had no reproducible preference snapshot to cite. Reusing free-form browser analytics would have risked persisting search terms, prompts, article text, portfolio amounts, or credentials, while sending these facts to an external trading endpoint would contradict the local product boundary.

The historical behavior profile also mixed interest evidence with an `aggression_delta`, and risk alerts previously allowed negative content feedback to influence severity. Those paths could turn curiosity or annoyance into an inferred change in risk capacity, which is not a valid suitability decision.

## Decision

The UI creates one bounded, memory-only telemetry recorder per mounted investment product. It records only enumerated page views, effective impressions, opens, analysis handoffs, and follow changes. Impression means at least 50 percent visibility for one second and is deduplicated per UI session; short React effect replays use a 750 ms moment window. Every event contains an opaque event id, an opaque session id, a structured target id, and a fixed context projection. It never contains client time, search text, prompt text, content titles or bodies, portfolio quantities or costs, URLs, paths, or credentials. Recording failures are swallowed at the accessory boundary and never block the product action.

The Host exposes personalized feedback plus five fixed local-learning operations for event write, status, settings, scoped clear, and deterministic review. Inputs are validated before backend acquisition. These operations run only through `owned` or `attached` trading-core leases; an `external` lease is released and rejected before any network request. The Python adapter assigns UTC time, rejects unknown fields and free-text identifiers, deduplicates by event id, and atomically applies a shared 90-day and 2,000-record limit across new events, legacy interactions, and current feedback. Feedback is last-value-wins per object. Pause stops new learning facts without changing normal research behavior, and the two-step clear removes only learning facts while preserving holdings, explicit risk data, strategies, validation results, and reports.

My Research owns a Preference Review subpage with 7-day and 30-day views, an explicit small-sample state, evidence counts, active-day counts, confidence, a view-to-open-to-analysis-to-feedback funnel, recent structured activity, safe aggregate export, pause/resume, and confirmed clear. The backend uses fixed versioned weights to produce top securities, industries, and strategies and includes a content-derived snapshot id. Non-critical card ordering may use the resulting interest evidence with reason codes. Critical warnings, explicit risk tolerance, risk budgets, strategy lifecycle, and suitability remain independent. Historical risk-adjustment fields stay at zero, effective aggression equals the explicit profile, alert severity ignores feedback, and strategy outcome attribution remains strategy evidence only.

## Verification

Backend tests cover schema projection, rejection of sensitive and free-text fields, authoritative time, atomic batches, retry idempotency, shared time and count retention, expiry without a later write, pause, feedback correction, scoped clear, deterministic snapshots, small samples, and the API routes. Safety regressions assert that repeated negative-news engagement, positive strategy outcomes, and repeated useless alert feedback cannot change explicit risk or alert severity.

Host tests cover every fixed route and body, invalid input before acquisition, strict context values, and rejection of all six local-only operations in external mode without `fetch` while still releasing leases. UI tests cover bounded dedupe, recorder failure isolation, effective impression timing, safe feedback and correction, Preference Review entry and return, windows, evidence, small samples, retryable failures, pause/resume, two-step clear, and safe export. The investment package is also checked by its normal typecheck, build, component, coverage, GUI, web snapshot, and runtime matrix gates.

## Alternatives considered

**Use a general analytics SDK or remote event service.** This would add a second identity and retention system and make external transfer the default. The product needs a local reviewable fact source, not growth analytics.

**Persist arbitrary event names and metadata, then redact during review.** Once raw prompts, search text, content, or portfolio amounts are written, later projection cannot restore data minimization. A closed protocol rejects the data before acquisition and storage.

**Infer risk tolerance from clicks, reading time, or negative feedback.** Research interest is not risk capacity. Explicit suitability input remains the only source for risk tolerance and budgets, while behavior can affect only non-critical content ordering.

**Store client timestamps and trust the browser for retention.** Client clocks are mutable and would make review windows and deletion non-reproducible. The local backend assigns authoritative UTC time.

**Build a second preference database.** The existing atomic JSON store already owns local investment state and legacy behavior. One governed behavior document avoids dual-write drift and supports an incremental migration.

## Consequences

Users can inspect and control the local evidence behind personalization, and future attribution or self-evolution work can cite a deterministic, versioned snapshot rather than an opaque score. The browser holds no durable analytics database, remote trading services never receive preference facts through this contract, and tracking outages do not degrade research actions.

The first release is single-user, uses fixed 7/30/90-day review windows, and intentionally reports no conclusions until at least three effective signals span two days. Preference export is an aggregate summary rather than raw data. New event types or context fields require an explicit protocol and privacy review on the UI, Host, and backend together; arbitrary metadata is not an extension point.
