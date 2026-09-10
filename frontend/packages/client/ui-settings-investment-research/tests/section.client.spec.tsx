// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  createSnapshotStore, type SessionId, type SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { SessionLogDownloadState } from '@deepseek-ai/dsh-session-log-export/client'
import type { BackupCategory, BackupListItem, BackupPreview } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { InvestmentReadinessSection } from '../src/client/InvestmentReadinessSection.tsx'
import type {
  InvestmentReadinessSectionInjected, ProjectModelSettings,
} from '../src/client/InvestmentReadinessSection.tsx'
import { createInvestmentReadinessStore } from '../src/client/store.ts'
import type { InvestmentReadinessSnapshot, InvestmentRestartResult } from '../src/client/store.ts'
import { en, zh } from '../src/client/locales.ts'
import type { InvestmentReadinessKey } from '../src/client/locales.ts'

afterEach(cleanup)

const SOURCE_LOG = '/Users/example/DeepSeek Harness/.dsh/investment-research/trading-core/backend.log'
const WINDOWS_LOG = 'C:\\Users\\Example User\\.dsh\\investment-research\\market-watch\\backend.log'
type CredentialRef = InvestmentReadinessSnapshot['backends'][number]['credentials'][number]['ref']
const DEEPSEEK_REF = 'DEEPSEEK_API_KEY' as CredentialRef
const CURRENT_SESSION = 'session-investment-settings' as SessionId
const PROJECT_MODELS: ProjectModelSettings = {
  current: { provider: 'deepseek-official', model: 'deepseek-chat' },
  options: [
    { provider: 'deepseek-official', model: 'deepseek-chat', label: 'DeepSeek Chat', providerLabel: 'DeepSeek' },
    { provider: 'openai', model: 'gpt-5', label: 'GPT-5', providerLabel: 'OpenAI' },
  ],
  writable: true,
  revision: 3,
}

const MISSING: InvestmentReadinessSnapshot = {
  runtimeAsset: { status: 'source-env-ready' },
  backends: [
    {
      backendId: 'trading-core',
      ownership: 'owned',
      backendStatus: 'healthy-owned',
      credentials: [{ ref: DEEPSEEK_REF, configured: false, writable: true, status: 'missing' }],
      capability: { llm: 'required', toolCount: 9, status: 'unavailable' },
      restartRequired: false,
      runtimeLogPath: SOURCE_LOG,
    },
    {
      backendId: 'market-watch',
      ownership: 'owned',
      backendStatus: 'healthy-owned',
      credentials: [{ ref: DEEPSEEK_REF, configured: false, writable: true, status: 'missing' }],
      capability: { llm: 'enhancement', toolCount: 11, status: 'market-template-only' },
      restartRequired: false,
      runtimeLogPath: WINDOWS_LOG,
    },
  ],
}

const CONFIGURED: InvestmentReadinessSnapshot = {
  runtimeAsset: MISSING.runtimeAsset,
  backends: MISSING.backends.map(backend => ({
    ...backend,
    credentials: [{
      ref: DEEPSEEK_REF, configured: true, source: 'managed-file', writable: true, status: 'configured' as const,
    }],
    capability: {
      ...backend.capability!,
      status: backend.backendId === 'trading-core' ? 'stock-full' as const : 'market-full' as const,
    },
  })),
}

const RESTART_REQUIRED: InvestmentReadinessSnapshot = {
  runtimeAsset: CONFIGURED.runtimeAsset,
  backends: CONFIGURED.backends.map(backend => ({
    ...backend,
    credentials: [{
      ref: DEEPSEEK_REF, configured: true, source: 'managed-file', writable: true,
      status: 'restart-required' as const,
    }],
    capability: { ...backend.capability!, status: 'unavailable' as const },
    restartRequired: true,
  })),
}

const INDUSTRY_READY: InvestmentReadinessSnapshot = {
  runtimeAsset: { status: 'source-env-ready' },
  backends: [{
    backendId: 'industry-chain',
    ownership: 'owned',
    backendStatus: 'healthy-owned',
    credentials: [],
    capability: { llm: 'none', toolCount: 0, status: 'industry-full' },
    restartRequired: false,
    runtimeLogPath: '/Users/example/.dsh/investment-research/industry-chain/backend.log',
  }],
}

