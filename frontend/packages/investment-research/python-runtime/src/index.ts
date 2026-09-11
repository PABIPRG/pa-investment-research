/** Investment Python backend registration, verification, and lease service. @module @deepseek-ai/dsh-investment-python-runtime */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import packageManifest from '@deepseek-ai/dsh-investment-python-runtime/package.json' with { type: 'json' }
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { DeploymentCapabilitySnapshot } from '@deepseek-ai/dsh-host-deployment-capabilities'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { bindTypertRemote, Remote, TypertRemoteFailure, type RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import { BackupPublicError, BackupService } from './backup-service.ts'
import { InvestmentBackendManager } from './runtime.ts'
import { requestInvestmentData } from './data.ts'
import type {
  BackupDescription,
  Config,
  InvestmentBackendId,
  InvestmentCapabilityDefinition,
  InvestmentCapabilityUse,
  InvestmentReadinessSnapshot,
  InvestmentDataRequest,
  InvestmentJsonValue,
  InvestmentRestartResult,
  PythonBackendDefinition,
  PythonBackendLease,
} from './types.ts'
import type { BackupCategory, BackupManifest, BackupReason } from './backup-archive.ts'
import type { BackupConflictRule, BackupListItem, BackupPreview } from './backup-service.ts'

const BACKUP_CREATED_BY_APP_VERSION = packageManifest.version

function backupRemoteFailure(error: unknown, fallback: string): TypertRemoteFailure<RemoteFailure> {
  if (error instanceof BackupPublicError) {
    return new TypertRemoteFailure({ code: error.code, message: error.message, details: {} }, error)
  }
  return new TypertRemoteFailure({ code: 'internal', message: fallback, details: {} }, error)
}

function backupRemote<T>(operation: () => T, fallback: string): T {
  try {
    const result = operation()
    if (result instanceof Promise) {
      return result.catch((error: unknown) => { throw backupRemoteFailure(error, fallback) }) as T
    }
    return result
  }
  catch (error) {
    throw backupRemoteFailure(error, fallback)
  }
}

export { checkBackendHealth } from './health.ts'
export type { BackendHealthOptions } from './health.ts'
export { resolveBackendAddress, resolveBackendPaths } from './path.ts'
export { dryRunDshInstanceMigration, initializeDshInstance, migrateDshInstance } from './instance-migration.ts'
export type {
  DshInstanceMigrationPlan,
  ExcludedInstanceEntry,
  InstanceMigrationRejection,
  MigrateDshInstanceOptions,
  MigrateDshInstanceResult,
  MigratedInstanceFile,
  PlannedInstanceFile,
  SqliteBackup,
} from './instance-migration.ts'
export { verifyInvestmentRuntimeDescriptor } from './descriptor.ts'
export type {
  InvestmentRuntimeDescriptor,
  InvestmentRuntimeDescriptorOptions,
  InvestmentRuntimeFileDescriptor,
  VerifiedInvestmentRuntime,
} from './descriptor.ts'
export { InvestmentBackendManager } from './runtime.ts'
export {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  createBackupArchive,
  inspectBackupArchive,
  readableBackupFilename,
} from './backup-archive.ts'
export type { InvestmentBackendManagerOptions } from './runtime.ts'
export { backendLogPaths, BackendLog, safeErrorMessage } from './log.ts'
export { clearOwnedBackendState, ownedBackendStatePath, readOwnedBackendState, writeOwnedBackendState } from './state.ts'
export type { BackendLogOptions, BackendLogPaths } from './log.ts'
export type { OwnedBackendState, OwnedBackendStateRead } from './state.ts'
export type { BackendPathResolutionOptions } from './path.ts'
export type {
  BackendHealthResult,
  BackupDescription,
  Config,
  InvestmentBackendId,
  InvestmentBackendMode,
  InvestmentBackendReadiness,
  InvestmentCapabilityDefinition,
  InvestmentCapabilityReadiness,
  InvestmentCapabilityUse,
  InvestmentCredentialReadiness,
  InvestmentReadinessSnapshot,
  InvestmentDataOperation,
  InvestmentDataRequest,
  InvestmentJsonValue,
  InvestmentRuntimeAssetReadiness,
  InvestmentRestartResult,
  ManagedCredentialEnv,
  PythonBackendDefinition,
  PythonBackendLease,
  ResolvedBackendAddress,
  ResolvedBackendPaths,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    investmentPythonRuntime: InvestmentPythonRuntime
  }
}

