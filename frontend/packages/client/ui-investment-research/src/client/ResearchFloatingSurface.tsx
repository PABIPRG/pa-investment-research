import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import css from './InvestmentShell.module.css'
import { SurfaceResizeIcon } from './SurfaceResizeIcon.tsx'
import type { ResearchSubject, ResearchSurfaceMode } from './research-types.ts'

const MOBILE_QUERY = '(max-width: 1023px)'
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',')

interface BodyResourceLease {
  readonly baselineOverflow: string
  readonly holders: Set<symbol>
}

interface BackgroundResourceLease {
  readonly baselineInert: boolean
  readonly baselineAriaHidden: string | null
  readonly holders: Set<symbol>
}

interface ScrollResourceLease {
  readonly baselineScrollTop: number
  readonly holders: Set<symbol>
}

const bodyResourceLeases = new WeakMap<HTMLElement, BodyResourceLease>()
const backgroundResourceLeases = new WeakMap<HTMLElement, BackgroundResourceLease>()
const scrollResourceLeases = new WeakMap<HTMLElement, ScrollResourceLease>()

export interface ResearchFloatingSurfaceProps {
  readonly mode: ResearchSurfaceMode
  readonly subject: ResearchSubject
  readonly dockedWidth?: number
  readonly triggerRef: RefObject<HTMLElement>
  readonly backgroundRef: RefObject<HTMLElement>
  readonly scrollContainerRef: RefObject<HTMLElement>
  readonly widthAnchorRef: RefObject<HTMLElement>
  readonly onModeChange: (nextMode: ResearchSurfaceMode) => void
  readonly interactionEnabled?: boolean
  readonly escapeEnabled?: boolean
  readonly modalResourcesEnabled?: boolean
  readonly restoreFocusOnExit?: boolean
  readonly children?: ReactNode
}

function isDisabled(element: HTMLElement): boolean {
  return element.matches(':disabled')
    || ('disabled' in element && (element as HTMLButtonElement).disabled)
    || element.getAttribute('aria-disabled') === 'true'
}

function isHiddenOrInert(element: HTMLElement, boundary?: HTMLElement): boolean {
  let current: HTMLElement | null = element
  while (current !== null) {
    const computedPresentation = current.ownerDocument.defaultView?.getComputedStyle(current)
    if (
      current.hidden
      || current.inert
      || current.getAttribute('aria-hidden') === 'true'
      || computedPresentation?.display === 'none'
      || computedPresentation?.visibility === 'hidden'
    ) return true
    if (current === boundary) break
    current = current.parentElement
  }
  return false
}

function isFocusable(element: HTMLElement, boundary?: HTMLElement): boolean {
  return element.isConnected
    && element.tabIndex >= 0
    && !isDisabled(element)
    && !isHiddenOrInert(element, boundary)
}

function focusableElements(surface: HTMLElement): HTMLElement[] {
  return Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(element => isFocusable(element, surface))
}

function isSurfaceMode(mode: ResearchSurfaceMode): boolean {
  return mode === 'docked' || mode === 'expanded'
}

function isHtmlElementFromDocument(
  value: EventTarget | null,
  ownerDocument: Document,
): value is HTMLElement {
  if (value === null || !('nodeType' in value)) return false
  const node = value as Node
  return node.nodeType === 1
    && node.ownerDocument === ownerDocument
    && (node as Element).namespaceURI === 'http://www.w3.org/1999/xhtml'
}

