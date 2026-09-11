import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionLogDownloadState } from '@deepseek-ai/dsh-session-log-export/client'
import type {
  BackupCategory,
  BackupDescription,
  BackupConflictRule,
  BackupListItem,
  BackupManifest,
  BackupPreview,
  BackupReason,
} from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { uploadBackup } from './backup-upload.ts'
import { downloadBackup } from './backup-download.ts'
import type { InvestmentReadinessKey } from './locales.ts'
import css from './DataBackupSection.module.css'

const ALL_CATEGORIES: BackupCategory[] = ['strategies', 'holdings', 'watchlist', 'research', 'preferences']

export interface DataBackupSectionProps {
  t: (key: InvestmentReadinessKey) => string
  currentSession: SessionId | undefined
  useSessionLogDownload<T>(selector: (value: SessionLogDownloadState) => T): T
  downloadSession(sessionId: SessionId): Promise<void>
  backupDescribe(this: void): Promise<BackupDescription>
  backupSetDirectory(directory: string): Promise<{ directory: string }>
  backupCreate(input: { categories: BackupCategory[]; reason: BackupReason }): Promise<{
    filename: string
    manifest: BackupManifest
  }>
  backupList(this: void): Promise<BackupListItem[]>
  backupDelete(filename: string): Promise<void>
  backupDownloadBegin?(
    this: void,
    filename: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; filename: string; size: number; chunkSize: number }>
  backupDownloadChunk?(
    this: void,
    input: { id: string; offset: number },
    signal?: AbortSignal,
  ): Promise<{ base64: string; nextOffset: number; done: boolean }>
  backupDownloadCancel?(this: void, id: string): Promise<void>
  backupPreviewStored(filename: string, signal?: AbortSignal): Promise<BackupPreview>
  backupUploadBegin(input: { filename: string; size: number }, signal?: AbortSignal): Promise<{ id: string; chunkSize: number }>
  backupUploadChunk(input: { id: string; offset: number; base64: string }, signal?: AbortSignal): Promise<{ received: number }>
  backupUploadInspect(id: string, signal?: AbortSignal): Promise<BackupPreview>
  backupUploadCancel(id: string): Promise<void>
  backupPreviewCancel?(id: string): Promise<void>
  backupImport(input: {
    previewId: string
    rules: Partial<Record<BackupCategory, BackupConflictRule>>
    backupBefore: boolean
  }): Promise<{ status: 'applied'; categories: BackupCategory[] }>
  backupReset(input: { categories: BackupCategory[]; backupBefore: boolean }): Promise<{
    status: 'reset'
    categories: BackupCategory[]
  }>
  pickBackupDirectory(): Promise<string | null>
  openBackupDirectory(path: string): Promise<void>
  reloadPage(): void
}

type DialogState = 'create' | 'import' | 'reset' | 'delete' | null
type BackupStorageState = 'unknown' | 'managed' | 'local'
type ActivePreview = { value: BackupPreview; ownership: 'client' | 'importing' }

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value
}

function categoryLabel(category: BackupCategory, t: DataBackupSectionProps['t']): string {
  const keys: Record<BackupCategory, InvestmentReadinessKey> = {
    strategies: 'backupCategoryStrategies',
    holdings: 'backupCategoryHoldings',
    watchlist: 'backupCategoryWatchlist',
    research: 'backupCategoryResearch',
    preferences: 'backupCategoryPreferences',
  }
  return t(keys[category])
}

function reasonLabel(reason: BackupReason, t: DataBackupSectionProps['t']): string {
  const keys: Record<BackupReason, InvestmentReadinessKey> = {
    manual: 'backupReasonManual',
    'pre-import': 'backupReasonPreImport',
    'pre-reset': 'backupReasonPreReset',
  }
  return t(keys[reason])
}

function ruleOptions(category: BackupCategory): BackupConflictRule[] {
  if (category === 'holdings' || category === 'preferences') return ['keep_local', 'use_import']
  if (category === 'watchlist') return ['merge', 'keep_local', 'use_import']
  return ['keep_both', 'keep_local', 'use_import']
}

function ruleLabel(rule: BackupConflictRule, t: DataBackupSectionProps['t']): string {
  const keys: Record<BackupConflictRule, InvestmentReadinessKey> = {
    keep_both: 'backupRuleKeepBoth',
    merge: 'backupRuleMerge',
    keep_local: 'backupRuleKeepLocal',
    use_import: 'backupRuleUseImport',
  }
  return t(keys[rule])
}

