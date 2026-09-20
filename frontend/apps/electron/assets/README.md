# Application icon

English | [中文](README.zh.md)

PAB-22 / APP-ICON-001 is the 0.2.0 application icon. The original bundle is stored at `../icon-source/app-icons-0.2.0.zip`; its `original/icon-1024.png` file is identical to the canonical 1024×1024 square brand master `app-icon.png`.

Original bundle SHA-256: `749e4a5d41f28757149a4f5aefab779f164e7fecec3cd65d3c53a61229a42f01`.

Apple resources retain unmasked square layers: `app-icon.icns` packages 1x/2x slices at 16, 32, 128, 256, and 512 pixels from the square master, while the runtime Dock icon uses the square `app-icon.png` and lets macOS apply the final rounded mask. This follows [Apple App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons) guidance for unmasked square layers.

Windows `app-icon.ico` uses a transparent rounded plate and contains PNG frames at 16, 24, 32, 48, 64, 128, and 256 pixels. Web favicons and PWA `purpose: any` resources follow the same platform-adaptation rule but are generated as separate assets; the Apple Touch Icon remains an unmasked square resource. PWA `purpose: maskable` resources use an opaque full-bleed background, with the white trend line inside the central 40%-radius safe circle defined by the [Web App Manifest](https://www.w3.org/TR/appmanifest/#icon-masks).

Run `pnpm run gen-app-icons` to regenerate the Windows ICO, Web favicons, Apple Touch Icon, and PWA icons from `app-icon.png`; run `pnpm run verify-app-icons` to compare repository assets byte-for-byte with the deterministic derivation. The script neither redraws nor generates brand content, and it does not rewrite the Apple master or ICNS. Packaging configuration passes the platform-specific `.icns`, `.ico`, or PNG path explicitly, checks that the target file exists before assembly, and promotes Packager warnings about a skipped required format to failures.

The 0.2.0-alpha.2 release and UAT matrix covers only macOS arm64/x64, Windows x64, Web/PWA, and mobile touch installation. Linux `.desktop` / hicolor installation resources are outside this milestone; the term cross-platform refers only to the listed targets and does not claim validated Linux installation integration.

Web resources live under `apps/web/public/icons/app-icon-001/`, using an isolated path to avoid the old icon cache. The manifest preserves the application name, launch path, and display mode and declares separate 192/512-pixel `any` and `maskable` resources. The two purposes use different bytes, and automated checks cover transparent corners, opaque backgrounds, and the trend-line safe zone.

Acceptance covers browser tabs, touch entry points, macOS Dock/Finder, Windows executables and taskbar, and operating-system icon caches after installation upgrades.

## Local verification record (2026-09-11)

Verdict: code and resource integration are implemented; the real Web entry passed two-theme, two-viewport UAT, while cross-platform desktop release UAT remains Inconclusive.

- passed: 22 Electron packaging tests, 15 release-workflow tests, 2 Web PWA tests, and 1 real frontend-static Loader/HTTP composition test covering PNG/ICO GET and HEAD.
- passed: host TypeScript checking and the complete build comprising `build:lib`, `build:web`, and `build:electron`.
- passed: byte-identical source image; seven ICO PNG frame sizes and offsets, the ICNS container, manifest dimensions, and real Electron Packager `.icns` / `.ico` resolution.
- passed: Electron Forge make and strict signature verification on the local `darwin-arm64` host. The final `.app` names `electron.icns` in `CFBundleIconFile`; the packaged ICNS SHA-256 equals the source file, extraction shows ten 1x/2x slices from 16–1024px, and assembly logs contain no `.icon`, missing-icon, or skipped-icon-format warning.
- passed: with isolated `DSH_HOME=/private/tmp/pab22-dsh-home-3093`, `dsh web --port 3093` loaded the real Web shell. Light and dark themes at 1440×900 and 1024×768 had no clipping or layout defect. Screenshots remain in the browser-tool record for that Codex task.
- passed: the DOM references the manifest, ICO, 32px PNG, and Apple Touch Icon. ICO, PNG, and manifest requests returned HTTP 200 with `image/x-icon`, `image/png`, and `application/manifest+json`; the manifest declared the 192/512 icons correctly.
- not-tested: native macOS Finder/Dock surfaces because automation lacked Finder access, mobile touch installation, the final Windows package's native display, and macOS/Windows upgrade caches. The entry screenshots used the Web shell without starting the investment-research backend.

The PAB-22 owner completes the missing evidence before the 0.2.0-alpha.2 release by installing and upgrading the artifacts associated with PAB-15 and retaining screenshots of Dock/Finder, the Windows taskbar/executable, and browser shortcuts. Business loading, filtering, permissions, dangerous actions, and undo states are unaffected by this static application-icon change.

## Platform-adaptation verification record (2026-09-20)

Verdict: pixel and build evidence passed; target-system installation-surface UAT remains Inconclusive.

- passed: `verify-app-icons` reproduced 10 derived assets byte-for-byte; 38 focused icon-generation and Electron packaging tests and 2 final-build Web PWA tests passed; strict TypeScript checking for the new scripts and the complete `pnpm run build` passed.
- passed: every Windows ICO frame at 16, 24, 32, 48, 64, 128, and 256px has the expected dimensions, transparent rounded corners, and opaque center. Final Web build resources for favicons, PWA `any`, Apple Touch Icon, and PWA `maskable` decode correctly. Both maskable sizes have fully opaque corners and no white trend-line pixel outside the central 40%-radius safe circle.
- passed: real image rendering covered the 16px and 256px Windows ICO frames, the 192px maskable icon, and the 180px Apple Touch Icon. The brand mark remains recognizable, Apple resources stay square, and platform assets do not reuse one pre-masked bitmap.
- not-tested: native browser tabs and PWA installation UI, mobile touch installation, the final Windows EXE and taskbar, macOS Finder/Dock, and macOS/Windows upgrade caches. This worktree had no allocated persistent service port, and browser security policy rejected the local-file entry; build and pixel checks cannot establish these results.

## Windows release-icon regression

Release run `34578047814` recorded a Windows warning that the `.ico` could not be found and the application icon was skipped. The run succeeded overall, which did not prove the icon was embedded. The current packaging passes `app-icon.ico` explicitly, exercises the pinned Packager WindowsApp `getIconPath()` implementation, and checks the seven PNG frame headers, dimensions, and offsets. CI also extracts the final EXE's associated 32px icon and compares its pixels with the source ICO. The regression belongs to PAB-22 and relates to PAB-15. Existing published assets are unchanged; the final Windows native display and upgrade cache still require the next release-candidate UAT.

## macOS Packager warning

Electron Packager 18 probes Apple Icon Composer's optional `.icon` format even when a valid `.icns` exists; the `extension ".icon"` warning alone does not mean the `.icns` is missing. The implementation filters only that optional probe and confirms the `.icns` file before assembly. Packaging fails immediately if the `.icns` itself is missing or skipped. CI also checks `CFBundleIconFile` and compares the ICNS in the `.app` resources directory byte-for-byte with the source file.

The original ZIP stays under `icon-source/` and is excluded from the Electron `files` publish allowlist; installation packages contain only runtime icon assets. Mainline retains the asset-packaging policy and download-cache regression coverage.
