# Agent Note: Live holdings-provider switching

Status: implemented

English | [中文](2026-09-10-holdings-provider-live-switch.zh.md)

## Problem

The holdings-provider setting wrote `backend.env` without changing the running trading-core process. The settings page therefore required an application restart, while source-mode startup did not load the file it wrote and the project `.env` could take precedence over the saved user choice. The holdings dialog exposed synchronization but not provider selection, and provider fallbacks could reveal internal values such as `manual`.

## Decision

`PUT /holdings/user-config` applies `HOLDINGS_PROVIDER` to the running `Settings` instance and process environment after persisting it. The response reports the effective provider and does not require a restart when that is the only changed key. Other environment entries retain their restart requirement.

Startup loads the user `backend.env` in both managed-state and source modes before the project `.env`, with `override=False` for every file. The resulting priority is explicit process environment, user configuration, project `.env`, then code defaults.

Both the investment settings page and the holdings synchronization panel present platform-relevant provider choices with product labels. A successful choice reports that it is active in the current window; the synchronization panel reloads provider availability and prevents broker synchronization while manual entry is selected.

## Alternatives considered

**Restart the complete application after every selection.** This preserved the original immutable startup settings but interrupted the user's holdings task and still did not correct source-mode persistence or configuration precedence.

**Keep provider selection only in Settings.** This left the action separated from the synchronization workflow where users need to understand and change the source.

**Display backend provider identifiers.** Stable identifiers remain appropriate for API payloads, but exposing them as interface copy makes platform and broker choices harder to understand.

## Consequences

Provider switches become immediately observable without restarting the application and survive ordinary future launches. An explicitly supplied process environment still wins on startup, so developer-managed launches can intentionally override the saved product choice. Provider metadata is currently repeated at the backend and the two localized UI owners; adding or renaming a provider requires updating those lists together.