function CategoryPicker(props: {
  selected: BackupCategory[]
  onChange: (value: BackupCategory[]) => void
  t: DataBackupSectionProps['t']
}): ReactNode {
  return <fieldset className={css.categoryPicker}>
    <legend>{props.t('backupChooseContents')}</legend>
    {ALL_CATEGORIES.map(category => <label key={category}>
      <input
        type="checkbox"
        checked={props.selected.includes(category)}
        onChange={(event) => {
          props.onChange(event.target.checked
            ? [...props.selected, category]
            : props.selected.filter(value => value !== category))
        }}
      />
      <span>{categoryLabel(category, props.t)}</span>
    </label>)}
  </fieldset>
}

function Modal(props: {
  t: DataBackupSectionProps['t']
  title: string
  children: ReactNode
  busy: boolean
  confirmLabel: string
  destructive?: boolean
  confirmDisabled?: boolean
  onCancel: () => void
  onConfirm: () => void
}): ReactNode {
  const cancelButton = useRef<HTMLButtonElement>(null)
  const modal = useRef<HTMLElement>(null)
  const cancelRef = useRef(props.onCancel)
  const busyRef = useRef(props.busy)
  cancelRef.current = props.onCancel
  busyRef.current = props.busy

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    cancelButton.current?.focus({ preventScroll: true })
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!busyRef.current) cancelRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(modal.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [])]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      }
      else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      previousFocus?.focus()
    }
  }, [])

  return <div className={css.backdrop} role="presentation">
    <section ref={modal} className={css.modal} role="dialog" aria-modal="true" aria-labelledby="backup-dialog-title">
      <h3 id="backup-dialog-title">{props.title}</h3>
      <div className={css.modalBody}>{props.children}</div>
      <div className={css.modalActions}>
        <button ref={cancelButton} type="button" className={css.secondaryButton} disabled={props.busy} onClick={props.onCancel}>{props.t('backupCancel')}</button>
        <button
          type="button"
          className={props.destructive ? css.dangerButton : css.primaryButton}
          disabled={props.busy || props.confirmDisabled}
          aria-busy={props.busy}
          onClick={props.onConfirm}
        >{props.busy ? props.t('backupProcessing') : props.confirmLabel}</button>
      </div>
    </section>
  </div>
}