/** Runtime service that verifies registered investment Python backends and leases their URLs. */
export class InvestmentPythonRuntime extends Service {
  static inject = ['credentials', 'deploymentCapabilities', 'subprocess']

  /** Visible binding consumed by Typert Gateway source-mode discovery. */
  readonly typertRemote = bindTypertRemote(this, 'investmentPythonRuntime')

  static Config: z<Config> = z.object({
    dshHome: z.string(),
    startupTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
    healthPollMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(250),
    healthFreshnessMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(5_000),
    healthTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(2_000),
    shutdownGraceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(5_000),
    logTailBytes: z.number().step(1).min(1).default(65_536),
    logMaxBytes: z.number().step(1).min(1).default(4_194_304),
  })

  private readonly manager: InvestmentBackendManager
  private readonly holdingsNativeToken = randomBytes(32).toString('base64url')
  private readonly backups: BackupService
  private readonly deploymentSnapshot: DeploymentCapabilitySnapshot

  private deployment(): DeploymentCapabilitySnapshot {
    return this.deploymentSnapshot
  }

  /**
   * Create and install the investment Python Runtime service.
   * @param ctx - Cordis context that owns this service.
   * @param config - deployment tunables used by managed lifecycle support.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'investmentPythonRuntime')
    const deploymentCapabilities = ctx.get('deploymentCapabilities')
    if (deploymentCapabilities === undefined) {
      throw new Error('investment Python runtime: deploymentCapabilities service is required')
    }
    this.deploymentSnapshot = deploymentCapabilities.snapshot()
    const dshHome = resolveDshHome(config.dshHome)
    const dataTransferToken = randomBytes(32).toString('base64url')
    const coordinatorDirectory = join(dshHome, 'investment-research', 'transfer-transactions')
    this.manager = new InvestmentBackendManager({
      subprocess: ctx.subprocess,
      config,
      resolveCredential: ctx.credentials.resolve.bind(ctx.credentials),
      describeCredential: ctx.credentials.describe.bind(ctx.credentials),
      dataTransferEnvironment: {
        'trading-core': {
          DSH_HOLDINGS_NATIVE_TOKEN: this.holdingsNativeToken,
          DSH_DATA_TRANSFER_TOKEN: dataTransferToken,
          DSH_DATA_TRANSFER_COORDINATOR_DIR: coordinatorDirectory,
        },
        'market-watch': {
          DSH_DATA_TRANSFER_TOKEN: dataTransferToken,
          DSH_DATA_TRANSFER_COORDINATOR_DIR: coordinatorDirectory,
        },
      },
    })
    this.backups = new BackupService({
      dshHome,
      appVersion: BACKUP_CREATED_BY_APP_VERSION,
      managedStorage: this.deploymentSnapshot.surface === 'cloud-web',
      request: async (backend, operation, input, signal) => {
        const lease = await this.manager.acquire(backend, signal)
        try {
          if (lease.ownership !== 'owned') {
            throw new Error(`investment backup: ${backend} must be owned by this app instance`)
          }
          const categoriesValue = input.categories
          const categories = Array.isArray(categoriesValue)
            && categoriesValue.every(value => typeof value === 'string')
            ? categoriesValue
            : undefined
          if (operation === 'export' && (!categories || !categories.length)) {
            throw new Error('investment backup: export categories are invalid')
          }
          const path = operation === 'export'
            ? `/data-transfer/export?categories=${encodeURIComponent((categories ?? []).join(','))}`
            : `/data-transfer/${operation}`
          const response = await fetch(`${lease.baseUrl}${path}`, {
            method: operation === 'export' ? 'GET' : 'POST',
            headers: {
              Authorization: `Bearer ${dataTransferToken}`,
              ...(operation === 'export' ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(operation === 'export' ? {} : { body: JSON.stringify(input) }),
            ...(signal === undefined ? {} : { signal }),
          })
          if (!response.ok) {
            await response.body?.cancel().catch(() => {})
            throw new Error(`[backup-backend-http-error] ${backend}/${operation} returned HTTP ${response.status}`)
          }
          const value: unknown = await response.json()
          return value
        }
        finally {
          await lease.release()
        }
      },
    })
    ctx.on('credentials/updated', (ref) => { this.manager.credentialUpdated(ref) })
    ctx.effect(() => async () => {
      await this.backups.dispose()
      await this.manager.dispose()
    }, 'investment Python runtime teardown')
  }

  /**
   * Register one backend definition.
   * @param definition - complete backend identity and launch definition.
   * @returns a disposer that removes this definition.
   */
  register(definition: PythonBackendDefinition): () => void {
    return this.manager.register(definition)
  }

