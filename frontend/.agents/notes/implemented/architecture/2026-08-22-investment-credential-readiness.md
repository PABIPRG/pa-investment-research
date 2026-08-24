# Agent Note: Investment credential readiness and application restart

Status: implemented

English | [中文](2026-08-22-investment-credential-readiness.zh.md)

## Problem

The investment profile needs one DeepSeek credential across two Python services without creating a second settings input, persisting the secret in backend files, or giving a local credential to a process the application does not own. A credential update also cannot silently leave new analysis requests using the old value captured by a running child.

## Decision

The existing Models page remains the sole product writer for `DEEPSEEK_API_KEY`. The credential provider resolves the reference only for an owned managed spawn, and each backend definition carries an explicit reference-to-environment allowlist. Attached and external services receive no local credential. Runtime logs, state, errors, readiness DTOs, and Client services expose only safe facts and redact forwarded values across stream boundaries.

The Host Runtime owns readiness and capability preflight. Its snapshot reports backend ownership, credential lifecycle, capability level, tool count, restart requirement, and a log path without exposing the value. Business tools declare whether DeepSeek is required, an enhancement, or unused, and check the Runtime immediately before any LLM-dependent HTTP or SSE work. The Client mounts only the investment Remote, projects it through a dedicated facade, and renders a separate Investment settings page. Missing credentials navigate to Models; the page never contains a Key input or invokes a paid tool.

Updating the credential marks active owned backends `restart-required`. Electron owns one application-level restart path: it drains IPC, disposes the complete Profile, waits for leases and owned process trees, then relaunches with the original arguments. A new process resolves the credential again. Attached and external processes are never stopped or given the local Key.

The stock HTTP/SSE adapter remains deferred to the established adapter-client change. That change keeps tool-entry capability checks and Runtime definitions in the business package; it does not take ownership of credentials, readiness, or restart.

## Alternatives considered

**Copy the Key into each backend `.env`.** Rejected because it creates multiple writable secret sources and leaves rotation, deletion, and support diagnostics ambiguous.

**Inject the local Key into every reachable endpoint.** Rejected because health and identity do not prove process ownership. Attached and external operators remain responsible for their own credentials.

**Restart a child immediately after every update.** Rejected because business HTTP/SSE operations do not yet share a complete drain owner. The application-level quiescent restart provides one observable safety boundary.

**Put investment Remote methods in the global Client remotes package.** Rejected because ordinary Web profiles do not require the optional Host Runtime. The investment bundle owns its Client facade and settings page.

## Consequences

Users enter the Key once and receive explicit missing, read-only, configured, and restart-required states. New LLM-dependent operations cannot continue with a stale child credential, while declared non-LLM operations may remain available. The design adds an explicit restart after rotation and keeps independently supervised services outside local credential and process ownership. Packaged Python assets can replace the source resolver later without changing the credential, preflight, or restart owners.
