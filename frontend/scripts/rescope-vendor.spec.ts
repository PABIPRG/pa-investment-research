/**
 * Acceptance-path coverage for the rescope codemod's exact-edit classifier: a
 * duplicated insertion — what a non-idempotent apply produces — must be
 * rejected rather than applied again.
 */

import { describe, expect, it } from 'vitest'
import { exactEditState, rewriteVendorReferences } from './rescope-vendor.ts'

const ANCHOR = '\n## Sync procedure'
const INSERTED = `\n15. **rescope**: one log entry.\n${ANCHOR}`

describe('exactEditState', () => {
  it('classifies an insertion by its target form, so a duplicate is invalid', () => {
    expect(exactEditState(`log\n${ANCHOR}\n`, ANCHOR, INSERTED, 1)).toBe('pending')
    expect(exactEditState(`log${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('applied')
    // The anchor survives an insertion, so counting the source form would have
    // called this pending and inserted the entry a second time.
    expect(exactEditState(`log${INSERTED}${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('invalid')
    expect(exactEditState('log\n', ANCHOR, INSERTED, 1)).toBe('invalid')
  })

  it('classifies a deletion by its source form, and requires its remainder to survive', () => {
    const remainder = 'exclude:\n'
    const withEntries = 'exclude:\n  - cordis@4\n'
    expect(exactEditState(withEntries, withEntries, remainder, 1)).toBe('pending')
    expect(exactEditState(remainder, withEntries, remainder, 1)).toBe('applied')
    // Upstream dropped the whole field: the source form is gone, but so is the
    // remainder, so this is a moved site rather than a completed deletion.
    expect(exactEditState('unrelated:\n', withEntries, remainder, 1)).toBe('invalid')
  })

  it('requires a replacement to leave no source form and the exact target count', () => {
    expect(exactEditState('a = 1\n', 'a = 1', 'b = 2', 1)).toBe('pending')
    expect(exactEditState('b = 2\n', 'a = 1', 'b = 2', 1)).toBe('applied')
    expect(exactEditState('b = 2\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    // A moved or partially applied site: neither state is complete.
    expect(exactEditState('a = 1\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    expect(exactEditState('x\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
  })
})

describe('rewriteVendorReferences', () => {
  it('重写 Cordis 包引用，但保留扩展事件和本地化标识', () => {
    expect(rewriteVendorReferences([
      "import { Context } from 'cordis'",
      "ctx.emit('cordis/request-run', {})",
      "const prefix = 'cordis/'",
      "const signature = '\\'cordis/request-run\\'(request: Request): void'",
    ].join('\n'), 'packages/extensions/cordis-host-runner/src/index.ts')).toEqual({
      text: [
        "import { Context } from '@deepseek-ai/cordis'",
        "ctx.emit('cordis/request-run', {})",
        "const prefix = 'cordis/'",
        "const signature = '\\'cordis/request-run\\'(request: Request): void'",
      ].join('\n'),
      lines: 1,
    })

    expect(rewriteVendorReferences(
      [
        "import { Context } from 'cordis'",
        "const NS = 'cordis'",
      ].join('\n'),
      'packages/extensions/ui-cordis/src/client/locales.ts',
    )).toEqual({
      text: [
        "import { Context } from '@deepseek-ai/cordis'",
        "const NS = 'cordis'",
      ].join('\n'),
      lines: 1,
    })
  })

  it('即使子路径形似产品事件，也重写模块说明符', () => {
    expect(rewriteVendorReferences(
      "import run from 'cordis/request-run'",
      'packages/extensions/cordis-host-runner/src/index.ts',
    )).toEqual({
      text: "import run from '@deepseek-ai/cordis/request-run'",
      lines: 1,
    })
  })
})
