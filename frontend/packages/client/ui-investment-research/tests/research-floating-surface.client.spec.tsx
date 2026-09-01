// @vitest-environment jsdom
import { StrictMode, useState } from 'react'
import { createPortal } from 'react-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ResearchFloatingSurface } from '../src/client/ResearchFloatingSurface.tsx'
import type { ResearchSurfaceMode } from '../src/client/research-types.ts'

const BREAKPOINT_QUERY = '(max-width: 900px)'
const styles = readFileSync(
  resolve(process.cwd(), 'packages/client/ui-investment-research/src/client/InvestmentShell.module.css'),
  'utf8',
)
const componentSource = readFileSync(
  resolve(process.cwd(), 'packages/client/ui-investment-research/src/client/ResearchFloatingSurface.tsx'),
  'utf8',
)

interface MediaHarness {
  readonly add: Mock<(type: string, listener: (event: MediaQueryListEvent) => void) => void>
  readonly match: Mock<(query: string) => MediaQueryList>
  readonly remove: Mock<(type: string, listener: (event: MediaQueryListEvent) => void) => void>
  readonly notificationCount: () => number
  readonly setMatches: (matches: boolean) => void
}

function installMatchMedia(initialMatches = false): MediaHarness {
  let matches = initialMatches
  let notifications = 0
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const add = vi.fn((_: string, listener: (event: MediaQueryListEvent) => void) => {
    listeners.add(listener)
  })
  const remove = vi.fn((_: string, listener: (event: MediaQueryListEvent) => void) => {
    listeners.delete(listener)
  })
  const media = {
    get matches() { return matches },
    media: BREAKPOINT_QUERY,
    onchange: null,
    addEventListener: add,
    removeEventListener: remove,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList
  const match = vi.fn((query: string) => {
    expect(query).toBe(BREAKPOINT_QUERY)
    return media
  })
  vi.stubGlobal('matchMedia', match)
  return {
    add,
    match,
    remove,
    notificationCount: () => notifications,
    setMatches(nextMatches) {
      matches = nextMatches
      for (const listener of listeners) {
        notifications += 1
        listener({ matches, media: BREAKPOINT_QUERY } as MediaQueryListEvent)
      }
    },
  }
}

function createSurfaceRefs(ownerDocument = document) {
  const trigger = ownerDocument.createElement('button')
  trigger.textContent = '打开研究窗'
  const background = ownerDocument.createElement('main')
  const scrollContainer = ownerDocument.createElement('div')
  ownerDocument.body.append(trigger, background, scrollContainer)
  return {
    trigger,
    background,
    scrollContainer,
    triggerRef: { current: trigger },
    backgroundRef: { current: background },
    scrollContainerRef: { current: scrollContainer },
  }
}

function installMatchMediaOn(ownerWindow: Window, initialMatches = false): MediaHarness {
  let matches = initialMatches
  let notifications = 0
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const add = vi.fn((_: string, listener: (event: MediaQueryListEvent) => void) => {
    listeners.add(listener)
  })
  const remove = vi.fn((_: string, listener: (event: MediaQueryListEvent) => void) => {
    listeners.delete(listener)
  })
  const media = {
    get matches() { return matches },
    media: BREAKPOINT_QUERY,
    onchange: null,
    addEventListener: add,
    removeEventListener: remove,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList
  const match = vi.fn((query: string) => {
    expect(query).toBe(BREAKPOINT_QUERY)
    return media
  })
  Object.defineProperty(ownerWindow, 'matchMedia', {
    configurable: true,
    value: match,
  })
  return {
    add,
    match,
    remove,
    notificationCount: () => notifications,
    setMatches(nextMatches) {
      matches = nextMatches
      for (const listener of listeners) {
        notifications += 1
        listener({ matches, media: BREAKPOINT_QUERY } as MediaQueryListEvent)
      }
    },
  }
}

function disableChromeActions(): void {
  for (const name of ['最小化研究窗', '停靠研究窗', '展开研究窗', '关闭研究窗']) {
    const button = screen.queryByRole('button', { name }) as HTMLButtonElement | null
    if (button !== null) button.disabled = true
  }
}

function installAnimationFrames() {
  let nextId = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  const canceled = new Set<number>()
  const request = vi.fn((callback: FrameRequestCallback) => {
    nextId += 1
    callbacks.set(nextId, callback)
    return nextId
  })
  const cancel = vi.fn((id: number) => { canceled.add(id) })
  vi.stubGlobal('requestAnimationFrame', request)
  vi.stubGlobal('cancelAnimationFrame', cancel)
  return {
    request,
    cancel,
    canceled,
    run(id: number) { callbacks.get(id)?.(0) },
  }
}

function installAnimationFramesOn(ownerWindow: Window) {
  let nextId = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  const request = vi.fn((callback: FrameRequestCallback) => {
    nextId += 1
    callbacks.set(nextId, callback)
    return nextId
  })
  const cancel = vi.fn()
  Object.defineProperties(ownerWindow, {
    requestAnimationFrame: { configurable: true, value: request },
    cancelAnimationFrame: { configurable: true, value: cancel },
  })
  return {
    request,
    cancel,
    run(id: number) { callbacks.get(id)?.(0) },
  }
}

function createForeignRealm(initialMatches = false) {
  const iframe = document.createElement('iframe')
  document.body.append(iframe)
  const ownerDocument = iframe.contentDocument
  const ownerWindow = iframe.contentWindow as (Window & typeof globalThis) | null
  if (ownerDocument === null || ownerWindow === null) {
    throw new Error('测试环境未创建 iframe realm')
  }
  const media = installMatchMediaOn(ownerWindow, initialMatches)
  const refs = createSurfaceRefs(ownerDocument)
  const mount = ownerDocument.createElement('div')
  ownerDocument.body.append(mount)
  return { ownerDocument, ownerWindow, media, refs, mount }
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  document.body.style.overflow = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ResearchFloatingSurface', () => {
  it('renders no surface when closed and a named restore entry when minimized', () => {
    installMatchMedia()
    const refs = createSurfaceRefs()
    const onModeChange = vi.fn()
    const view = render(
      <ResearchFloatingSurface
        mode="closed"
        subject={{ code: '600519', name: '贵州茅台' }}
        onModeChange={onModeChange}
        {...refs}
      >研究内容</ResearchFloatingSurface>,
    )

    expect(screen.queryByText('研究内容')).toBeNull()
    view.rerender(
      <ResearchFloatingSurface
        mode="minimized"
        subject={{ code: '600519', name: '贵州茅台' }}
        onModeChange={onModeChange}
        {...refs}
      >研究内容</ResearchFloatingSurface>,
    )
    const restore = screen.getByRole('button', { name: '恢复贵州茅台研究窗' })
    expect(restore.textContent).toContain('贵州茅台')
    expect(restore.textContent).toContain('600519')
    fireEvent.click(restore)
    expect(onModeChange).toHaveBeenCalledWith('docked')
  })

  it('uses complementary semantics only for desktop docked mode', () => {
    installMatchMedia(false)
    const refs = createSurfaceRefs()
    const view = render(
      <ResearchFloatingSurface
        mode="docked"
        subject={{ code: '000001' }}
        onModeChange={() => {}}
        {...refs}
      >研究内容</ResearchFloatingSurface>,
    )

    expect(screen.getByRole('complementary', { name: '000001证券研究窗' })).not.toBeNull()
    view.rerender(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '000001' }}
        onModeChange={() => {}}
        {...refs}
      >研究内容</ResearchFloatingSurface>,
    )
    const dialog = screen.getByRole('dialog', { name: '000001证券研究窗' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
  })

  it('derives a modal from docked mode at the same 900px breakpoint and cleans the listener', async () => {
    const media = installMatchMedia(false)
    const refs = createSurfaceRefs()
    const view = render(
      <ResearchFloatingSurface
        mode="docked"
        subject={{ code: '600036', name: '招商银行' }}
        onModeChange={() => {}}
        {...refs}
      >研究内容</ResearchFloatingSurface>,
    )

    expect(screen.getByRole('complementary')).not.toBeNull()
    media.setMatches(true)
    expect(await screen.findByRole('dialog')).not.toBeNull()
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
    expect(vi.mocked(window.matchMedia)).toHaveBeenCalledWith(BREAKPOINT_QUERY)
    expect(componentSource).toContain(`const MOBILE_QUERY = '${BREAKPOINT_QUERY}'`)
    expect(styles).toContain(`@media ${BREAKPOINT_QUERY}`)

    view.unmount()
    expect(media.add).toHaveBeenCalledWith('change', expect.any(Function))
    expect(media.remove).toHaveBeenCalledWith('change', expect.any(Function))
    expect(media.remove.mock.calls[0]?.[1]).toBe(media.add.mock.calls[0]?.[1])
  })

  it('moves expanded to docked and docked to closed on Escape without intercepting minimized mode', () => {
    installMatchMedia(false)
    const refs = createSurfaceRefs()

    function Harness() {
      const [mode, setMode] = useState<ResearchSurfaceMode>('expanded')
      return <ResearchFloatingSurface
        mode={mode}
        subject={{ code: '600519', name: '贵州茅台' }}
        onModeChange={setMode}
        {...refs}
      >研究内容</ResearchFloatingSurface>
    }

    const view = render(<Harness />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('complementary')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('研究内容')).toBeNull()

    const onModeChange = vi.fn()
    view.rerender(<ResearchFloatingSurface
      mode="minimized"
      subject={{ code: '600519', name: '贵州茅台' }}
      onModeChange={onModeChange}
      {...refs}
    />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onModeChange).not.toHaveBeenCalled()
  })

  it('traps modal focus at document level and gives every icon action a Chinese accessible name', async () => {
    installMatchMedia(false)
    const refs = createSurfaceRefs()
    render(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519', name: '贵州茅台' }}
        onModeChange={() => {}}
        {...refs}
      ><button type="button">内容操作</button></ResearchFloatingSurface>,
    )

    const minimize = screen.getByRole('button', { name: '最小化研究窗' })
    const dock = screen.getByRole('button', { name: '停靠研究窗' })
    const close = screen.getByRole('button', { name: '关闭研究窗' })
    await waitFor(() => { expect(document.activeElement).toBe(minimize) })
    expect(dock).not.toBeNull()
    expect(close).not.toBeNull()

    const last = screen.getByRole('button', { name: '内容操作' })
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(minimize)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    refs.trigger.focus()
    expect(document.activeElement).toBe(minimize)
  })

  it('handles zero, one and many dynamically computed focus candidates', async () => {
    installMatchMedia(false)
    const refs = createSurfaceRefs()
    const view = render(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519', name: '贵州茅台' }}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    const surface = screen.getByRole('dialog')
    disableChromeActions()

    refs.trigger.focus()
    expect(document.activeElement).toBe(surface)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(surface)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(surface)

    view.rerender(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519', name: '贵州茅台' }}
        onModeChange={() => {}}
        {...refs}
      ><button type="button">唯一操作</button></ResearchFloatingSurface>,
    )
    disableChromeActions()
    const only = screen.getByRole('button', { name: '唯一操作' })
    refs.trigger.focus()
    expect(document.activeElement).toBe(only)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(only)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(only)

    view.rerender(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519', name: '贵州茅台' }}
        onModeChange={() => {}}
        {...refs}
      >
        <button type="button">第一项</button>
        <button type="button">第二项</button>
      </ResearchFloatingSurface>,
    )
    disableChromeActions()
    const first = screen.getByRole('button', { name: '第一项' })
    const last = screen.getByRole('button', { name: '第二项' })
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    await waitFor(() => { expect(screen.getByRole('dialog')).toBe(surface) })
  })

  it('skips hidden, disabled, negative-tabindex and inert or aria-hidden focus candidates', () => {
    installMatchMedia(false)
    const refs = createSurfaceRefs()
    render(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519', name: '贵州茅台' }}
        onModeChange={() => {}}
        {...refs}
      >
        <button type="button" tabIndex={-1}>负索引</button>
        <button type="button" disabled>已禁用</button>
        <button type="button" hidden>hidden 属性</button>
        <button type="button" style={{ display: 'none' }}>display none</button>
        <button type="button" style={{ visibility: 'hidden' }}>visibility hidden</button>
        <div data-testid="inert-parent"><button type="button">inert 后代</button></div>
        <div aria-hidden="true"><button type="button">aria hidden 后代</button></div>
        <button type="button">可用操作</button>
      </ResearchFloatingSurface>,
    )
    disableChromeActions()
    screen.getByTestId('inert-parent').inert = true

    refs.trigger.focus()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '可用操作' }))
  })

  it('moves every Tab explicitly across valid candidates and skips disabled fieldset descendants', () => {
    installMatchMedia(false)
    const refs = createSurfaceRefs()
    render(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519' }}
        onModeChange={() => {}}
        {...refs}
      >
        <button type="button">有效 A</button>
        <fieldset disabled><button type="button">fieldset 无效项</button></fieldset>
        <button type="button" hidden>hidden 无效项</button>
        <button type="button">有效 B</button>
      </ResearchFloatingSurface>,
    )
    disableChromeActions()
    const first = screen.getByRole('button', { name: '有效 A' })
    const second = screen.getByRole('button', { name: '有效 B' })

    first.focus()
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(forward)
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(second)

    const backward = new KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
    })
    document.dispatchEvent(backward)
    expect(backward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)

    second.focus()
    expect(document.activeElement).toBe(second)
  })

  it('recomputes candidates when children change and pulls scripted outside focus back in', () => {
    installMatchMedia(false)
    const refs = createSurfaceRefs()
    const view = render(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519', name: '贵州茅台' }}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    disableChromeActions()
    refs.trigger.focus()
    expect(document.activeElement).toBe(screen.getByRole('dialog'))

    view.rerender(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519', name: '贵州茅台' }}
        onModeChange={() => {}}
        {...refs}
      ><button type="button">动态操作</button></ResearchFloatingSurface>,
    )
    disableChromeActions()
    refs.trigger.focus()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '动态操作' }))
  })

  it('restores body, background and scroll before restoring the entry trigger on a surface exit', () => {
    installMatchMedia(false)
    const refs = createSurfaceRefs()
    document.body.style.overflow = 'clip'
    refs.background.inert = true
    refs.background.setAttribute('aria-hidden', 'false')
    let scrollTop = 137
    const order: string[] = []
    Object.defineProperty(refs.scrollContainer, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; order.push(`scroll:${String(value)}`) },
    })
    const focus = vi.spyOn(refs.trigger, 'focus').mockImplementation(() => { order.push('focus') })
    const frames = installAnimationFrames()
    const view = render(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519', name: '贵州茅台' }}
        onModeChange={() => {}}
        {...refs}
      >研究内容</ResearchFloatingSurface>,
    )

    expect(document.body.style.overflow).toBe('hidden')
    expect(refs.background.inert).toBe(true)
    expect(refs.background.getAttribute('aria-hidden')).toBe('true')
    scrollTop = 5
    order.length = 0
    view.rerender(
      <ResearchFloatingSurface
        mode="closed"
        subject={{ code: '600519', name: '贵州茅台' }}
        onModeChange={() => {}}
        {...refs}
      >研究内容</ResearchFloatingSurface>,
    )

    expect(scrollTop).toBe(137)
    expect(document.body.style.overflow).toBe('clip')
    expect(refs.background.inert).toBe(true)
    expect(refs.background.getAttribute('aria-hidden')).toBe('false')
    expect(focus).not.toHaveBeenCalled()
    expect(order).toEqual(['scroll:137'])
    frames.run(1)
    expect(order).toEqual(['scroll:137', 'focus'])
  })

  it.each(['first', 'second'] as const)(
    'keeps shared modal resources locked until the last lease releases: %s releases first',
    (firstRelease) => {
      installMatchMedia(false)
      const refs = createSurfaceRefs()
      document.body.style.overflow = 'clip'
      refs.background.inert = false
      refs.background.setAttribute('aria-hidden', 'false')
      refs.scrollContainer.scrollTop = 91
      let firstMode: ResearchSurfaceMode = 'expanded'
      let secondMode: ResearchSurfaceMode = 'expanded'
      const surfaces = () => <>
        <ResearchFloatingSurface
          mode={firstMode}
          subject={{ code: '600519' }}
          interactionEnabled={false}
          onModeChange={() => {}}
          {...refs}
        />
        <ResearchFloatingSurface
          mode={secondMode}
          subject={{ code: '000001' }}
          interactionEnabled={false}
          onModeChange={() => {}}
          {...refs}
        />
      </>
      const view = render(surfaces())
      expect(document.body.style.overflow).toBe('hidden')
      expect(refs.background.inert).toBe(true)
      expect(refs.background.getAttribute('aria-hidden')).toBe('true')
      refs.scrollContainer.scrollTop = 9

      if (firstRelease === 'first') firstMode = 'closed'
      else secondMode = 'closed'
      view.rerender(surfaces())
      expect(document.body.style.overflow).toBe('hidden')
      expect(refs.background.inert).toBe(true)
      expect(refs.background.getAttribute('aria-hidden')).toBe('true')
      expect(refs.scrollContainer.scrollTop).toBe(9)

      firstMode = 'closed'
      secondMode = 'closed'
      view.rerender(surfaces())
      expect(document.body.style.overflow).toBe('clip')
      expect(refs.background.inert).toBe(false)
      expect(refs.background.getAttribute('aria-hidden')).toBe('false')
      expect(refs.scrollContainer.scrollTop).toBe(91)
    },
  )

  it('never writes resources again after its modal lease is explicitly disabled and released', () => {
    installMatchMedia(false)
    const refs = createSurfaceRefs()
    const view = render(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519' }}
        interactionEnabled={false}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    view.rerender(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519' }}
        interactionEnabled={false}
        modalResourcesEnabled={false}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    document.body.style.overflow = 'clip'
    refs.background.inert = true
    refs.background.setAttribute('aria-hidden', 'false')
    refs.scrollContainer.scrollTop = 404

    view.rerender(
      <ResearchFloatingSurface
        mode="closed"
        subject={{ code: '600519' }}
        interactionEnabled={false}
        modalResourcesEnabled={false}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    expect(document.body.style.overflow).toBe('clip')
    expect(refs.background.inert).toBe(true)
    expect(refs.background.getAttribute('aria-hidden')).toBe('false')
    expect(refs.scrollContainer.scrollTop).toBe(404)
    view.unmount()
    expect(document.body.style.overflow).toBe('clip')
    expect(refs.scrollContainer.scrollTop).toBe(404)
  })

  it('isolates body, background and scroll leases by each surface owner document', () => {
    installMatchMedia(false)
    const iframe = document.createElement('iframe')
    document.body.append(iframe)
    const foreignDocument = iframe.contentDocument
    const foreignWindow = iframe.contentWindow
    expect(foreignDocument).not.toBeNull()
    expect(foreignWindow).not.toBeNull()
    if (foreignDocument === null || foreignWindow === null) return
    installMatchMediaOn(foreignWindow, false)

    const mainRefs = createSurfaceRefs()
    const foreignRefs = createSurfaceRefs(foreignDocument)
    document.body.style.overflow = 'clip'
    foreignDocument.body.style.overflow = 'scroll'
    mainRefs.background.inert = false
    foreignRefs.background.inert = true
    foreignRefs.background.setAttribute('aria-hidden', 'false')
    mainRefs.scrollContainer.scrollTop = 11
    foreignRefs.scrollContainer.scrollTop = 22
    const foreignMount = foreignDocument.createElement('div')
    foreignDocument.body.append(foreignMount)

    const mainView = render(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519' }}
        interactionEnabled={false}
        onModeChange={() => {}}
        {...mainRefs}
      />,
    )
    const foreignView = render(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '000001' }}
        interactionEnabled={false}
        onModeChange={() => {}}
        {...foreignRefs}
      />,
      { container: foreignMount },
    )

    expect(document.body.style.overflow).toBe('hidden')
    expect(foreignDocument.body.style.overflow).toBe('hidden')
    expect(mainRefs.background.inert).toBe(true)
    expect(foreignRefs.background.getAttribute('aria-hidden')).toBe('true')
    mainRefs.scrollContainer.scrollTop = 1
    foreignRefs.scrollContainer.scrollTop = 2

    mainView.rerender(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519' }}
        interactionEnabled={false}
        modalResourcesEnabled={false}
        onModeChange={() => {}}
        {...mainRefs}
      />,
    )
    expect(document.body.style.overflow).toBe('clip')
    expect(mainRefs.background.inert).toBe(false)
    expect(mainRefs.background.getAttribute('aria-hidden')).toBeNull()
    expect(mainRefs.scrollContainer.scrollTop).toBe(11)
    expect(foreignDocument.body.style.overflow).toBe('hidden')
    expect(foreignRefs.background.inert).toBe(true)
    expect(foreignRefs.background.getAttribute('aria-hidden')).toBe('true')
    expect(foreignRefs.scrollContainer.scrollTop).toBe(2)

    document.body.style.overflow = 'auto'
    mainRefs.background.inert = true
    mainRefs.background.setAttribute('aria-hidden', 'false')
    mainRefs.scrollContainer.scrollTop = 111
    mainView.unmount()
    expect(document.body.style.overflow).toBe('auto')
    expect(mainRefs.background.getAttribute('aria-hidden')).toBe('false')
    expect(mainRefs.scrollContainer.scrollTop).toBe(111)

    foreignView.rerender(
      <ResearchFloatingSurface
        mode="closed"
        subject={{ code: '000001' }}
        interactionEnabled={false}
        onModeChange={() => {}}
        {...foreignRefs}
      />,
    )
    expect(foreignDocument.body.style.overflow).toBe('scroll')
    expect(foreignRefs.background.inert).toBe(true)
    expect(foreignRefs.background.getAttribute('aria-hidden')).toBe('false')
    expect(foreignRefs.scrollContainer.scrollTop).toBe(22)
  })

  it('binds Escape, focus containment and visibility checks to the surface owner document', () => {
    installMatchMedia(false)
    const iframe = document.createElement('iframe')
    document.body.append(iframe)
    const foreignDocument = iframe.contentDocument
    const foreignWindow = iframe.contentWindow
    expect(foreignDocument).not.toBeNull()
    expect(foreignWindow).not.toBeNull()
    if (foreignDocument === null || foreignWindow === null) return
    installMatchMediaOn(foreignWindow, false)
    const refs = createSurfaceRefs(foreignDocument)
    const mount = foreignDocument.createElement('div')
    foreignDocument.body.append(mount)
    const onModeChange = vi.fn()
    const view = render(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '000001' }}
        onModeChange={onModeChange}
        {...refs}
      >
        <button type="button" style={{ display: 'none' }}>隐藏操作</button>
        <button type="button">跨文档操作</button>
      </ResearchFloatingSurface>,
      { container: mount },
    )
    for (const name of ['最小化研究窗', '停靠研究窗', '关闭研究窗']) {
      const button = view.getByRole('button', { name }) as HTMLButtonElement
      button.disabled = true
    }

    refs.trigger.focus()
    expect(foreignDocument.activeElement).toBe(view.getByRole('button', { name: '跨文档操作' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onModeChange).not.toHaveBeenCalled()
    fireEvent.keyDown(foreignDocument, { key: 'Escape' })
    expect(onModeChange).toHaveBeenCalledWith('docked')
  })

  it('derives docked modal presentation from only the portal owner window media query', () => {
    installMatchMedia(false)
    const realm = createForeignRealm(true)
    const portal = () => createPortal(
      <ResearchFloatingSurface
        mode="docked"
        subject={{ code: '000001' }}
        onModeChange={() => {}}
        {...realm.refs}
      />,
      realm.mount,
    )
    const view = render(portal())
    const portalQueries = within(realm.mount)

    expect(portalQueries.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
    expect(vi.mocked(window.matchMedia)).not.toHaveBeenCalled()
    expect(realm.media.match).toHaveBeenCalledWith(BREAKPOINT_QUERY)
    const listener = realm.media.add.mock.calls[0]?.[1]
    expect(listener).toBeTypeOf('function')

    act(() => { realm.media.setMatches(false) })
    expect(portalQueries.getByRole('complementary')).not.toBeNull()
    expect(realm.media.notificationCount()).toBe(1)

    view.unmount()
    expect(realm.media.remove).toHaveBeenCalledWith('change', listener)
    expect(realm.media.remove.mock.calls[0]?.[1]).toBe(listener)
    act(() => { realm.media.setMatches(true) })
    expect(realm.media.notificationCount()).toBe(1)
    expect(realm.mount.childElementCount).toBe(0)
  })

  it('schedules and cancels trigger focus restoration only through the trigger owner window', () => {
    installMatchMedia(false)
    const mainFrames = installAnimationFrames()
    const realm = createForeignRealm(false)
    const foreignFrames = installAnimationFramesOn(realm.ownerWindow)
    const triggerFocus = vi.spyOn(realm.refs.trigger, 'focus')
    let mode: ResearchSurfaceMode = 'expanded'
    const portal = () => createPortal(
      <ResearchFloatingSurface
        mode={mode}
        subject={{ code: '000001' }}
        onModeChange={() => {}}
        {...realm.refs}
      />,
      realm.mount,
    )
    const view = render(portal())

    mode = 'closed'
    view.rerender(portal())
    expect(foreignFrames.request).toHaveBeenCalledTimes(1)
    expect(mainFrames.request).not.toHaveBeenCalled()

    mode = 'expanded'
    view.rerender(portal())
    expect(foreignFrames.cancel).toHaveBeenCalledWith(1)
    expect(mainFrames.cancel).not.toHaveBeenCalled()
    foreignFrames.run(1)
    expect(triggerFocus).not.toHaveBeenCalled()

    mode = 'closed'
    view.rerender(portal())
    expect(foreignFrames.request).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(foreignFrames.cancel).toHaveBeenCalledWith(2)
    expect(mainFrames.cancel).not.toHaveBeenCalled()
    foreignFrames.run(2)
    expect(triggerFocus).not.toHaveBeenCalled()
  })

  it('uses the portal owner realm for explicit Tab navigation and visibility checks', () => {
    installMatchMedia(false)
    const realm = createForeignRealm(false)
    const mainComputedStyle = vi.spyOn(window, 'getComputedStyle')
    const foreignComputedStyle = vi.spyOn(realm.ownerWindow, 'getComputedStyle')
    render(createPortal(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '000001' }}
        onModeChange={() => {}}
        {...realm.refs}
      >
        <button type="button">跨 realm A</button>
        <button type="button" style={{ display: 'none' }}>跨 realm 隐藏项</button>
        <button type="button">跨 realm B</button>
      </ResearchFloatingSurface>,
      realm.mount,
    ))
    const portalQueries = within(realm.mount)
    for (const name of ['最小化研究窗', '停靠研究窗', '关闭研究窗']) {
      const button = portalQueries.getByRole('button', { name }) as HTMLButtonElement
      button.disabled = true
    }
    const first = portalQueries.getByRole('button', { name: '跨 realm A' })
    const hidden = portalQueries.getByText('跨 realm 隐藏项')
    const last = portalQueries.getByRole('button', { name: '跨 realm B' })

    first.focus()
    const forward = new realm.ownerWindow.KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true, cancelable: true,
    })
    realm.ownerDocument.dispatchEvent(forward)
    expect(forward.defaultPrevented).toBe(true)
    expect(realm.ownerDocument.activeElement).toBe(last)

    const backward = new realm.ownerWindow.KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
    })
    realm.ownerDocument.dispatchEvent(backward)
    expect(backward.defaultPrevented).toBe(true)
    expect(realm.ownerDocument.activeElement).toBe(first)
    expect(foreignComputedStyle.mock.calls.some(([element]) => element === hidden)).toBe(true)
    expect(mainComputedStyle.mock.calls.some(
      ([element]) => element.ownerDocument === realm.ownerDocument,
    )).toBe(false)
  })

  it('removes every owner-document interaction listener on unmount', () => {
    installMatchMedia(false)
    const realm = createForeignRealm(false)
    const onModeChange = vi.fn()
    const view = render(createPortal(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '000001' }}
        onModeChange={onModeChange}
        {...realm.refs}
      ><button type="button">卸载前操作</button></ResearchFloatingSurface>,
      realm.mount,
    ))
    const surface = within(realm.mount).getByRole('dialog')
    const surfaceFocus = vi.spyOn(surface, 'focus')
    view.unmount()
    onModeChange.mockClear()
    surfaceFocus.mockClear()

    const escape = new realm.ownerWindow.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    })
    realm.ownerDocument.dispatchEvent(escape)
    const tab = new realm.ownerWindow.KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true, cancelable: true,
    })
    realm.ownerDocument.dispatchEvent(tab)
    realm.refs.trigger.dispatchEvent(new realm.ownerWindow.FocusEvent('focusin', { bubbles: true }))

    expect(escape.defaultPrevented).toBe(false)
    expect(tab.defaultPrevented).toBe(false)
    expect(onModeChange).not.toHaveBeenCalled()
    expect(surfaceFocus).not.toHaveBeenCalled()
  })

  it('does not restore focus for expanded to docked or when restoration is disabled', () => {
    installMatchMedia(false)
    const refs = createSurfaceRefs()
    const frames = installAnimationFrames()
    const focus = vi.spyOn(refs.trigger, 'focus')
    const view = render(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519' }}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    view.rerender(
      <ResearchFloatingSurface
        mode="docked"
        subject={{ code: '600519' }}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    expect(frames.request).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()

    view.rerender(
      <ResearchFloatingSurface
        mode="closed"
        subject={{ code: '600519' }}
        restoreFocusOnExit={false}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    expect(frames.request).not.toHaveBeenCalled()
  })

  it.each([
    'disconnected', 'disabled', 'hidden', 'display-none', 'visibility-hidden',
    'inert', 'aria-hidden', 'negative-tabindex',
  ] as const)(
    'does not restore focus to an unavailable entry trigger: %s',
    (triggerState) => {
      installMatchMedia(false)
      const refs = createSurfaceRefs()
      const frames = installAnimationFrames()
      const focus = vi.spyOn(refs.trigger, 'focus')
      const view = render(
        <ResearchFloatingSurface
          mode="expanded"
          subject={{ code: '600519' }}
          onModeChange={() => {}}
          {...refs}
        />,
      )
      if (triggerState === 'disconnected') refs.trigger.remove()
      else refs.trigger.disabled = true
      if (triggerState !== 'disabled') refs.trigger.disabled = false
      if (triggerState === 'hidden') refs.trigger.hidden = true
      if (triggerState === 'display-none') refs.trigger.style.display = 'none'
      if (triggerState === 'visibility-hidden') refs.trigger.style.visibility = 'hidden'
      if (triggerState === 'inert') refs.trigger.inert = true
      if (triggerState === 'aria-hidden') refs.trigger.setAttribute('aria-hidden', 'true')
      if (triggerState === 'negative-tabindex') refs.trigger.tabIndex = -1
      view.rerender(
        <ResearchFloatingSurface
          mode="closed"
          subject={{ code: '600519' }}
          onModeChange={() => {}}
          {...refs}
        />,
      )
      frames.run(1)
      expect(focus).not.toHaveBeenCalled()
    },
  )

  it('cancels stale restoration on a quick reopen and never steals focus on unmount', () => {
    installMatchMedia(false)
    const refs = createSurfaceRefs()
    const frames = installAnimationFrames()
    const focus = vi.spyOn(refs.trigger, 'focus')
    const view = render(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519' }}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    view.rerender(
      <ResearchFloatingSurface
        mode="closed"
        subject={{ code: '600519' }}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    expect(frames.request).toHaveBeenCalledTimes(1)
    view.rerender(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519' }}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    expect(frames.cancel).toHaveBeenCalledWith(1)
    frames.run(1)
    expect(focus).not.toHaveBeenCalled()

    frames.request.mockClear()
    view.unmount()
    expect(frames.request).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
  })

  it('cancels pending restoration when a higher layer takes interaction ownership', () => {
    installMatchMedia(false)
    const refs = createSurfaceRefs()
    const frames = installAnimationFrames()
    const focus = vi.spyOn(refs.trigger, 'focus')
    const view = render(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519' }}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    view.rerender(
      <ResearchFloatingSurface
        mode="closed"
        subject={{ code: '600519' }}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    expect(frames.request).toHaveBeenCalledTimes(1)
    view.rerender(
      <ResearchFloatingSurface
        mode="closed"
        subject={{ code: '600519' }}
        interactionEnabled={false}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    expect(frames.cancel).toHaveBeenCalledWith(1)
    frames.run(1)
    expect(focus).not.toHaveBeenCalled()
  })

  it('disables focus containment and Escape independently and respects defaultPrevented', () => {
    installMatchMedia(false)
    const refs = createSurfaceRefs()
    const onModeChange = vi.fn()
    const view = render(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519' }}
        interactionEnabled={false}
        onModeChange={onModeChange}
        {...refs}
      />,
    )
    refs.trigger.focus()
    expect(document.activeElement).toBe(refs.trigger)
    const disabledSurface = screen.getByRole('dialog')
    expect(disabledSurface.inert).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '关闭研究窗', hidden: true }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onModeChange).not.toHaveBeenCalled()

    view.rerender(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519' }}
        escapeEnabled={false}
        onModeChange={onModeChange}
        {...refs}
      />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onModeChange).not.toHaveBeenCalled()

    view.rerender(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519' }}
        onModeChange={onModeChange}
        {...refs}
      />,
    )
    const prevented = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    prevented.preventDefault()
    document.dispatchEvent(prevented)
    expect(onModeChange).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onModeChange).toHaveBeenCalledWith('docked')
  })

  it('lets only the explicitly enabled highest layer handle Escape', () => {
    installMatchMedia(false)
    const lowerRefs = createSurfaceRefs()
    const upperRefs = createSurfaceRefs()
    const lowerModeChange = vi.fn()
    const upperModeChange = vi.fn()
    render(<>
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519' }}
        interactionEnabled={false}
        escapeEnabled={false}
        onModeChange={lowerModeChange}
        {...lowerRefs}
      />
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '000001' }}
        onModeChange={upperModeChange}
        {...upperRefs}
      />
    </>)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(lowerModeChange).not.toHaveBeenCalled()
    expect(upperModeChange).toHaveBeenCalledWith('docked')
  })

  it('announces mode transitions without an initial live-region message', async () => {
    installMatchMedia(true)
    const refs = createSurfaceRefs()
    const view = render(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519', name: '贵州茅台' }}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toBe('')

    view.rerender(
      <ResearchFloatingSurface
        mode="docked"
        subject={{ code: '600519', name: '贵州茅台' }}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    await waitFor(() => { expect(status.textContent).toContain('已停靠') })
    view.rerender(
      <ResearchFloatingSurface
        mode="minimized"
        subject={{ code: '600519', name: '贵州茅台' }}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    await waitFor(() => { expect(status.textContent).toContain('已最小化') })
    view.rerender(
      <ResearchFloatingSurface
        mode="closed"
        subject={{ code: '600519', name: '贵州茅台' }}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    await waitFor(() => {
      expect(status.textContent).toBe('贵州茅台（600519）研究窗已关闭')
    })
    view.rerender(
      <ResearchFloatingSurface
        mode="expanded"
        subject={{ code: '600519', name: '贵州茅台' }}
        onModeChange={() => {}}
        {...refs}
      />,
    )
    await waitFor(() => { expect(status.textContent).toContain('已展开') })
  })

  it('keeps the initial live status empty in StrictMode and announces a real signature change once', async () => {
    installMatchMedia(false)
    const refs = createSurfaceRefs()
    const view = render(
      <StrictMode>
        <ResearchFloatingSurface
          mode="docked"
          subject={{ code: '600519', name: '贵州茅台' }}
          onModeChange={() => {}}
          {...refs}
        />
      </StrictMode>,
    )
    expect(screen.getByRole('status').textContent).toBe('')

    view.rerender(
      <StrictMode>
        <ResearchFloatingSurface
          mode="expanded"
          subject={{ code: '600519', name: '贵州茅台' }}
          onModeChange={() => {}}
          {...refs}
        />
      </StrictMode>,
    )
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('贵州茅台（600519）研究窗已展开')
    })
  })

  it('uses semantic fixed geometry, safe areas and 44px actions without drag or resize affordances', () => {
    const dockedStyles = styles.match(/\.researchFloatingSurface\s*\{[^}]*}/s)?.[0] ?? ''
    expect(dockedStyles).toContain('position: fixed')
    expect(dockedStyles).toContain('top: 68px')
    expect(dockedStyles).toContain('right: 24px')
    expect(dockedStyles).toContain('bottom: 24px')
    expect(dockedStyles).toContain('width: clamp(420px, 42vw, 620px)')
    const expandedStyles = styles.match(/\.researchFloatingSurface\[data-mode='expanded'\]\s*\{[^}]*}/s)?.[0] ?? ''
    expect(expandedStyles).toContain('top: 16px')
    expect(expandedStyles).toContain('right: 16px')
    expect(expandedStyles).toContain('bottom: 16px')
    expect(expandedStyles).toContain('left: 16px')
    const actionStyles = styles.match(/\.researchSurfaceAction\s*\{[^}]*}/s)?.[0] ?? ''
    expect(actionStyles).toContain('width: var(--investment-touch-target)')
    expect(actionStyles).toContain('height: var(--investment-touch-target)')
    expect(styles).toMatch(/\.researchFloatingBackdrop\s*\{[^}]*z-index:\s*880;/s)
    expect(styles).toMatch(/\.researchFloatingSurface\s*\{[^}]*z-index:\s*890;/s)
    expect(styles).toMatch(/\.researchFloatingRestore\s*\{[^}]*z-index:\s*890;/s)
    expect(styles).toMatch(/\.researchStatus\s*\{[^}]*clip-path:\s*inset\(50%\);/s)
    expect(styles).toContain('env(safe-area-inset-right)')
    expect(styles).toContain('env(safe-area-inset-bottom)')
    const floatingStyles = styles.slice(styles.indexOf('.researchFloatingBackdrop'))
    expect(floatingStyles).not.toMatch(/cursor:\s*(?:move|grab|grabbing)/)
    expect(floatingStyles).not.toMatch(/\bresize\s*:/)
    expect(floatingStyles).not.toMatch(/drag(?:Handle|ger)/i)
  })
})
