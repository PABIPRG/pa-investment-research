# Agent Note: Security names in hypothesis previews

Status: implemented

English | [中文](2026-09-23-hypothesis-preview-security-names.zh.md)

## Problem

The strategy hypothesis preview displayed only six-digit security codes, making its related securities difficult to identify before adding a candidate to the pool.

## Decision

The preview uses the existing security-name resolver and strategy ticker parsing. It displays each resolved name before its code. A missing catalog result is labeled as a name pending completion alongside the code, without inventing a security name.

## Alternatives considered

**Keep codes alone and add a lookup link.** That would still make the confirmation view unreadable without another action.

**Hardcode names for currently observed codes.** Those mappings would become stale and would bypass the shared catalog.

## Consequences

The preview becomes readable as name plus code when the catalog responds. During lookup failure or before resolution, the code remains visible with an explicit pending-name label. The preview performs catalog lookups for symbols that did not carry a valid name.