  /**
   * Verify one registered backend and acquire a caller-owned lease.
   * @param id - registered backend id.
   * @param signal - optional health-check cancellation.
   * @returns a verified URL lease.
   */
  async acquire(id: InvestmentBackendId, signal?: AbortSignal): Promise<PythonBackendLease> {
    return this.manager.acquire(id, signal)
  }

  /**
   * Publish one backend capability after its business tools are registered.
   * @param definition - backend, tool count, and LLM relationship.
   * @returns idempotent disposer for the capability contribution.
   */
  registerCapability(definition: InvestmentCapabilityDefinition): () => void {
    return this.manager.registerCapability(definition)
  }

  /**
   * Reject an operation that cannot safely use the active backend capability.
   * @param backendId - backend required by the operation.
   * @param use - operation's LLM relationship.
   */
  assertCapability(backendId: InvestmentBackendId, use: InvestmentCapabilityUse): void {
    this.manager.assertCapability(backendId, use)
  }

  /**
   * Read the immutable, client-safe Runtime readiness projection.
   * @returns current backend, credential, and capability facts.
   */
  @Remote('readiness')
  readiness(): InvestmentReadinessSnapshot {
    return this.manager.readiness()
  }

  /**
   * Execute one browser-safe, allow-listed investment data operation.
   * Backend origins and arbitrary paths never cross the Remote boundary.
   * @param request - Stable operation name and validated JSON input.
   * @returns The backend's lossless JSON response.
   */
  @Remote('request-data')
  requestData(request: InvestmentDataRequest): Promise<InvestmentJsonValue> {
    if (!this.deployment().brokerSync && [
      'trading-core.holdings-source',
      'trading-core.holdings-detect',
      'trading-core.holdings-sync',
      'trading-core.holdings-user-config',
      'trading-core.holdings-user-config-update',
    ].includes(request.operation)) {
      return Promise.reject(new Error('云端 Web 不连接或扫描券商客户端，请使用手工录入或批量导入持仓。'))
    }
    return requestInvestmentData(request, id => this.manager.acquire(id))
  }

  /**
   * Run one native holdings operation after the Electron main process obtained consent.
   * This method is deliberately absent from the Remote registry.
   * @param input - fixed action and account; client path comes only from the native picker.
   * @returns backend readiness or a read-only preview.
   */
  async nativeHoldings(input: { action: 'read' | 'launch' | 'select_client'; account_mode: 'real' | 'simulated'; client_path?: string }): Promise<unknown> {
    if (!this.deployment().nativeHoldings) {
      throw new Error('当前部署不提供原生持仓操作。')
    }
    const lease = await this.manager.acquire('trading-core')
    try {
      if (lease.ownership !== 'owned') throw new Error('原生持仓操作需要本应用管理的本机后台。')
      const response = await fetch(new URL('/holdings/native', lease.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Holdings-Native': this.holdingsNativeToken },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(240_000),
      })
      if (!response.ok) throw new Error('本机操作失败，请重新检查客户端。')
      return await response.json()
    } finally {
      await lease.release()
    }
  }

  /**
   * Read user-visible backup configuration without exposing internal upload paths.
   * @returns The configured directory and stable backup-format capabilities.
   */
  @Remote('backup-describe')
  async backupDescribe(): Promise<BackupDescription> {
    if (!this.deployment().hostDirectories) {
      return { location: { kind: 'managed' }, format: 'pabackup', scheduledBackup: false }
    }
    const value = await backupRemote(() => this.backups.describe(), '无法读取备份设置，请稍后重试。')
    return { directory: value.directory, location: { kind: 'local', directory: value.directory }, format: value.format, scheduledBackup: value.scheduledBackup }
  }