function acquireModalResources(
  body: HTMLElement,
  background: HTMLElement | null,
  scrollContainer: HTMLElement | null,
): () => void {
  const holder = Symbol('research-modal-resource-holder')

  const existingBodyLease = bodyResourceLeases.get(body)
  if (existingBodyLease === undefined) {
    bodyResourceLeases.set(body, {
      baselineOverflow: body.style.overflow,
      holders: new Set([holder]),
    })
    body.style.overflow = 'hidden'
  }
  else existingBodyLease.holders.add(holder)

  if (background !== null) {
    const existingLease = backgroundResourceLeases.get(background)
    if (existingLease === undefined) {
      backgroundResourceLeases.set(background, {
        baselineInert: background.inert,
        baselineAriaHidden: background.getAttribute('aria-hidden'),
        holders: new Set([holder]),
      })
      background.inert = true
      background.setAttribute('aria-hidden', 'true')
    }
    else existingLease.holders.add(holder)
  }

  if (scrollContainer !== null) {
    const existingLease = scrollResourceLeases.get(scrollContainer)
    if (existingLease === undefined) {
      scrollResourceLeases.set(scrollContainer, {
        baselineScrollTop: scrollContainer.scrollTop,
        holders: new Set([holder]),
      })
    }
    else existingLease.holders.add(holder)
  }

  let released = false
  return () => {
    if (released) return
    released = true

    if (scrollContainer !== null) {
      const lease = scrollResourceLeases.get(scrollContainer)
      if (lease?.holders.delete(holder) && lease.holders.size === 0) {
        scrollContainer.scrollTop = lease.baselineScrollTop
        scrollResourceLeases.delete(scrollContainer)
      }
    }

    if (background !== null) {
      const lease = backgroundResourceLeases.get(background)
      if (lease?.holders.delete(holder) && lease.holders.size === 0) {
        background.inert = lease.baselineInert
        if (lease.baselineAriaHidden === null) background.removeAttribute('aria-hidden')
        else background.setAttribute('aria-hidden', lease.baselineAriaHidden)
        backgroundResourceLeases.delete(background)
      }
    }

    const lease = bodyResourceLeases.get(body)
    if (lease?.holders.delete(holder) && lease.holders.size === 0) {
      body.style.overflow = lease.baselineOverflow
      bodyResourceLeases.delete(body)
    }
  }
}

