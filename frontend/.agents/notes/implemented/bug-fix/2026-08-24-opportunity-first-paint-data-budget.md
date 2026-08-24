# Agent Note: Opportunity discovery has bounded first-paint data paths

Status: implemented

English | [中文](2026-08-24-opportunity-first-paint-data-budget.zh.md)

## Problem

The non-chat opportunity route requested flash news with event enrichment and personalization during its first render. That synchronous path could wait for every configured source and a 60-second optional LLM call even though the page only renders headlines. Cold K-line retrieval also tried three providers sequentially without a foreground deadline, and concurrent requests could repeat the same external work.

## Decision

`OpportunityPage` requests base flash news with `enrich=false` and `personal=false`. The page labels this data as base news and reports partial-source or stale-cache responses explicitly. Changing the scan kind does not change the news request key; only a page refresh or news-region retry requests news again. Full-source aggregation, event enrichment, and personalized ordering remain explicit `news-flash` capabilities rather than first-paint work.

The market-watch backend gives base news a 1.5-second total deadline, a 15-second fresh TTL, a five-minute stale window, and one refresh flight. Cold requests return completed fast sources at the deadline; stale requests return immediately while the one refresh continues. The explicit full tier has its own cache and a 10-second source deadline before optional event and LLM work.

K-line reads use a per-code-and-lookback single flight, a 60-second fresh TTL, a 30-minute stale window, and a 2.5-second cold foreground deadline. A stale hit returns while refresh continues. A cold timeout returns HTTP 504 with an explicit background-refresh message; it does not claim that the stock has no data. Optional quote-name lookup has a separate 0.3-second budget.

## Alternatives considered

**Run enrichment in the first-paint request and hide it behind progressive UI.** Independent React regions cannot make a slow news request produce headlines before that request settles. The backend operation itself needs a base tier with a time budget.

**Return rule-enriched data under the enriched response fields when the LLM is slow.** That would silently change the requested capability. The base and full tiers remain explicit, and full enrichment retains its documented fallback behavior.

**Cancel provider threads at the deadline.** Python cannot safely stop an already running blocking provider call. Bounded foreground waits, bounded provider timeouts, TTL/stale caching, and single-flight limit user latency and source pressure while those calls finish naturally.

## Consequences

- The opportunity route can display base news after at most the configured 1.5-second source budget instead of waiting for full-source or LLM enrichment.
- Partial and stale responses remain useful and visible; source failures do not erase an available cache.
- A cold technical-signal request either receives K-line data within 2.5 seconds or gets an explicit retryable timeout while the shared refresh continues.
- Fake clock, HTTP session, source, and concurrency tests enforce deadlines, stale behavior, and single-flight source counts without external network or LLM access.