  /**
   * Persist a user-selected backup directory.
   * @param directory - Absolute directory selected by the local user.
   * @returns The normalized directory persisted by the Host.
   */
  @Remote('backup-set-directory')
  backupSetDirectory(directory: string): Promise<{ directory: string }> {
    if (!this.deployment().hostDirectories) {
      return backupRemote(
        () => Promise.reject(new BackupPublicError('remote-rejected', '云端 Web 使用托管备份存储，不能更改服务器目录。')),
        '无法更新备份位置，请稍后重试。',
      )
    }
    return backupRemote(() => this.backups.setDirectory(directory), '无法更新备份位置，请检查目录后重试。')
  }

  /**
   * Start a validated, bounded browser download for a stored backup.
   * @param filename - Direct child filename returned by the backup list.
   * @param signal - Carrier cancellation for the allocation and bounded file read.
   * @returns An opaque download id, immutable file metadata, and required chunk size.
   */
  @Remote('backup-download-begin')
  backupDownloadBegin(filename: string, signal: AbortSignal): Promise<{ id: string; filename: string; size: number; chunkSize: number }> {
    return backupRemote(() => this.backups.beginDownload(filename, signal), '无法开始下载，请刷新备份列表后重试。')
  }

  /**
   * Read one chunk from a browser download session.
   * @param input - Download id and the exact next byte offset.
   * @param signal - Carrier cancellation checked before reading the in-memory chunk.
   * @returns The Base64 chunk, next byte offset, and completion flag.
   */
  @Remote('backup-download-chunk')
  backupDownloadChunk(input: { id: string; offset: number }, signal: AbortSignal): { base64: string; nextOffset: number; done: boolean } {
    return backupRemote(() => this.backups.downloadChunk(input, signal), '下载中断，请重新下载。')
  }

  /**
   * Release an incomplete browser download session.
   * @param id - Opaque download id allocated by {@link backupDownloadBegin}.
   */
  @Remote('backup-download-cancel')
  backupDownloadCancel(id: string): void {
    backupRemote(() => this.backups.cancelDownload(id), '无法取消下载，请稍后重试。')
  }

  /**
   * Create a manual or pre-danger backup and return only client-safe metadata.
   * @param input - Selected data categories and the user-visible backup reason.
   * @returns The readable filename and validated versioned manifest.
   */
  @Remote('backup-create')
  async backupCreate(input: { categories: BackupCategory[]; reason: BackupReason }): Promise<{
    filename: string
    manifest: BackupManifest
  }> {
    const { filename, manifest } = await backupRemote(() => this.backups.create(input), '无法创建备份，请稍后重试。')
    return { filename, manifest }
  }

  /**
   * List direct backup files, including damaged and future-version entries.
   * @returns Client-safe metadata for each backup in the configured directory.
   */
  @Remote('backup-list')
  backupList(): Promise<BackupListItem[]> {
    return backupRemote(() => this.backups.list(), '无法读取备份列表，请稍后重试。')
  }

  /**
   * Delete one explicit backup after the client has confirmed the operation.
   * @param filename - Direct child filename returned by the backup list.
   */
  @Remote('backup-delete')
  backupDelete(filename: string): Promise<void> {
    return backupRemote(() => this.backups.delete(filename), '无法删除备份，请刷新列表后重试。')
  }

  /**
   * Inspect one immutable source already present in the configured backup directory.
   * @param filename - Direct child filename returned by the backup list.
   * @param signal - Carrier cancellation for archive inspection and backend previews.
   * @returns A bounded preview with counts, conflicts, and an expiring preview id.
   */
  @Remote('backup-preview-stored')
  backupPreviewStored(filename: string, signal: AbortSignal): Promise<BackupPreview> {
    return backupRemote(() => this.backups.previewStored(filename, signal), '无法读取备份预览，请重新选择备份。')
  }

