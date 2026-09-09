/** Investment Python backend registration, verification, and lease service. @module @deepseek-ai/dsh-investment-python-runtime */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import packageManifest from '@deepseek-ai/dsh-investment-python-runtime/package.json' with { type: 'json' }
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { bindTypertRemote, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { BackupService } from './backup-service.ts'
import { InvestmentBackendManager } from './runtime.ts'
import { requestInvestmentData } from './data.ts'
import type {
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

export { checkBackendHealth } from './health.ts'
export type { BackendHealthOptions } from './health.ts'
export { resolveBackendAddress, resolveBackendPaths } from './path.ts'
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
  static inject = ['credentials', 'subprocess']

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
  private readonly backups: BackupService

  /**
   * Create and install the investment Python Runtime service.
   * @param ctx - Cordis context that owns this service.
   * @param config - deployment tunables used by managed lifecycle support.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'investmentPythonRuntime')
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
      request: async (backend, operation, input) => {
        const lease = await this.manager.acquire(backend)
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
          })
          if (!response.ok) {
            const detail = (await response.text()).slice(0, 2_000)
            throw new Error(`investment backup: ${backend} ${operation} failed with HTTP ${response.status}: ${detail}`)
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
    ctx.effect(() => async () => this.manager.dispose(), 'investment Python runtime teardown')
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
    return requestInvestmentData(request, id => this.manager.acquire(id))
  }

  /**
   * Read user-visible backup configuration without exposing internal upload paths.
   * @returns The configured directory and stable backup-format capabilities.
   */
  @Remote('backup-describe')
  backupDescribe(): Promise<{ directory: string; format: 'pabackup'; scheduledBackup: false }> {
    return this.backups.describe()
  }

  /**
   * Persist a user-selected backup directory.
   * @param directory - Absolute directory selected by the local user.
   * @returns The normalized directory persisted by the Host.
   */
  @Remote('backup-set-directory')
  backupSetDirectory(directory: string): Promise<{ directory: string }> {
    return this.backups.setDirectory(directory)
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
    const { filename, manifest } = await this.backups.create(input)
    return { filename, manifest }
  }

  /**
   * List direct backup files, including damaged and future-version entries.
   * @returns Client-safe metadata for each backup in the configured directory.
   */
  @Remote('backup-list')
  backupList(): Promise<BackupListItem[]> {
    return this.backups.list()
  }

  /**
   * Delete one explicit backup after the client has confirmed the operation.
   * @param filename - Direct child filename returned by the backup list.
   */
  @Remote('backup-delete')
  backupDelete(filename: string): Promise<void> {
    return this.backups.delete(filename)
  }

  /**
   * Inspect one immutable source already present in the configured backup directory.
   * @param filename - Direct child filename returned by the backup list.
   * @returns A bounded preview with counts, conflicts, and an expiring preview id.
   */
  @Remote('backup-preview-stored')
  backupPreviewStored(filename: string): Promise<BackupPreview> {
    return this.backups.previewStored(filename)
  }

  /**
   * Allocate a bounded temporary-file upload session for an external backup.
   * @param input - Original filename and exact byte size of the selected archive.
   * @returns The opaque upload id and required maximum chunk size.
   */
  @Remote('backup-upload-begin')
  backupUploadBegin(input: { filename: string; size: number }): Promise<{ id: string; chunkSize: number }> {
    return this.backups.beginUpload(input)
  }

  /**
   * Append one ordered Base64 chunk to an upload session.
   * @param input - Upload id, required byte offset, and bounded Base64 payload.
   * @returns The total number of raw archive bytes received.
   */
  @Remote('backup-upload-chunk')
  backupUploadChunk(input: { id: string; offset: number; base64: string }): Promise<{ received: number }> {
    return this.backups.appendUploadChunk(input)
  }

  /**
   * Validate a complete upload and create an editable import preview.
   * @param id - Opaque upload id allocated by {@link backupUploadBegin}.
   * @returns A bounded preview with counts, conflicts, and an expiring preview id.
   */
  @Remote('backup-upload-inspect')
  backupUploadInspect(id: string): Promise<BackupPreview> {
    return this.backups.inspectUpload(id)
  }

  /**
   * Explicitly release an incomplete upload.
   * @param id - Opaque upload id allocated by {@link backupUploadBegin}.
   */
  @Remote('backup-upload-cancel')
  backupUploadCancel(id: string): Promise<void> {
    return this.backups.cancelUpload(id)
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
    return this.backups.importPreview(input.previewId, input.rules, input.backupBefore)
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
    return this.backups.reset(input)
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