function mount(
  snapshot: InvestmentReadinessSnapshot,
  overrides: {
    openSection?: (id: string) => void
    requestRestart?: () => Promise<{ status: 'accepted' } | { status: 'unavailable'; reason: string }>
    refresh?: () => Promise<void>
    downloadSession?: (sessionId: SessionId) => Promise<void>
    currentSession?: SessionId
    noCurrentSession?: boolean
    downloadState?: SessionLogDownloadState
    locale?: 'zh' | 'en'
    loadProjectModels?: () => Promise<ProjectModelSettings>
    saveProjectModel?: InvestmentReadinessSectionInjected['saveProjectModel']
    backupList?: () => Promise<BackupListItem[]>
    backupPreviewStored?: (filename: string) => Promise<BackupPreview>
    backupReset?: InvestmentReadinessSectionInjected['backupReset']
    pickBackupDirectory?: () => Promise<string | null>
    reloadPage?: () => void
  } = {},
) {
  const readiness = createSnapshotStore(snapshot)
  const currentSession = overrides.noCurrentSession ? undefined : overrides.currentSession ?? CURRENT_SESSION
  const sessions = createSnapshotStore({ current: currentSession } as SessionListState)
  const sessionLogDownload = createSnapshotStore<SessionLogDownloadState>(
    overrides.downloadState ?? { bySession: {} },
  )
  const restart = createInvestmentReadinessStore().create()
  const openSection = vi.fn(overrides.openSection)
  const requestRestart = vi.fn(overrides.requestRestart ?? (() => Promise.resolve({ status: 'accepted' as const })))
  const refresh = vi.fn(overrides.refresh ?? (() => Promise.resolve()))
  const downloadSession = vi.fn(overrides.downloadSession ?? (() => Promise.resolve()))
  const loadProjectModels = vi.fn(overrides.loadProjectModels ?? (() => Promise.resolve(PROJECT_MODELS)))
  const saveProjectModel = vi.fn(overrides.saveProjectModel ?? (selection => Promise.resolve({
    ...PROJECT_MODELS, current: selection, revision: PROJECT_MODELS.revision + 1,
  })))
  const dictionary = overrides.locale === 'en' ? en : zh
  const backup = {
    backupDescribe: vi.fn(async () => ({ directory: '/Users/example/投研备份', format: 'pabackup' as const, scheduledBackup: false as const })),
    backupSetDirectory: vi.fn(async (directory: string) => ({ directory })),
    backupCreate: vi.fn(async () => ({
      filename: '投研备份-全量数据-2026-09-07_14-35-20.pabackup',
      manifest: { format: 'pa-investment-backup' as const, formatVersion: 1 as const, createdAt: '2026-09-07T06:35:20.000Z', createdByAppVersion: '0.1.0-rc.12', reason: 'manual' as const, scope: ['strategies', 'holdings', 'watchlist', 'research', 'preferences'] as BackupCategory[], contents: [], domains: [] },
    })),
    backupList: vi.fn(overrides.backupList ?? (async () => [])),
    backupDelete: vi.fn(async () => {}),
    backupPreviewStored: vi.fn(overrides.backupPreviewStored),
    backupUploadBegin: vi.fn(),
    backupUploadChunk: vi.fn(),
    backupUploadInspect: vi.fn(),
    backupUploadCancel: vi.fn(async () => {}),
    backupImport: vi.fn(),
    backupReset: vi.fn(overrides.backupReset ?? (async (input: { categories: BackupCategory[] }) => ({ status: 'reset' as const, categories: input.categories }))),
    pickBackupDirectory: vi.fn(overrides.pickBackupDirectory ?? (async () => null)),
    openBackupDirectory: vi.fn(async () => {}),
    reloadPage: vi.fn(overrides.reloadPage),
  }
  const unusedHook = (() => { throw new Error('unused standing hook') }) as never
  const view = render(<InvestmentReadinessSection
    close={() => {}}
    openSection={openSection}
    useSessions={bindSnapshotSelector(sessions)}
    useWorkspaces={unusedHook}
    useInvestmentReadiness={bindSnapshotSelector(readiness)}
    useSessionLogDownload={bindSnapshotSelector(sessionLogDownload)}
    useStore={bindSnapshotSelector(restart)}
    actions={restart.actions}
    downloadSession={downloadSession}
    requestRestart={requestRestart}
    refresh={refresh}
    loadProjectModels={loadProjectModels}
    saveProjectModel={saveProjectModel}
    requestData={vi.fn(async () => ({ backend_env: {}, effective: { HOLDINGS_PROVIDER: 'manual' } }))}
    {...backup}
    t={key => dictionary[key as InvestmentReadinessKey]}
  />)
  return {
    ...view,
    readiness,
    sessionLogDownload,
    restart,
    openSection,
    downloadSession,
    requestRestart,
    refresh,
    loadProjectModels,
    saveProjectModel,
    backup,
  }
}