  /**
   * Allocate a bounded temporary-file upload session for an external backup.
   * @param input - Original filename and exact byte size of the selected archive.
   * @param signal - Carrier cancellation for temporary-file allocation.
   * @returns The opaque upload id and required maximum chunk size.
   */
  @Remote('backup-upload-begin')
  backupUploadBegin(input: { filename: string; size: number }, signal: AbortSignal): Promise<{ id: string; chunkSize: number }> {
    return backupRemote(() => this.backups.beginUpload(input, signal), '无法开始上传，请稍后重试。')
  }

  /**
   * Append one ordered Base64 chunk to an upload session.
   * @param input - Upload id, required byte offset, and bounded Base64 payload.
   * @param signal - Carrier cancellation checked around the durable append.
   * @returns The total number of raw archive bytes received.
   */
  @Remote('backup-upload-chunk')
  backupUploadChunk(input: { id: string; offset: number; base64: string }, signal: AbortSignal): Promise<{ received: number }> {
    return backupRemote(() => this.backups.appendUploadChunk(input, signal), '上传中断，请重新选择文件。')
  }

  /**
   * Validate a complete upload and create an editable import preview.
   * @param id - Opaque upload id allocated by {@link backupUploadBegin}.
   * @param signal - Carrier cancellation for archive inspection and backend previews.
   * @returns A bounded preview with counts, conflicts, and an expiring preview id.
   */
  @Remote('backup-upload-inspect')
  backupUploadInspect(id: string, signal: AbortSignal): Promise<BackupPreview> {
    return backupRemote(() => this.backups.inspectUpload(id, signal), '无法读取上传的备份，请重新选择文件。')
  }

  /**
   * Explicitly release an incomplete upload.
   * @param id - Opaque upload id allocated by {@link backupUploadBegin}.
   */
  @Remote('backup-upload-cancel')
  backupUploadCancel(id: string): Promise<void> {
    return backupRemote(() => this.backups.cancelUpload(id), '无法取消上传，请稍后重试。')
  }

  /**
   * Explicitly release an import preview without mutating its source.
   * @param id - Opaque preview id returned by a stored or uploaded inspection.
   */
  @Remote('backup-preview-cancel')
  backupPreviewCancel(id: string): void {
    backupRemote(() => this.backups.cancelPreview(id), '无法取消导入预览，请稍后重试。')
  }

  /**
   * Apply a preview with user-selected conflict rules; the source remains untouched.
   * @param input - Preview id, conflict rules, and optional safety-backup choice.
   * @returns The applied status and categories committed across data domains.
   */
  @Remote('backup-import')
  backupImport(input: {
    previewId: string
    rules: Partial<Record<BackupCategory, BackupConflictRule>>
    backupBefore: boolean
  }): Promise<{ status: 'applied'; categories: BackupCategory[] }> {
    return backupRemote(
      () => this.backups.importPreview(input.previewId, input.rules, input.backupBefore),
      '无法导入备份；当前数据保持不变，请稍后重试。',
    )
  }

  /**
   * Clear current domain data only; configured and existing backups are never removed.
   * @param input - Categories to clear and optional safety-backup choice.
   * @returns The reset status and categories committed across data domains.
   */
  @Remote('backup-reset')
  backupReset(input: { categories: BackupCategory[]; backupBefore: boolean }): Promise<{
    status: 'reset'
    categories: BackupCategory[]
  }> {
    return backupRemote(() => this.backups.reset(input), '无法清空投研数据；当前数据保持不变，请稍后重试。')
  }

  /**
   * Request the launcher to restart the complete application after the Remote acknowledgement is sent.
   * @returns an accepted result, or an actionable unavailable result when this launcher cannot restart.
   */
  @Remote('request-restart')
  requestRestart(): InvestmentRestartResult {
    const appRestartValue: unknown = this.ctx.get('appRestart')
    if (typeof appRestartValue !== 'function') {
      return { status: 'unavailable', reason: 'Application restart is unavailable from this launcher.' }
    }
    const appRestart = appRestartValue as () => void
    setImmediate(() => { appRestart() })
    return { status: 'accepted' }
  }

  /**
   * Read the mutable lifecycle relations consumed by the invariant companion.
   * @returns active backend entries and backend ids with in-flight acquisition.
   */
  invariantSnapshot(): ReturnType<InvestmentBackendManager['invariantSnapshot']> {
    return this.manager.invariantSnapshot()
  }
}

export default InvestmentPythonRuntime