export function DataBackupSection(props: DataBackupSectionProps): ReactNode {
  const currentSession = props.currentSession
  const downloadStatus = props.useSessionLogDownload(value => currentSession === undefined
    ? undefined
    : value.bySession[String(currentSession)]?.status)
  const fileInput = useRef<HTMLInputElement>(null)
  const transferAbort = useRef<AbortController>()
  const previewAbort = useRef<AbortController>()
  const activePreview = useRef<ActivePreview>()
  const cancelPreview = useRef(props.backupPreviewCancel)
  const transferTrigger = useRef<HTMLButtonElement>()
  const restoreTransferFocus = useRef(false)
  const mounted = useRef(true)
  cancelPreview.current = props.backupPreviewCancel
  const [directory, setDirectory] = useState('')
  const [storageState, setStorageState] = useState<BackupStorageState>('unknown')
  const [items, setItems] = useState<BackupListItem[]>([])
  const [dialog, setDialog] = useState<DialogState>(null)
  const [selected, setSelected] = useState<BackupCategory[]>(ALL_CATEGORIES)
  const [preview, setPreview] = useState<BackupPreview>()
  const [rules, setRules] = useState<Partial<Record<BackupCategory, BackupConflictRule>>>({})
  const [backupBefore, setBackupBefore] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number>()
  const [transferKind, setTransferKind] = useState<'upload' | 'download'>('upload')
  const [feedback, setFeedback] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)

  const refresh = async (): Promise<void> => {
    setLoading(true)
    setLoadFailed(false)
    setStorageState('unknown')
    try {
      const [description, backups] = await Promise.all([props.backupDescribe(), props.backupList()])
      const managed = 'location' in description && description.location.kind === 'managed'
      setStorageState(managed ? 'managed' : 'local')
      setDirectory('directory' in description ? description.directory : '')
      setItems(backups)
    }
    catch (error) {
      setLoadFailed(true)
      throw error
    }
    finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let alive = true
    void Promise.all([props.backupDescribe(), props.backupList()]).then(
      ([description, backups]) => {
        if (!alive) return
        const managed = 'location' in description && description.location.kind === 'managed'
        setStorageState(managed ? 'managed' : 'local')
        setDirectory('directory' in description ? description.directory : '')
        setItems(backups)
        setLoading(false)
      },
      () => {
        if (!alive) return
        setStorageState('unknown')
        setLoading(false)
        setLoadFailed(true)
        setFeedback(props.t('backupLoadFailed'))
      },
    )
    return () => { alive = false }
  }, [props.backupDescribe, props.backupList, props.t])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      transferAbort.current?.abort()
      transferAbort.current = undefined
      previewAbort.current?.abort()
      previewAbort.current = undefined
      const current = activePreview.current
      if (current?.ownership === 'client') {
        activePreview.current = undefined
        void cancelPreview.current?.(current.value.id)
      }
    }
  }, [])

  useEffect(() => {
    if (progress !== undefined || busy || !restoreTransferFocus.current) return
    restoreTransferFocus.current = false
    transferTrigger.current?.focus({ preventScroll: true })
  }, [busy, progress])

  const run = (operation: () => Promise<void>): void => {
    if (busy) return
    setBusy(true)
    setFeedback('')
    void operation().catch((error: unknown) => {
      setFeedback(error instanceof Error ? error.message : props.t('backupOperationFailed'))
    }).finally(() => { setBusy(false) })
  }

  const openPreview = (value: BackupPreview): void => {
    const current = activePreview.current
    if (current?.ownership === 'client' && current.value.id !== value.id) {
      void cancelPreview.current?.(current.value.id)
    }
    const defaults: Partial<Record<BackupCategory, BackupConflictRule>> = {}
    for (const domain of Object.values(value.domains)) {
      for (const [category, summary] of Object.entries(domain.categories)) {
        defaults[category as BackupCategory] = summary.defaultRule
      }
    }
    activePreview.current = { value, ownership: 'client' }
    setPreview(value)
    setRules(defaults)
    setBackupBefore(true)
    setDialog('import')
  }

  const releasePreview = (value: BackupPreview): void => {
    if (activePreview.current?.value.id === value.id) activePreview.current = undefined
    void cancelPreview.current?.(value.id)
  }

  const previewStored = (filename: string): void => {
    previewAbort.current?.abort()
    const controller = new AbortController()
    previewAbort.current = controller
    run(async () => {
      try {
        const value = await props.backupPreviewStored(filename, controller.signal)
        if (previewAbort.current !== controller || controller.signal.aborted) {
          void cancelPreview.current?.(value.id)
          return
        }
        openPreview(value)
      }
      finally {
        if (previewAbort.current === controller) previewAbort.current = undefined
      }
    })
  }

  const chooseDirectory = (): void => {
    run(async () => {
      const value = await props.pickBackupDirectory()
      if (value === null) return
      const result = await props.backupSetDirectory(value)
      setDirectory(result.directory)
      await refresh()
      setFeedback(props.t('backupDirectoryChanged'))
    })
  }

  const create = (): void => {
    run(async () => {
      const result = await props.backupCreate({ categories: selected, reason: 'manual' })
      await refresh()
      setDialog(null)
      setFeedback(`${props.t('backupCreated')} ${result.filename}`)
    })
  }

  const selectFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (busy) return
    transferAbort.current?.abort()
    const controller = new AbortController()
    transferAbort.current = controller
    setTransferKind('upload')
    setBusy(true)
    setFeedback('')
    void (async () => {
      setProgress(0)
      try {
        const value = await uploadBackup(file, props, setProgress, controller.signal)
        if (transferAbort.current !== controller || controller.signal.aborted) {
          void cancelPreview.current?.(value.id)
          return
        }
        openPreview(value)
      }
      catch (error) {
        setFeedback(controller.signal.aborted
          ? props.t('backupTransferCanceled')
          : error instanceof Error ? error.message : props.t('backupOperationFailed'))
      }
      finally {
        setProgress(undefined)
        setBusy(false)
        if (transferAbort.current === controller) transferAbort.current = undefined
      }
    })()
  }

  const download = (filename: string, trigger: HTMLButtonElement): void => {
    const beginDownload = props.backupDownloadBegin
    const readDownloadChunk = props.backupDownloadChunk
    const cancelDownload = props.backupDownloadCancel
    if (beginDownload === undefined || readDownloadChunk === undefined || cancelDownload === undefined) return
    const api = {
      backupDownloadBegin: (filename: string, signal?: AbortSignal) => beginDownload(filename, signal),
      backupDownloadChunk: (input: { id: string; offset: number }, signal?: AbortSignal) => (
        readDownloadChunk(input, signal)
      ),
      backupDownloadCancel: (id: string) => cancelDownload(id),
    }
    transferAbort.current?.abort()
    transferTrigger.current = trigger
    const controller = new AbortController()
    transferAbort.current = controller
    setTransferKind('download')
    run(async () => {
      setProgress(0)
      try {
        const result = await downloadBackup(filename, api, setProgress, controller.signal)
        const url = URL.createObjectURL(result.blob)
        try {
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = result.filename
          anchor.click()
        }
        finally { URL.revokeObjectURL(url) }
      }
      catch (error) {
        if (!controller.signal.aborted) throw error
      }
      finally {
        setProgress(undefined)
        if (transferAbort.current === controller) transferAbort.current = undefined
      }
      setFeedback(controller.signal.aborted ? props.t('backupTransferCanceled') : props.t('backupDownloaded'))
    })
  }

  const importData = (): void => {
    if (!preview || busy) return
    const ownership = activePreview.current
    if (ownership?.value.id !== preview.id || ownership.ownership !== 'client') return
    ownership.ownership = 'importing'
    run(async () => {
      try {
        await props.backupImport({ previewId: preview.id, rules, backupBefore })
        if (activePreview.current?.value.id === preview.id) activePreview.current = undefined
        if (!mounted.current) return
        setDialog(null)
        setPreview(undefined)
        setFeedback(props.t('backupImportSucceeded'))
        props.reloadPage()
      }
      catch (error) {
        if (error instanceof Error && error.message.includes('预览已失效')) {
          if (activePreview.current?.value.id === preview.id) activePreview.current = undefined
          if (!mounted.current) return
          setDialog(null)
          setPreview(undefined)
          setFeedback(props.t('backupPreviewExpired'))
          return
        }
        if (!mounted.current) {
          if (activePreview.current?.value.id === preview.id) activePreview.current = undefined
          void cancelPreview.current?.(preview.id)
          return
        }
        if (activePreview.current?.value.id === preview.id) activePreview.current.ownership = 'client'
        throw error
      }
    })
  }

  const resetData = (): void => {
    run(async () => {
      await props.backupReset({ categories: selected, backupBefore })
      await refresh()
      window.dispatchEvent(new CustomEvent('dsh:investment-data-changed', { detail: { reason: 'reset' } }))
      setDialog(null)
      setFeedback(props.t('backupResetSucceeded'))
    })
  }

  const deleteBackup = (): void => {
    run(async () => {
      await props.backupDelete(deleteTarget)
      await refresh()
      setDialog(null)
      setFeedback(props.t('backupDeleted'))
    })
  }

  const downloadBusy = downloadStatus === 'downloading'

  return <section className={css.section} aria-labelledby="investment-research-data-backup-title">
    <header className={css.heading}>
      <div>
        <span className={css.eyebrow}>{props.t('backupEyebrow')}</span>
        <h2 id="investment-research-data-backup-title">{props.t('dataBackupTitle')}</h2>
        <p>{props.t('backupIntro')}</p>
      </div>
      <div className={css.heroActions}>
        <button type="button" className={css.primaryButton} disabled={busy} onClick={() => {
          setSelected(ALL_CATEGORIES)
          setDialog('create')
        }}>{props.t('backupCreate')}</button>
        <button type="button" className={css.secondaryButton} disabled={busy} onClick={(event) => {
          transferTrigger.current = event.currentTarget
          fileInput.current?.click()
        }}>{props.t('backupImport')}</button>
        <input ref={fileInput} className={css.fileInput} type="file" accept=".pabackup,application/zip" onChange={selectFile} />
      </div>
    </header>

    {progress !== undefined && <div className={css.progress} role="status" aria-live="polite">
      <strong id="backup-transfer-status">{props.t(transferKind === 'upload' ? 'backupUploading' : 'backupDownloading')}</strong>
      <progress
        value={progress}
        max={1}
        aria-describedby="backup-transfer-status"
        aria-label={`${props.t(transferKind === 'upload' ? 'backupUploading' : 'backupDownloading')} ${Math.round(progress * 100)}%`}
      />
      <small>{Math.round(progress * 100)}%</small>
      {transferAbort.current !== undefined && <button type="button" className={css.textButton} onClick={() => {
        restoreTransferFocus.current = true
        transferAbort.current?.abort()
      }}>{props.t('backupCancel')}</button>}
    </div>}
    <p className={css.feedback} aria-live="polite">{feedback}</p>

    <section className={css.location} aria-labelledby="backup-location-title">
      <div>
        <h3 id="backup-location-title">{props.t('backupLocation')}</h3>
        {storageState === 'managed'
          ? <span>{props.t('backupManagedStorage')}</span>
          : storageState === 'local'
            ? <code title={directory}>{directory}</code>
            : <span>{props.t(loadFailed ? 'backupLoadFailed' : 'backupLoading')}</span>}
      </div>
      {storageState === 'local' && <div className={css.rowActions}>
        <button type="button" className={css.textButton} disabled={!directory} onClick={() => {
          void navigator.clipboard.writeText(directory).then(() => {
            setFeedback(props.t('backupPathCopied'))
          })
        }}>{props.t('backupCopyPath')}</button>
        <button type="button" className={css.textButton} disabled={busy || !directory} onClick={() => {
          run(() => props.openBackupDirectory(directory))
        }}>{props.t('backupOpenFolder')}</button>
        <button type="button" className={css.textButton} disabled={busy} onClick={chooseDirectory}>{props.t('backupChangeLocation')}</button>
      </div>}
    </section>

    <section className={css.listSection} aria-labelledby="backup-list-title">
      <div className={css.sectionHeading}>
        <div><h3 id="backup-list-title">{props.t('backupList')}</h3><p>{props.t('backupListHint')}</p></div>
        <button type="button" className={css.textButton} disabled={busy} onClick={() => {
          run(refresh)
        }}>{props.t('backupRefresh')}</button>
      </div>
      {loading
        ? <div className={css.empty}><strong>{props.t('backupLoading')}</strong></div>
        : loadFailed
          ? <div className={css.empty}><strong>{props.t('backupLoadFailed')}</strong></div>
          : items.length === 0
            ? <div className={css.empty}><strong>{props.t('backupEmpty')}</strong><span>{props.t('backupEmptyHint')}</span></div>
            : <div className={css.backupList}>{items.map(item => <article key={item.filename} className={css.backupItem}>
              <div className={css.fileMark} aria-hidden="true">{item.status === 'ready' ? '备' : '!'}</div>
              <div className={css.fileInfo}>
                <strong>{item.filename}</strong>
                <span>{item.manifest
                  ? `${reasonLabel(item.manifest.reason, props.t)} · ${item.manifest.scope.map(category => categoryLabel(category, props.t)).join('、')} · ${formatBytes(item.size)}`
                  : `${props.t(item.status === 'unsupported' ? 'backupUnsupported' : 'backupDamaged')} · ${formatBytes(item.size)}`}</span>
                <small>{formatTime(item.manifest?.createdAt ?? item.modifiedAt)}{item.problem ? ` · ${item.problem}` : ''}</small>
              </div>
              <div className={css.rowActions}>
                {item.status === 'ready' && props.backupDownloadBegin !== undefined && <button type="button" className={css.textButton} disabled={busy} onClick={(event) => { download(item.filename, event.currentTarget) }}>{props.t('backupDownload')}</button>}
                {item.status === 'ready' && <button type="button" className={css.textButton} disabled={busy} onClick={() => {
                  previewStored(item.filename)
                }}>{props.t('backupImport')}</button>}
                <button type="button" className={css.deleteTextButton} disabled={busy} onClick={() => {
                  setDeleteTarget(item.filename)
                  setDialog('delete')
                }}>{props.t('backupDelete')}</button>
              </div>
            </article>)}</div>}
    </section>

    <section className={css.conversationExport}>
      <div><h3>{props.t('conversationExportTitle')}</h3><p>{props.t(currentSession === undefined ? 'exportNoCurrentConversation' : 'exportCurrentConversationScope')}</p></div>
      <button
        type="button"
        className={css.secondaryButton}
        disabled={currentSession === undefined || downloadBusy}
        aria-busy={downloadBusy}
        onClick={currentSession === undefined ? undefined : () => { void props.downloadSession(currentSession) }}
      >{props.t(downloadBusy ? 'exportingCurrentConversation' : 'exportCurrentConversation')}</button>
    </section>

    <section className={css.dangerZone} aria-labelledby="backup-danger-title">
      <div><span className={css.dangerEyebrow}>{props.t('backupDanger')}</span><h3 id="backup-danger-title">{props.t('backupReset')}</h3><p>{props.t('backupResetHint')}</p></div>
      <button type="button" className={css.dangerOutlineButton} disabled={busy} onClick={() => {
        setSelected(ALL_CATEGORIES)
        setBackupBefore(true)
        setDialog('reset')
      }}>{props.t('backupResetAction')}</button>
    </section>

    {dialog === 'create' && <Modal t={props.t} title={props.t('backupCreateDialogTitle')} busy={busy} confirmLabel={props.t('backupCreate')} confirmDisabled={!selected.length} onCancel={() => {
      setDialog(null)
    }} onConfirm={create}>
      <p>{props.t('backupCreateDialogHint')}</p>
      <CategoryPicker selected={selected} onChange={setSelected} t={props.t} />
      <p className={css.note}>{props.t('backupReadableFilenameHint')}</p>
    </Modal>}

    {dialog === 'import' && preview && <Modal t={props.t} title={props.t('backupImportDialogTitle')} busy={busy} confirmLabel={props.t('backupConfirmImport')} onCancel={() => {
      setDialog(null)
      setPreview(undefined)
      releasePreview(preview)
    }} onConfirm={importData}>
      <div className={css.importSource}><strong>{preview.filename}</strong><span>{formatTime(preview.manifest.createdAt)} · {preview.manifest.scope.map(category => categoryLabel(category, props.t)).join('、')}</span></div>
      <p>{props.t('backupImportImmutable')}</p>
      <div className={css.ruleList}>{preview.manifest.scope.map((category) => {
        const summaries = Object.values(preview.domains)
          .map(domain => domain.categories[category])
          .filter((value): value is NonNullable<typeof value> => value !== undefined)
        const summary = summaries.length
          ? summaries.reduce((total, value) => ({
            added: total.added + value.added,
            conflicts: total.conflicts + value.conflicts,
          }), { added: 0, conflicts: 0 })
          : undefined
        return <label key={category}>
          <span><strong>{categoryLabel(category, props.t)}</strong><small>{summary ? `${props.t('backupAdded')} ${summary.added} · ${props.t('backupConflicts')} ${summary.conflicts}` : props.t('backupNoChanges')}</small></span>
          <select value={rules[category] ?? 'keep_local'} onChange={(event) => {
            setRules(current => ({ ...current, [category]: event.target.value as BackupConflictRule }))
          }}>
            {ruleOptions(category).map(rule => <option key={rule} value={rule}>{ruleLabel(rule, props.t)}</option>)}
          </select>
        </label>
      })}</div>
      <label className={css.safetyCheck}><input type="checkbox" checked={backupBefore} onChange={(event) => {
        setBackupBefore(event.target.checked)
      }} /><span><strong>{props.t('backupBeforeImport')}</strong><small>{props.t('backupBeforeOptional')}</small></span></label>
      {!backupBefore && <p className={css.warning}>{props.t('backupNoSafetyWarning')}</p>}
    </Modal>}

    {dialog === 'reset' && <Modal t={props.t} title={props.t('backupResetDialogTitle')} busy={busy} destructive confirmLabel={props.t('backupConfirmReset')} confirmDisabled={!selected.length} onCancel={() => {
      setDialog(null)
    }} onConfirm={resetData}>
      <p>{props.t('backupResetDialogHint')}</p>
      <CategoryPicker selected={selected} onChange={setSelected} t={props.t} />
      <label className={css.safetyCheck}><input type="checkbox" checked={backupBefore} onChange={(event) => {
        setBackupBefore(event.target.checked)
      }} /><span><strong>{props.t('backupBeforeReset')}</strong><small>{props.t('backupBeforeOptional')}</small></span></label>
      {!backupBefore && <p className={css.warning}>{props.t('backupNoSafetyWarning')}</p>}
      <p className={css.note}>{props.t('backupResetKeepsBackups')}</p>
    </Modal>}

    {dialog === 'delete' && <Modal t={props.t} title={props.t('backupDeleteDialogTitle')} busy={busy} destructive confirmLabel={props.t('backupConfirmDelete')} onCancel={() => {
      setDialog(null)
    }} onConfirm={deleteBackup}>
      <p>{props.t('backupDeleteDialogHint')}</p><strong className={css.deleteTarget}>{deleteTarget}</strong>
    </Modal>}
  </section>
}