describe('InvestmentReadinessSection', () => {
  it('presents honest bilingual data-and-backup copy without internal storage concepts', async () => {
    const chinese = mount(CONFIGURED)

    expect(screen.getByRole('heading', { name: '数据与备份' })).toBeTruthy()
    expect(screen.getByText('创建可迁移的投研备份，或将其他电脑的数据增量导入当前状态。')).toBeTruthy()
    expect(screen.getByText('导入不会移动、改名或删除这里的备份。')).toBeTruthy()
    expect(screen.getByText('导出内容仅包含当前对话、关联对话与附件。')).toBeTruthy()
    expect(chinese.container.textContent).not.toContain('工作区')
    expect(chinese.container.textContent).not.toContain('定时备份')
    expect(await screen.findByRole('combobox', { name: '默认主模型' })).toBeTruthy()
    chinese.unmount()

    const english = mount(CONFIGURED, { locale: 'en' })
    expect(screen.getByRole('heading', { name: 'Data & backup' })).toBeTruthy()
    expect(screen.getByText(
      'Create a portable investment backup or merge data from another computer into the current state.',
    )).toBeTruthy()
    expect(screen.getByText(
      'The export contains only the current conversation, related conversations, and attachments.',
    )).toBeTruthy()
    expect(english.container.textContent?.toLowerCase()).not.toContain('workspace')
    expect(english.container.textContent?.toLowerCase()).not.toContain('scheduled backup')
  })

  it('shows the project default model, explains module routing, and persists a new default', async () => {
    const { saveProjectModel } = mount(CONFIGURED)

    const select = await screen.findByRole<HTMLSelectElement>('combobox', { name: '默认主模型' })
    expect(select.value).toBe('deepseek-official\u0000deepseek-chat')
    expect(screen.getByText('跟随会话主模型')).toBeTruthy()
    expect(screen.getAllByText('后端专用 DeepSeek')).toHaveLength(2)
    expect(screen.getByText('检索无需模型')).toBeTruthy()

    fireEvent.change(select, { target: { value: 'openai\u0000gpt-5' } })
    await waitFor(() => {
      expect(saveProjectModel).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5' }, 3)
    })
  })

  it('disables current-conversation export when no Session is selected', () => {
    const { downloadSession } = mount(CONFIGURED, { noCurrentSession: true })

    const button = screen.getByRole('button', { name: '导出当前对话' })
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('当前没有可导出的对话。')).toBeTruthy()
    fireEvent.click(button)
    expect(downloadSession).not.toHaveBeenCalled()
  })

  it('exports the exact current Session through the shared controller action', () => {
    const sessionId = 'session-selected-for-export' as SessionId
    const { downloadSession } = mount(CONFIGURED, { currentSession: sessionId })

    const button = screen.getByRole('button', { name: '导出当前对话' })
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    expect(downloadSession).toHaveBeenCalledOnce()
    expect(downloadSession).toHaveBeenCalledWith(sessionId)
  })

  it('marks the shared download busy and prevents a duplicate request', () => {
    const { downloadSession } = mount(CONFIGURED, {
      downloadState: {
        bySession: {
          [CURRENT_SESSION]: { open: true, status: 'downloading', error: null },
        },
      },
    })

    const button = screen.getByRole('button', { name: '正在导出…' })
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(button)
    expect(downloadSession).not.toHaveBeenCalled()
  })

  it('opens a working backup flow and creates all selected categories', async () => {
    const { backup } = mount(CONFIGURED)

    fireEvent.click(screen.getByRole('button', { name: '创建备份' }))
    const dialog = screen.getByRole('dialog', { name: '创建投研备份' })
    expect(dialog).toBeTruthy()
    expect(screen.getAllByRole('checkbox')).toHaveLength(5)
    fireEvent.click(within(dialog).getByRole('button', { name: '创建备份' }))

    await waitFor(() => {
      expect(backup.backupCreate).toHaveBeenCalledWith({
        categories: ['strategies', 'holdings', 'watchlist', 'research', 'preferences'],
        reason: 'manual',
      })
    })
    expect(await screen.findByText(/投研备份-全量数据-2026-09-07_14-35-20\.pabackup/)).toBeTruthy()
  })

  it('imports from the backup list with editable rules and optional pre-import backup', async () => {
    const filename = '投研备份-持仓-2026-09-07_14-35-20.pabackup'
    const manifest = {
      format: 'pa-investment-backup' as const, formatVersion: 1 as const,
      createdAt: '2026-09-07T06:35:20.000Z', createdByAppVersion: '0.1.0-rc.12',
      reason: 'manual' as const, scope: ['holdings'] as BackupCategory[],
      contents: [{ category: 'holdings' as const, count: 1 }], domains: [],
    }
    const preview: BackupPreview = {
      id: 'preview-1', filename, manifest, expiresAt: '2026-09-08T06:35:20.000Z',
      domains: { 'trading-core': { currentRevision: 'local', categories: { holdings: { added: 1, conflicts: 1, defaultRule: 'keep_local' } } } },
    }
    const { backup } = mount(CONFIGURED, {
      backupList: async () => [{ filename, size: 2048, modifiedAt: manifest.createdAt, status: 'ready', manifest }],
      backupPreviewStored: async () => preview,
    })
    expect(await screen.findByText(filename)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: '导入数据' })[1]!)

    expect(await screen.findByRole('dialog', { name: '确认增量导入' })).toBeTruthy()
    expect(screen.getByText('导入只更新当前状态，不会修改、移动或删除来源备份。')).toBeTruthy()
    const rule = screen.getByRole<HTMLSelectElement>('combobox', { name: /持仓/ })
    expect(within(rule).getAllByRole('option').map(option => option.textContent)).toEqual(['保留本地', '使用导入数据'])
    fireEvent.change(rule, { target: { value: 'use_import' } })
    const safety = screen.getByRole('checkbox', { name: /导入前备份当前数据/ }) as HTMLInputElement
    expect(safety.checked).toBe(true)
    fireEvent.click(safety)
    expect(screen.getByText(/已取消安全备份/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '导入所选数据' }))
    await waitFor(() => {
      expect(backup.backupImport).toHaveBeenCalledWith({
        previewId: 'preview-1', rules: { holdings: 'use_import' }, backupBefore: false,
      })
      expect(backup.reloadPage).toHaveBeenCalledOnce()
    })
  })

  it('closes a non-busy backup dialog with Escape and restores focus', async () => {
    const parentEscapeHandler = vi.fn()
    document.addEventListener('keydown', parentEscapeHandler)
    try {
      mount(CONFIGURED)
      const trigger = screen.getByRole('button', { name: '创建备份' })
      trigger.focus()
      fireEvent.click(trigger)

      expect(screen.getByRole('dialog', { name: '创建投研备份' })).toBeTruthy()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }))
      fireEvent.keyDown(document, { key: 'Escape' })

      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: '创建投研备份' })).toBeNull()
      })
      expect(parentEscapeHandler).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(trigger)
    } finally {
      document.removeEventListener('keydown', parentEscapeHandler)
    }
  })

  it('focuses the safe dialog action without scrolling long modal content', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    try {
      mount(CONFIGURED)
      fireEvent.click(screen.getByRole('button', { name: '选择要清空的数据' }))

      expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }))
      expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    } finally {
      focus.mockRestore()
    }
  })

  it('makes reset explicit, defaults its safety backup on, and explains that backups remain', async () => {
    const { backup } = mount(CONFIGURED)
    fireEvent.click(screen.getByRole('button', { name: '选择要清空的数据' }))

    expect(screen.getByRole('dialog', { name: '清空本地投研数据' })).toBeTruthy()
    expect(screen.getByText('已有备份不会被删除，之后仍可从备份列表重新导入。')).toBeTruthy()
    const safety = screen.getByRole('checkbox', { name: /清空前备份当前数据/ }) as HTMLInputElement
    expect(safety.checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '清空所选数据' }))
    await waitFor(() => {
      expect(backup.backupReset).toHaveBeenCalledWith({
        categories: ['strategies', 'holdings', 'watchlist', 'research', 'preferences'], backupBefore: true,
      })
    })
  })

  it('shows source-owned keyless readiness and routes the only credential action to Models', () => {
    const { container, openSection, requestRestart, refresh } = mount(MISSING)

    expect(screen.getByRole('heading', { name: '投研就绪' })).toBeTruthy()
    expect(screen.getByText('源码 Python 环境')).toBeTruthy()
    expect(screen.getAllByText('本应用管理')).toHaveLength(2)
    expect(screen.getByText('股票分析')).toBeTruthy()
    expect(screen.getByText('9 个工具')).toBeTruthy()
    expect(screen.getByText('完整分析不可用')).toBeTruthy()
    expect(screen.getByText('DeepSeek 必需')).toBeTruthy()
    expect(screen.getByText('盘中盯盘')).toBeTruthy()
    expect(screen.getByText('11 个工具')).toBeTruthy()
    expect(screen.getByText('基础模板可用')).toBeTruthy()
    expect(screen.getByText('DeepSeek 增强')).toBeTruthy()
    expect(screen.getAllByText('DeepSeek API Key 未配置')).toHaveLength(2)
    expect(container.querySelector('input:not([type="file"])')).toBeNull()
    expect(container.textContent).not.toContain('sk-dsh-secret-canary')
    expect(requestRestart).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '打开模型设置' }))
    expect(openSection).toHaveBeenCalledOnce()
    expect(openSection).toHaveBeenCalledWith('models')
  })

  it('projects configured, read-only, attached, and external facts without inferring from the platform', () => {
    const readOnlyAndExternal: InvestmentReadinessSnapshot = {
      runtimeAsset: { status: 'bundled-ready' },
      backends: [
        {
          ...CONFIGURED.backends[0]!,
          ownership: 'attached',
          backendStatus: 'healthy-attached',
          credentials: [{
            ref: DEEPSEEK_REF, configured: true, source: 'environment', writable: false, status: 'read-only',
          }],
        },
        {
          ...CONFIGURED.backends[1]!,
          ownership: 'external',
          backendStatus: 'external',
          credentials: [{ ref: DEEPSEEK_REF, status: 'external-managed' }],
        },
      ],
    }
    mount(readOnlyAndExternal)

    expect(screen.getByText('已连接本机服务')).toBeTruthy()
    expect(screen.getByText('外部服务')).toBeTruthy()
    expect(screen.getByText('由启动环境提供（只读）')).toBeTruthy()
    expect(screen.getByText('凭据由外部服务管理')).toBeTruthy()
    expect(screen.getByText('完整股票分析可用')).toBeTruthy()
    expect(screen.getByText('完整盯盘解读可用')).toBeTruthy()
    expect(screen.getByText('应用随附 Python 环境')).toBeTruthy()
    expect(screen.getByText(WINDOWS_LOG)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '打开模型设置' })).toBeNull()
  })

  it('renders configured credential state independently from its source label', () => {
    mount(CONFIGURED)
    expect(screen.getAllByText('DeepSeek API Key 已配置')).toHaveLength(2)
    expect(screen.getByText('完整股票分析可用')).toBeTruthy()
    expect(screen.getByText('完整盯盘解读可用')).toBeTruthy()
  })

  it('presents the industry backend without a credential repair action', () => {
    mount(INDUSTRY_READY)

    expect(screen.getByText('产业链')).toBeTruthy()
    expect(screen.getByText('无需模型凭据')).toBeTruthy()
    expect(screen.getByText('产业链查询服务已就绪，首次使用时检查数据')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '打开模型设置' })).toBeNull()
  })

  const restartCases: readonly {
    name: string
    invoke: () => Promise<InvestmentRestartResult>
    feedback: string
  }[] = [
    {
      name: 'accepted',
      invoke: () => Promise.resolve({ status: 'accepted' as const }),
      feedback: '已提交重启请求。应用会在安全退出后重新打开。',
    },
    {
      name: 'unavailable',
      invoke: () => Promise.resolve({ status: 'unavailable' as const, reason: '请从桌面应用启动' }),
      feedback: '当前无法自动重启：请从桌面应用启动',
    },
    {
      name: 'error',
      invoke: () => Promise.reject(new Error('transport unavailable')),
      feedback: '重启请求失败，请重试。',
    },
  ]

  it.each(restartCases)('reports restart $name feedback through the declared interaction store', async ({ invoke, feedback }) => {
    let settle!: () => void
    const pending = new Promise<void>((resolve) => { settle = resolve })
    const requestRestart = vi.fn(() => pending.then(invoke))
    mount(RESTART_REQUIRED, { requestRestart })

    expect(screen.getAllByText('Key 已更新，需要重启投研应用')).toHaveLength(2)
    const button = screen.getByRole('button', { name: '重启投研应用' })
    fireEvent.click(button)
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('正在请求安全重启…')
    expect(requestRestart).toHaveBeenCalledOnce()
    await act(async () => { settle() })
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(feedback) })
  })

  it('shows failed-backend repair actions and preserves Host-provided log hints verbatim', async () => {
    const failed: InvestmentReadinessSnapshot = {
      runtimeAsset: { status: 'invalid', detail: 'hash mismatch' },
      backends: [{ ...MISSING.backends[0]!, backendStatus: 'failed', ownership: null }],
    }
    const refresh = vi.fn(() => Promise.resolve())
    mount(failed, { refresh })

    expect(screen.getByText('后端启动失败')).toBeTruthy()
    expect(screen.getByText('Python 运行资源损坏，请重新安装应用')).toBeTruthy()
    expect(screen.getByText(SOURCE_LOG)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }))
    await waitFor(() => { expect(refresh).toHaveBeenCalledOnce() })
  })

  it('keeps empty credentials and stopped backends actionable', async () => {
    const stopped: InvestmentReadinessSnapshot = {
      runtimeAsset: { status: 'missing' },
      backends: [{
        ...MISSING.backends[0]!,
        ownership: null,
        backendStatus: 'stopped',
        credentials: [],
      }],
    }
    const { openSection, refresh } = mount(stopped)

    expect(screen.getByText('DeepSeek API Key 未配置')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开模型设置' }))
    expect(openSection).toHaveBeenCalledWith('models')
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }))
    await waitFor(() => { expect(refresh).toHaveBeenCalledOnce() })
  })

  it('reports refresh failures instead of swallowing a repair error', async () => {
    const failed: InvestmentReadinessSnapshot = {
      runtimeAsset: MISSING.runtimeAsset,
      backends: [{ ...MISSING.backends[0]!, backendStatus: 'failed', ownership: null }],
    }
    mount(failed, { refresh: () => Promise.reject(new Error('readiness unavailable')) })

    fireEvent.click(screen.getByRole('button', { name: '重新检查' }))
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('重新检查失败，请查看运行日志后重试。')
    })
  })

  it('keeps the empty facade snapshot retryable and reports a failed retry', async () => {
    const { refresh } = mount(
      { runtimeAsset: { status: 'missing' }, backends: [] },
      { refresh: () => Promise.reject(new Error('initial readiness unavailable')) },
    )
    expect(screen.getByRole('status').textContent).toBe('正在读取投研运行状态…')
    expect(screen.queryByRole('button', { name: '打开模型设置' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }))
    expect(refresh).toHaveBeenCalledOnce()
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('重新检查失败，请查看运行日志后重试。')
    })
  })

  it('owns one refresh flight and keeps restart feedback independent', async () => {
    let settleRestart!: () => void
    const restartPending = new Promise<void>((resolve) => { settleRestart = resolve })
    let rejectRefresh!: (error: Error) => void
    const refreshPending = new Promise<void>((_resolve, reject) => { rejectRefresh = reject })
    const failedAndRestarting: InvestmentReadinessSnapshot = {
      runtimeAsset: RESTART_REQUIRED.runtimeAsset,
      backends: [{ ...RESTART_REQUIRED.backends[0]!, backendStatus: 'failed' }],
    }
    const { requestRestart, refresh } = mount(failedAndRestarting, {
      requestRestart: () => restartPending.then(() => ({ status: 'accepted' as const })),
      refresh: () => refreshPending,
    })

    const restartButton = screen.getByRole('button', { name: '重启投研应用' })
    const refreshButton = screen.getByRole('button', { name: '重新检查' })
    fireEvent.click(restartButton)
    fireEvent.click(refreshButton)
    fireEvent.click(refreshButton)
    expect(requestRestart).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    expect(restartButton.hasAttribute('disabled')).toBe(true)
    expect(refreshButton.hasAttribute('disabled')).toBe(true)

    await act(async () => { rejectRefresh(new Error('refresh failed')) })
    expect(screen.getByText('重新检查失败，请查看运行日志后重试。')).toBeTruthy()
    expect(restartButton.hasAttribute('disabled')).toBe(true)
    await act(async () => { settleRestart() })
    expect(screen.getByText('已提交重启请求。应用会在安全退出后重新打开。')).toBeTruthy()
  })

  it('keeps operator acceptance steps out of the end-user settings surface', () => {
    const { requestRestart, refresh } = mount(CONFIGURED)
    expect(screen.queryByRole('heading', { name: '验收清单' })).toBeNull()
    expect(screen.queryByText('请在对话中显式执行以下步骤；此页面不会自动运行任何工具。')).toBeNull()
    expect(requestRestart).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })
})
