# Agent Note: Platform-specific desktop shortcuts

Status: implemented

English | [中文](2026-09-10-platform-specific-desktop-shortcuts.zh.md)

## Problem

The Electron product had no keyboard path for opening Settings or controlling its window, and a single cross-platform map would violate established macOS, Windows, and Linux conventions. Customization also needs a durable reset boundary without letting one operating system overwrite another's choices.

## Decision

The `ui-desktop-shortcuts` package owns three application actions and a per-platform custom settings layer. macOS defaults to `Command+,`, `Control+Command+F`, and `Command+M`; Windows and Linux default to `Ctrl+,` and `F11`, while minimize remains system-managed. Defaults are code-derived and only overrides are persisted, so resetting deletes the current platform's override rather than writing a copy of the current release defaults.

The Electron main process matches `before-input-event` only for its focused window and executes native window operations there. It does not use `globalShortcut`. The sandboxed preload exposes the platform, capture suspension, and an action notification; the Connection service projects that trusted desktop capability to feature plugins without a forbidden runtime import between client packages. IPC capture requests are accepted only from the window's main frame.

The Settings section records physical-key combinations, validates a fixed key vocabulary, rejects unmodified typing keys, system-reserved shortcuts, and same-platform conflicts, and supports single-action and confirmed whole-platform reset. The base Settings domain exposes a small revisioned navigation service so the main-process Open Settings action can reveal the panel directly on the Shortcuts section. Ordinary and remote Web compositions expose no desktop section.

## Alternatives considered

**Register operating-system global shortcuts.** Rejected because these actions belong to the active product window; claiming them while the application is in the background would conflict with other applications and require broader OS permissions and lifecycle handling.

**Persist a complete resolved shortcut map.** Rejected because copied defaults would become stale across releases and resetting could unintentionally erase customizations for another operating system.

**Import the Electron bridge directly from the Connection client package.** Rejected because the client bundle graph forbids cross-plugin runtime imports; the optional capability is instead part of the injected Connection service.

## Consequences

Desktop users receive native defaults, immediate conflict feedback, durable customization, and predictable reset behavior. The same settings document can travel across operating systems without conflating platform choices. The cost is an intentionally limited physical-key vocabulary, no background shortcuts, and no application-owned minimize default on Windows or Linux. Unit and UI tests pin normalization, validation, persistence, panel navigation, secure IPC ownership, live Host adoption, and native action dispatch.
