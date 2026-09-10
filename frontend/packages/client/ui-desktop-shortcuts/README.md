# @deepseek-ai/dsh-client-ui-desktop-shortcuts

English | [中文](README.zh.md)

Electron-only desktop shortcut feature. The Host half registers the `ui-desktop-shortcuts` settings namespace, while the Client half contributes a Shortcuts page to Settings only when the trusted preload capabilities are present. Defaults are derived for the current operating system and are not copied into user data.

| Action | macOS | Windows | Linux |
|---|---|---|---|
| Open Settings | `Command+,` | `Ctrl+,` | `Ctrl+,` |
| Toggle full screen | `Control+Command+F` | `F11` | `F11` |
| Minimize window | `Command+M` | System managed | System managed |

Shortcuts are application-local: Electron matches them only while the product window is focused. The editor captures one physical-key combination, refuses typing keys without a modifier, system-reserved combinations, and conflicts with another action, then writes only the current platform's custom layer. Users can reset one action or, after confirmation, every customization for the current platform; customizations saved for other platforms remain intact.

## Model Experience

None, as desktop shortcuts and their Settings page do not enter a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Focused window only** — the feature deliberately does not register global operating-system shortcuts and cannot act while the application is in the background.
- **No application-owned Windows/Linux minimize default** — those platforms' window-manager conventions remain authoritative; users may record an in-application alternative.
- **Physical key vocabulary** — customization supports letters, digits, common punctuation, and `F1`–`F24`; media keys and layout-specific keys are not persisted.