export function ResearchFloatingSurface({
  mode,
  subject,
  dockedWidth,
  triggerRef,
  backgroundRef,
  scrollContainerRef,
  widthAnchorRef,
  onModeChange,
  interactionEnabled = true,
  escapeEnabled = true,
  modalResourcesEnabled = true,
  restoreFocusOnExit = true,
  children,
}: ResearchFloatingSurfaceProps) {
  const titleId = useId()
  const surfaceRef = useRef<HTMLElement>(null)
  const restoreFocusFrameRef = useRef<{ id: number; ownerWindow: Window }>()
  const focusRestoreOwnerRef = useRef(0)
  const entryTriggerRef = useRef<HTMLElement | null>(null)
  const previousModeRef = useRef<ResearchSurfaceMode>('closed')
  const [announcement, setAnnouncement] = useState('')
  const [mobile, setMobile] = useState(() => {
    const ownerWindow = triggerRef.current?.ownerDocument.defaultView
      ?? backgroundRef.current?.ownerDocument.defaultView
      ?? scrollContainerRef.current?.ownerDocument.defaultView
      ?? widthAnchorRef.current?.ownerDocument.defaultView
    return ownerWindow?.matchMedia(MOBILE_QUERY).matches ?? false
  })
  const modal = mode === 'expanded' || (mode === 'docked' && mobile)
  const subjectName = subject.name?.trim() || subject.code
  const subjectLabel = subject.code === subjectName
    ? subjectName
    : `${subjectName}（${subject.code}）`
  const announcementSignature = `${mode}\u0000${subjectLabel}`
  const previousAnnouncementSignatureRef = useRef(announcementSignature)

  useEffect(() => {
    const ownerDocument = surfaceRef.current?.ownerDocument
      ?? backgroundRef.current?.ownerDocument
      ?? scrollContainerRef.current?.ownerDocument
      ?? widthAnchorRef.current?.ownerDocument
      ?? triggerRef.current?.ownerDocument
    const ownerWindow = ownerDocument?.defaultView
    if (ownerWindow === null || ownerWindow === undefined) return
    const media = ownerWindow.matchMedia(MOBILE_QUERY)
    const update = (event: MediaQueryListEvent): void => { setMobile(event.matches) }
    setMobile(media.matches)
    media.addEventListener('change', update)
    return () => { media.removeEventListener('change', update) }
  }, [backgroundRef, scrollContainerRef, triggerRef, widthAnchorRef])

  useLayoutEffect(() => {
    if (mode !== 'docked' || mobile) {
      surfaceRef.current?.style.removeProperty('--investment-research-surface-width')
      return
    }
    if (dockedWidth !== undefined) {
      surfaceRef.current?.style.setProperty(
        '--investment-research-surface-width',
        `min(${Math.round(dockedWidth)}px, 42vw)`,
      )
      return
    }
    const widthAnchor = widthAnchorRef.current
    if (widthAnchor === null) return
    const ownerWindow = widthAnchor.ownerDocument.defaultView
    if (ownerWindow === null) return
    const updateWidth = (): void => {
      const nextWidth = Math.round(widthAnchor.getBoundingClientRect().width)
      const surface = surfaceRef.current
      if (surface === null) return
      if (nextWidth > 0) surface.style.setProperty('--investment-research-surface-width', `${nextWidth}px`)
      else surface.style.removeProperty('--investment-research-surface-width')
    }
    updateWidth()
    const resizeObserver = typeof ownerWindow.ResizeObserver === 'function'
      ? new ownerWindow.ResizeObserver(updateWidth)
      : undefined
    resizeObserver?.observe(widthAnchor)
    ownerWindow.addEventListener('resize', updateWidth)
    return () => {
      resizeObserver?.disconnect()
      ownerWindow.removeEventListener('resize', updateWidth)
    }
  }, [dockedWidth, mobile, mode, widthAnchorRef])

  useEffect(() => {
    const surface = surfaceRef.current
    if (surface === null) return
    surface.inert = !interactionEnabled
    return () => { surface.inert = false }
  }, [interactionEnabled, mode])

  useEffect(() => {
    if (!isSurfaceMode(mode) || !interactionEnabled || !escapeEnabled) return
    const ownerDocument = surfaceRef.current?.ownerDocument
    if (ownerDocument === undefined) return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onModeChange(mode === 'expanded' ? 'docked' : 'closed')
    }
    ownerDocument.addEventListener('keydown', onKeyDown)
    return () => { ownerDocument.removeEventListener('keydown', onKeyDown) }
  }, [escapeEnabled, interactionEnabled, mode, onModeChange])

  useEffect(() => {
    if (!modal || !modalResourcesEnabled) return
    const surface = surfaceRef.current
    const background = backgroundRef.current
    const scrollContainer = scrollContainerRef.current
    const ownerDocument = surface?.ownerDocument
      ?? background?.ownerDocument
      ?? scrollContainer?.ownerDocument
    const body = ownerDocument?.body
    if (body === undefined) return
    return acquireModalResources(body, background, scrollContainer)
  }, [backgroundRef, modal, modalResourcesEnabled, scrollContainerRef])

  useEffect(() => {
    if (!modal || !interactionEnabled) return
    const surface = surfaceRef.current
    if (surface === null) return
    const ownerDocument = surface.ownerDocument

    const focusBoundary = (last = false): void => {
      const focusable = focusableElements(surface)
      const target = last ? focusable[focusable.length - 1] : focusable[0]
      const nextFocus = target ?? surface
      if (ownerDocument.activeElement !== nextFocus) nextFocus.focus()
    }

    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Tab' || event.defaultPrevented) return
      const focusable = focusableElements(surface)
      event.preventDefault()
      if (focusable.length === 0) {
        surface.focus()
        return
      }
      const activeIndex = isHtmlElementFromDocument(ownerDocument.activeElement, ownerDocument)
        ? focusable.indexOf(ownerDocument.activeElement)
        : -1
      const nextIndex = activeIndex === -1
        ? (event.shiftKey ? focusable.length - 1 : 0)
        : (activeIndex + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length
      focusable[nextIndex]?.focus()
    }

    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target
      const focusable = focusableElements(surface)
      if (
        isHtmlElementFromDocument(target, ownerDocument)
        && surface.contains(target)
        && (focusable.includes(target) || (target === surface && focusable.length === 0))
      ) return
      focusBoundary()
    }

    ownerDocument.addEventListener('keydown', onKeyDown)
    ownerDocument.addEventListener('focusin', onFocusIn)
    focusBoundary()
    return () => {
      ownerDocument.removeEventListener('keydown', onKeyDown)
      ownerDocument.removeEventListener('focusin', onFocusIn)
    }
  }, [interactionEnabled, modal])

  useEffect(() => {
    focusRestoreOwnerRef.current += 1
    const owner = focusRestoreOwnerRef.current
    const pendingFrame = restoreFocusFrameRef.current
    if (pendingFrame !== undefined) {
      pendingFrame.ownerWindow.cancelAnimationFrame(pendingFrame.id)
      restoreFocusFrameRef.current = undefined
    }

    const previousMode = previousModeRef.current
    previousModeRef.current = mode
    const wasSurface = isSurfaceMode(previousMode)
    const isSurface = isSurfaceMode(mode)
    if (!wasSurface && isSurface) entryTriggerRef.current = triggerRef.current
    else if (wasSurface && !isSurface) {
      const entryTrigger = entryTriggerRef.current
      entryTriggerRef.current = null
      if (restoreFocusOnExit && interactionEnabled && entryTrigger !== null) {
        const ownerWindow = entryTrigger.ownerDocument.defaultView
        if (ownerWindow === null) return
        const frame = { id: 0, ownerWindow }
        frame.id = ownerWindow.requestAnimationFrame(() => {
          if (restoreFocusFrameRef.current === frame) restoreFocusFrameRef.current = undefined
          if (
            focusRestoreOwnerRef.current === owner
            && !isSurfaceMode(previousModeRef.current)
            && isFocusable(entryTrigger)
          ) entryTrigger.focus({ preventScroll: true })
        })
        restoreFocusFrameRef.current = frame
      }
    }

    return () => {
      focusRestoreOwnerRef.current += 1
      const frame = restoreFocusFrameRef.current
      if (frame !== undefined) {
        frame.ownerWindow.cancelAnimationFrame(frame.id)
        restoreFocusFrameRef.current = undefined
      }
    }
  }, [interactionEnabled, mode, restoreFocusOnExit, triggerRef])

  useLayoutEffect(() => {
    if (isSurfaceMode(mode)) entryTriggerRef.current = triggerRef.current
  }, [mode, subject.code, triggerRef])

  useEffect(() => {
    if (previousAnnouncementSignatureRef.current === announcementSignature) return
    previousAnnouncementSignatureRef.current = announcementSignature
    const modeText: Record<ResearchSurfaceMode, string> = {
      closed: '已关闭',
      minimized: '已最小化',
      docked: '已悬浮',
      expanded: '已展开',
    }
    setAnnouncement(`${subjectLabel}研究窗${modeText[mode]}`)
  }, [announcementSignature, mode, subjectLabel])

  const status = (
    <span
      className={css.researchStatus}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >{announcement}</span>
  )

  if (mode === 'closed') return status

  if (mode === 'minimized') {
    return (
      <>
        {status}
        <button
          type="button"
          className={css.researchFloatingRestore}
          aria-label={`恢复${subjectName}研究窗`}
          disabled={!interactionEnabled}
          onClick={() => { onModeChange('docked') }}
        >
          <span>{subjectName}</span>
          {subject.code !== subjectName && <small>{subject.code}</small>}
        </button>
      </>
    )
  }

  const ownerDocument = widthAnchorRef.current?.ownerDocument
    ?? backgroundRef.current?.ownerDocument
    ?? scrollContainerRef.current?.ownerDocument
    ?? triggerRef.current?.ownerDocument
  const portalTarget = ownerDocument?.body

  const surface = (
    <>
      {modal && <div className={css.researchFloatingBackdrop} aria-hidden="true" />}
      <section
        ref={surfaceRef}
        className={css.researchFloatingSurface}
        data-mode={mode}
        data-modal={modal ? 'true' : 'false'}
        data-placement={modal ? 'modal' : 'viewport'}
        data-interaction-enabled={interactionEnabled ? 'true' : 'false'}
        role={modal ? 'dialog' : 'complementary'}
        aria-modal={modal ? 'true' : undefined}
        aria-disabled={interactionEnabled ? undefined : 'true'}
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className={css.researchSurfaceHeader}>
          <div>
            <strong id={titleId}>{subjectName}证券研究窗</strong>
            {subject.code !== subjectName && <small>{subject.code}</small>}
          </div>
          <div className={css.researchSurfaceActions}>
            <button
              type="button"
              className={css.researchSurfaceAction}
              aria-label="最小化研究窗"
              disabled={!interactionEnabled}
              onClick={() => { onModeChange('minimized') }}
            ><span aria-hidden="true">―</span></button>
            <button
              type="button"
              className={css.researchSurfaceAction}
              aria-label={mode === 'expanded' ? '收起研究窗' : '近全屏展开研究窗'}
              title={mode === 'expanded' ? '收起' : '近全屏展开'}
              disabled={!interactionEnabled}
              onClick={() => { onModeChange(mode === 'expanded' ? 'docked' : 'expanded') }}
            ><SurfaceResizeIcon expanded={mode === 'expanded'} /></button>
            <button
              type="button"
              className={css.researchSurfaceAction}
              aria-label="关闭研究窗"
              disabled={!interactionEnabled}
              onClick={() => { onModeChange('closed') }}
            ><span aria-hidden="true">×</span></button>
          </div>
        </header>
        <div className={css.researchSurfaceBody}>{children}</div>
      </section>
    </>
  )

  return (
    <>
      {status}
      {portalTarget === undefined ? surface : createPortal(surface, portalTarget)}
    </>
  )
}
