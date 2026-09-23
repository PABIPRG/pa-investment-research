# Agent Note: Manual trade history and current holdings choice

Status: implemented

English | [中文](2026-09-23-manual-trade-history-choice.zh.md)

## Problem

People may record their current holdings before entering older transactions. Applying every later entry to holdings counts some trades twice, while rejecting older timestamps prevents a complete transaction history. Native `datetime-local` controls also show different date orders and clock conventions across browsers and operating systems.

## Decision

The trade form requires an explicit choice between “already included, record history only” and “not included, update current holdings.” The first choice appends only to `holdings.manual_trades` and leaves `holdings.default` and snapshots intact. The second computes quantity and cost from current holdings and records a current snapshot. Both paths use the existing preview, document version check, request idempotency, atomic write, and mutation audit. A backdated trade that updates holdings states that existing snapshots are not recalculated. Legacy clients without an explicit choice retain the backdated guard with a plain explanation of the available actions.

The form uses a fixed local `YYYY/MM/DD HH:mm:ss` text format and the shared date picker. It validates the calendar date and clock before sending a timezone-aware instant. The history list displays timezone-aware records in the viewer's local time, keeps timezone-free broker timestamps at their recorded clock time, and identifies whether a manual record changed current holdings.

## Alternatives considered

**Replay older trades and rewrite snapshots automatically.** Broker sync, direct edits, and imports can create snapshots without a complete transaction ledger, so historical quantity and cost cannot be reconstructed reliably.

**Always append history only or always update current holdings.** Whether a trade is already included depends on the user's entry order and cannot be inferred from its timestamp.

**Set a language on the native date control.** Its visible format can still follow browser and operating system settings.

## Consequences

People can enter older trades and choose whether they affect current holdings. History-only entries create an auditable transaction change without a new holdings snapshot. Every manual trade now needs one extra choice. Backdated entries that update holdings use current holdings as their starting point and do not represent a recomputation of historic positions. The date picker changes the date while the fixed-format text field holds the time of day.
