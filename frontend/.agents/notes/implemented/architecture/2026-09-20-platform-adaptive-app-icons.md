# Agent Note: Platform-adapted application icon assets

Status: implemented

English | [中文](2026-09-20-platform-adaptive-app-icons.zh.md)

## Problem

APP-ICON-001 used one full-bleed square bitmap for Windows, browser favicons, PWA installation, and Apple system surfaces. The shared pixels preserved brand identity but ignored incompatible platform responsibilities: Apple applies its own masks to square layers, Windows and browser chrome expose unmasked corners, and a PWA maskable icon needs an opaque background plus protected core artwork. The source package also contained byte-identical ordinary and maskable icons without evidence that the important mark fit the standard safe zone.

## Decision

The 1024×1024 `apps/electron/assets/app-icon.png` file is the canonical square brand master. Apple ICNS, Dock, and Apple Touch Icon resources keep square, unmasked artwork so the operating system owns the final shape, following [Apple's app-icon guidance](https://developer.apple.com/design/human-interface-guidelines/app-icons). Windows ICO frames, Web favicon resources, and PWA `purpose: any` resources receive a transparent 3/16-radius rounded plate. PWA `purpose: maskable` resources keep the full opaque square background and place every white trend-line pixel inside the [Web App Manifest safe circle](https://www.w3.org/TR/appmanifest/#icon-masks), whose radius is 40% of the icon size.

`scripts/generate-app-icon-assets.ts` derives every non-ICNS platform asset with repository-owned PNG decoding, area downsampling, antialiased alpha masking, PNG encoding, and ICO packaging. The generator verifies the recorded master digest and exposes a check mode that compares every output byte with the committed files. It does not redraw or infer any brand pixels.

## Verification

Focused tests compare committed assets with fresh generator output, decode final Web build resources, inspect every favicon and Windows ICO frame, require transparent rounded corners for Windows/Web ordinary icons, require opaque corners for Apple and maskable resources, and reject any white maskable-brand pixel outside the 40% safe circle. Electron Packager continues to resolve the final ICNS and ICO inputs, while release jobs compare the packaged macOS resource and extracted Windows executable icon with the repository assets.

## Alternatives considered

**Pre-round the shared master.** This produces one visually uniform bitmap, but it conflicts with Apple's system-owned masking and can create double-rounded or jagged edges.

**Declare the original ordinary PWA images as maskable.** This avoids extra files, but it leaves the maskable claim unverified and couples an opaque installation resource to ordinary-icon presentation.

**Use an image editor or generative model for each target.** Hand-authored exports can look correct once, but they are not reviewable as a repeatable transformation and can silently alter the approved brand mark.

## Consequences

Each platform receives the enclosure it owns while all variants retain the same approved artwork. Asset changes require updating the canonical master digest and regenerating committed derivatives, so accidental manual edits fail verification. The repository owns a small PNG/ICO implementation to avoid environment-dependent export tools; its supported PNG input remains deliberately limited to non-interlaced 8-bit RGBA images. Automated checks establish pixel and packaging facts, but Windows taskbar/EXE display, mobile installation, and operating-system upgrade caches remain target-platform UAT obligations.
