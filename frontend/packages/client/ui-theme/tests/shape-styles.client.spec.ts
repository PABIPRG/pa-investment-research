import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const platformCss = read('../src/styles/design-platform.css')
const buttonCss = read('../../ui-primitives/src/Button.module.css')
const inputCss = read('../../ui-primitives/src/Input.module.css')
const modalCss = read('../../ui-primitives/src/Modal.module.css')
const segmentedControlCss = read('../../ui-primitives/src/SegmentedControl.module.css')
const toastCss = read('../../ui-primitives/src/Toast.module.css')
const authCss = read('../../../../apps/web/src/web-auth.module.css')

describe('semantic shape scale', () => {
  it('defines the five product shape roles in the shared client theme', () => {
    expect(platformCss).toContain('--dsw-alias-radius-compact: 6px;')
    expect(platformCss).toContain('--dsw-alias-radius-control: 8px;')
    expect(platformCss).toContain('--dsw-alias-radius-module: 12px;')
    expect(platformCss).toContain('--dsw-alias-radius-overlay: 16px;')
    expect(platformCss).toContain('--dsw-alias-radius-pill: 999px;')
  })

  it('keeps shared controls, modules, and overlays on their semantic roles', () => {
    expect(buttonCss).toContain('border-radius: var(--dsw-alias-radius-control);')
    expect(buttonCss).toContain('border-radius: var(--dsw-alias-radius-compact);')
    expect(inputCss).toContain('border-radius: var(--dsw-alias-radius-control);')
    expect(modalCss).toContain('border-radius: var(--dsw-alias-radius-overlay);')
    expect(segmentedControlCss).toContain('border-radius: var(--dsw-alias-radius-control);')
    expect(segmentedControlCss).toContain('border-radius: var(--dsw-alias-radius-compact);')
    expect(toastCss).toContain('border-radius: var(--dsw-alias-radius-module);')
  })

  it('uses the same shape roles on the web authentication surface', () => {
    expect(authCss).toContain('border-radius: var(--dsw-alias-radius-overlay);')
    expect(authCss).toContain('border-radius: var(--dsw-alias-radius-module);')
    expect(authCss).toContain('border-radius: var(--dsw-alias-radius-control);')
  })
})
