# Agent Note: Semantic shape scale and in-product brand identity

Status: implemented

English | [中文](2026-09-20-semantic-shape-and-brand-identity.zh.md)

## Problem

Shared controls, authentication, and investment-research surfaces used unrelated corner radii for the same visual roles. Buttons appeared as capsules while inputs remained rectangular, overlays ranged from 14px to 24px, and page-owned modules introduced additional values. The login gate displayed APP-ICON-001, but the in-product brand used a text sparkle; event and research controls also used emoji-like text glyphs whose shape varied by platform. These differences weakened hierarchy and made the product identity inconsistent between entry and working surfaces.

## Decision

The client theme owns five semantic shape tokens: `--dsw-alias-radius-compact` at 6px, `--dsw-alias-radius-control` at 8px, `--dsw-alias-radius-module` at 12px, `--dsw-alias-radius-overlay` at 16px, and `--dsw-alias-radius-pill` at 999px. Shared buttons, inputs, segmented controls, toasts, and modals consume the token matching their role. Product surfaces reuse the same tokens for touched modules and overlays; the pill token remains limited to status, metadata, and deliberately capsule-shaped affordances. [`DESIGN.md`](../../../../../DESIGN.md) owns the standing visual rule.

APP-ICON-001 is the product identity on both the web login gate and investment-research brand area. The login primary action, focus treatment, and restrained page glow use the business-blue semantic color. Research, assistant, target, and event-type affordances use deterministic inline SVG paths while keeping visible Chinese labels and accessible names; text emoji are not product icons.

## Verification

Component tests lock the shared app-icon path and the event-type SVG plus text label. Focused client tests, type checking, the web build, and rendered light/dark reviews at desktop and narrow widths cover the affected entry and workbench surfaces.

## Alternatives considered

**Keep component-local numeric radii.** This preserves each historical screenshot but leaves equivalent controls visually unrelated and makes future drift likely.

**Make every interactive element a capsule.** This gives one recognizable silhouette, but it erases the distinction between ordinary controls and status or filter chips and conflicts with the product's dense research layout.

**Continue using text glyphs for compact icons.** This avoids SVG markup, but glyph appearance depends on the operating system and font and cannot reliably preserve the approved product identity.

## Consequences

The entry and in-product surfaces share one brand asset, ordinary controls and overlays have predictable silhouettes, and business icons render consistently across platforms and themes. The semantic tokens add an explicit dependency for client CSS, and future exceptions require choosing a role or documenting why the standard scale cannot express the surface. The source application icon and platform mask declarations remain unchanged; platform-specific icon cropping is outside this decision.
