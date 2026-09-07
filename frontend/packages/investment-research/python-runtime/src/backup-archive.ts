import { createHash } from 'node:crypto'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

/** Stable manifest discriminator for investment-research backup archives. */
export const BACKUP_FORMAT = 'pa-investment-backup' as const
/** Current readable and writable backup contract version. */
export const BACKUP_FORMAT_VERSION = 1 as const

const MAX_ARCHIVE_ENTRIES = 256
/** Maximum accepted compressed archive size in bytes. */
export const MAX_BACKUP_COMPRESSED_BYTES = 64 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
const DOMAIN_PATH_PATTERN = /^domains\/[a-z0-9][a-z0-9-]*\.json$/
const BACKUP_CATEGORIES = ['strategies', 'holdings', 'watchlist', 'research', 'preferences'] as const
const BACKUP_REASONS = ['manual', 'pre-import', 'pre-reset'] as const
const SUPPORTED_DOMAIN_IDS = ['trading-core', 'market-watch'] as const
const SUPPORTED_DOMAINS = new Set<string>(SUPPORTED_DOMAIN_IDS)

/** User-selectable logical data categories carried by a backup. */
export type BackupCategory =
  | 'strategies'
  | 'holdings'
  | 'watchlist'
  | 'research'
  | 'preferences'

/** User-visible reason recorded in the archive manifest and filename. */
export type BackupReason = 'manual' | 'pre-import' | 'pre-reset'

/** Validated snapshot exported by one owned investment backend. */
export interface DomainSnapshot {
  schemaVersion: number
  backend: string
  categories: Record<string, { count?: number; [key: string]: unknown }>
  revision?: string
  [key: string]: unknown
}

/** Integrity metadata for one domain payload in the archive. */
export interface BackupManifestDomain {
  id: string
  schemaVersion: number
  path: string
  bytes: number
  sha256: string
}

/** Versioned, portable manifest stored as `manifest.json`. */
export interface BackupManifest {
  format: typeof BACKUP_FORMAT
  formatVersion: typeof BACKUP_FORMAT_VERSION
  createdAt: string
  createdByAppVersion: string
  reason: BackupReason
  scope: BackupCategory[]
  contents: Array<{ category: BackupCategory; count: number }>
  domains: BackupManifestDomain[]
}

/** Inputs required to create one deterministic backup archive. */
export interface CreateBackupArchiveInput {
  createdAt: string
  createdByAppVersion: string
  reason: BackupReason
  categories: BackupCategory[]
  snapshots: Record<string, DomainSnapshot>
}

/** Serialized archive bytes paired with their validated manifest. */
export interface BackupArchive {
  bytes: Uint8Array
  manifest: BackupManifest
}

const CATEGORY_LABELS: Record<BackupCategory, string> = {
  strategies: '策略',
  holdings: '持仓',
  watchlist: '自选',
  research: '研究记录',
  preferences: '偏好',
}

const REASON_LABELS: Partial<Record<BackupReason, string>> = {
  'pre-import': '导入前',
  'pre-reset': '清空前',
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}格式无效`)
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value) throw new Error(`${label}格式无效`)
}

function isBackupCategory(value: unknown): value is BackupCategory {
  return typeof value === 'string'
    && (BACKUP_CATEGORIES as readonly string[]).includes(value)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function countCategory(snapshots: Record<string, DomainSnapshot>, category: BackupCategory): number {
  return Object.values(snapshots).reduce((total, snapshot) => {
    const count = snapshot.categories[category]?.count
    return total + (typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : 0)
  }, 0)
}

function validateDomainId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`领域标识格式无效：${id}`)
}

/**
 * Validate one backend snapshot before archive creation or import preview.
 * @param snapshot - Unknown JSON value received from an owned backend or archive.
 * @param expectedDomainId - Backend id that must match the snapshot discriminator.
 * @returns An assertion that narrows the input to a validated domain snapshot.
 */
export function validateDomainSnapshot(snapshot: unknown, expectedDomainId: string): asserts snapshot is DomainSnapshot {
  assertPlainObject(snapshot, `领域 ${expectedDomainId}`)
  if (!Number.isInteger(snapshot.schemaVersion) || Number(snapshot.schemaVersion) < 1) {
    throw new Error(`领域 ${expectedDomainId} 的 schemaVersion 格式无效`)
  }
  if (snapshot.backend !== expectedDomainId) {
    throw new Error(`领域 ${expectedDomainId} 的 backend 不匹配`)
  }
  assertPlainObject(snapshot.categories, `领域 ${expectedDomainId} 的 categories`)
  for (const [category, payload] of Object.entries(snapshot.categories)) {
    if (!isBackupCategory(category)) throw new Error(`领域 ${expectedDomainId} 包含未知分类 ${category}`)
    assertPlainObject(payload, `领域 ${expectedDomainId} 的 ${category}`)
    if (!Number.isSafeInteger(payload.count) || Number(payload.count) < 0) {
      throw new Error(`领域 ${expectedDomainId} 的 ${category} 数量无效`)
    }
    assertPlainObject(payload.collections, `领域 ${expectedDomainId} 的 ${category} collections`)
    let actualCount = 0
    for (const [collection, document] of Object.entries(payload.collections)) {
      assertPlainObject(document, `领域 ${expectedDomainId} 的 ${category}.${collection}`)
      const rows = document.default
      actualCount += Array.isArray(rows) ? rows.length : Object.keys(document).length
    }
    if (actualCount !== payload.count) {
      throw new Error(`领域 ${expectedDomainId} 的 ${category} 数量与集合数据不匹配`)
    }
  }
}

/**
 * Serialize validated domain snapshots into a bounded `.pabackup` ZIP archive.
 * @param input - Application version, creation metadata, scope, and domain snapshots.
 * @returns Archive bytes and the manifest written into those bytes.
 */
export function createBackupArchive(input: CreateBackupArchiveInput): BackupArchive {
  if (!input.categories.length) throw new Error('至少选择一个备份分类')
  if (!input.categories.every(isBackupCategory)) throw new Error('备份分类无效')
  if (!Number.isFinite(new Date(input.createdAt).getTime())) throw new Error('备份创建时间格式无效')
  assertString(input.createdByAppVersion, '应用版本')
  if (!(BACKUP_REASONS as readonly string[]).includes(input.reason)) throw new Error('备份原因无效')

  const scope = [...new Set(input.categories)]
  const unknownDomain = Object.keys(input.snapshots).find(id => !SUPPORTED_DOMAINS.has(id))
  if (unknownDomain) throw new Error(`不支持的备份领域：${unknownDomain}`)
  const normalizedSnapshots: Record<string, DomainSnapshot> = Object.fromEntries(
    SUPPORTED_DOMAIN_IDS.map(id => [id, input.snapshots[id] ?? {
      schemaVersion: 1,
      backend: id,
      categories: {},
    }]),
  )
  const missingCategory = scope.find(category => (
    !Object.values(normalizedSnapshots).some(snapshot => category in snapshot.categories)
  ))
  if (missingCategory) throw new Error(`备份范围 ${missingCategory} 缺少领域数据`)

  const entries: Record<string, Uint8Array> = {}
  let uncompressedBytes = 0
  const domains = Object.entries(normalizedSnapshots)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, snapshot]) => {
      validateDomainId(id)
      validateDomainSnapshot(snapshot, id)
      const path = `domains/${id}.json`
      const bytes = strToU8(JSON.stringify(snapshot))
      uncompressedBytes += bytes.byteLength
      if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw new Error('备份解压后超过大小限制')
      entries[path] = bytes
      return {
        id,
        schemaVersion: snapshot.schemaVersion,
        path,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      }
    })

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: input.createdAt,
    createdByAppVersion: input.createdByAppVersion,
    reason: input.reason,
    scope,
    contents: scope.map(category => ({ category, count: countCategory(normalizedSnapshots, category) })),
    domains,
  }
  entries['manifest.json'] = strToU8(JSON.stringify(manifest))
  uncompressedBytes += entries['manifest.json'].byteLength
  if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw new Error('备份解压后超过大小限制')
  const bytes = zipSync(entries)
  if (bytes.byteLength > MAX_BACKUP_COMPRESSED_BYTES) throw new Error('备份文件超过 64 MiB 限制')
  inspectBackupArchive(bytes)
  return { bytes, manifest }
}

function parseManifest(value: unknown): BackupManifest {
  assertPlainObject(value, 'manifest')
  if (value.format !== BACKUP_FORMAT) throw new Error('不是投研备份文件')
  if (typeof value.formatVersion !== 'number' || !Number.isInteger(value.formatVersion)) {
    throw new Error('备份格式版本无效')
  }
  if (value.formatVersion > BACKUP_FORMAT_VERSION) throw new Error('备份由更新版本的应用创建，请先升级应用')
  if (value.formatVersion !== BACKUP_FORMAT_VERSION) throw new Error('不支持的备份格式版本')
  assertString(value.createdAt, '备份创建时间')
  if (!Number.isFinite(new Date(value.createdAt).getTime())) throw new Error('备份创建时间格式无效')
  assertString(value.createdByAppVersion, '创建应用版本')
  if (!(BACKUP_REASONS as readonly unknown[]).includes(value.reason)) throw new Error('备份原因无效')
  if (!Array.isArray(value.scope) || !Array.isArray(value.contents) || !Array.isArray(value.domains)) {
    throw new Error('备份清单格式无效')
  }
  if (!value.scope.length || !value.scope.every(isBackupCategory)) throw new Error('备份范围无效')
  if (new Set(value.scope).size !== value.scope.length) throw new Error('备份范围包含重复分类')

  const contentCategories = new Set<string>()
  for (const content of value.contents) {
    assertPlainObject(content, '备份内容')
    if (!isBackupCategory(content.category) || !value.scope.includes(content.category)) {
      throw new Error('备份内容超出声明范围')
    }
    if (contentCategories.has(content.category)) throw new Error('备份内容包含重复分类')
    if (!Number.isSafeInteger(content.count) || Number(content.count) < 0) {
      throw new Error(`备份内容 ${content.category} 的数量无效`)
    }
    contentCategories.add(content.category)
  }
  if (value.scope.some(category => !contentCategories.has(category))) {
    throw new Error('备份内容未覆盖全部声明范围')
  }

  if (!value.domains.length) throw new Error('备份清单缺少领域')
  const domainIds = new Set<string>()
  for (const domain of value.domains) {
    assertPlainObject(domain, '领域清单')
    assertString(domain.id, '领域标识')
    assertString(domain.path, '领域路径')
    assertString(domain.sha256, '领域校验和')
    validateDomainId(domain.id)
    if (!SUPPORTED_DOMAINS.has(domain.id)) throw new Error(`不支持的备份领域：${domain.id}`)
    if (domainIds.has(domain.id)) throw new Error(`备份包含重复领域：${domain.id}`)
    domainIds.add(domain.id)
    if (domain.path !== `domains/${domain.id}.json` || !DOMAIN_PATH_PATTERN.test(domain.path)) {
      throw new Error(`领域路径无效：${domain.path}`)
    }
    if (!/^[a-f0-9]{64}$/.test(domain.sha256)) throw new Error(`领域 ${domain.id} 的校验和格式无效`)
    if (!Number.isInteger(domain.schemaVersion) || Number(domain.schemaVersion) < 1) {
      throw new Error(`领域 ${domain.id} 的 schemaVersion 无效`)
    }
    if (!Number.isInteger(domain.bytes) || Number(domain.bytes) < 0) {
      throw new Error(`领域 ${domain.id} 的字节数无效`)
    }
  }
  return value as unknown as BackupManifest
}

/**
 * Validate and decode a bounded `.pabackup` ZIP archive without mutating its source.
 * @param bytes - Complete compressed archive bytes.
 * @returns The validated manifest and domain snapshots.
 */
export function inspectBackupArchive(bytes: Uint8Array): {
  manifest: BackupManifest
  snapshots: Record<string, DomainSnapshot>
} {
  if (bytes.byteLength > MAX_BACKUP_COMPRESSED_BYTES) throw new Error('备份文件超过 64 MiB 限制')
  let entries: Record<string, Uint8Array>
  let declaredBytes = 0
  let entryCount = 0
  const declaredPaths = new Set<string>()
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        entryCount += 1
        if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error('备份文件条目过多')
        if (declaredPaths.has(file.name)) throw new Error(`备份包含重复条目：${file.name}`)
        declaredPaths.add(file.name)
        if (file.name !== 'manifest.json' && !DOMAIN_PATH_PATTERN.test(file.name)) {
          throw new Error(`备份包含未授权条目：${file.name}`)
        }
        if (!Number.isSafeInteger(file.originalSize)) throw new Error('备份条目大小无效')
        declaredBytes += file.originalSize
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_UNCOMPRESSED_BYTES) {
          throw new Error('备份解压后超过大小限制')
        }
        return true
      },
    })
  }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('备份')) throw error
    throw new Error('备份文件不是有效的 ZIP 容器')
  }
  const paths = Object.keys(entries)
  const totalBytes = Object.values(entries).reduce((total, entry) => total + entry.byteLength, 0)
  if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw new Error('备份解压后超过大小限制')

  const manifestBytes = entries['manifest.json']
  if (!manifestBytes) throw new Error('备份缺少 manifest.json')
  let manifestValue: unknown
  try {
    manifestValue = JSON.parse(strFromU8(manifestBytes))
  }
  catch {
    throw new Error('备份清单不是有效的 JSON')
  }
  const manifest = parseManifest(manifestValue)
  if (manifest.domains.length !== SUPPORTED_DOMAIN_IDS.length
    || SUPPORTED_DOMAIN_IDS.some(id => !manifest.domains.some(domain => domain.id === id))) {
    throw new Error('备份领域不完整')
  }
  const allowedPaths = new Set(['manifest.json', ...manifest.domains.map(domain => domain.path)])
  const unauthorized = paths.find(path => !allowedPaths.has(path))
  if (unauthorized) throw new Error(`备份包含未授权条目：${unauthorized}`)
  if (allowedPaths.size !== paths.length) throw new Error('备份缺少领域文件或包含重复领域')

  const snapshots: Record<string, DomainSnapshot> = {}
  for (const domain of manifest.domains) {
    const domainBytes = entries[domain.path]
    if (!domainBytes) throw new Error(`备份缺少领域文件：${domain.path}`)
    if (sha256(domainBytes) !== domain.sha256) throw new Error(`领域 ${domain.id} 的校验和不匹配`)
    if (domainBytes.byteLength !== domain.bytes) throw new Error(`领域 ${domain.id} 的字节数不匹配`)
    let snapshot: unknown
    try {
      snapshot = JSON.parse(strFromU8(domainBytes))
    }
    catch {
      throw new Error(`领域 ${domain.id} 不是有效的 JSON`)
    }
    validateDomainSnapshot(snapshot, domain.id)
    if (snapshot.schemaVersion !== domain.schemaVersion) {
      throw new Error(`领域 ${domain.id} 的 schemaVersion 不匹配`)
    }
    const hiddenCategory = Object.keys(snapshot.categories)
      .find(category => !manifest.scope.includes(category as BackupCategory))
    if (hiddenCategory) {
      throw new Error(`领域 ${domain.id} 的 ${hiddenCategory} 超出备份声明范围`)
    }
    snapshots[domain.id] = snapshot
  }
  for (const content of manifest.contents) {
    if (countCategory(snapshots, content.category) !== content.count) {
      throw new Error(`备份内容 ${content.category} 的数量与领域数据不匹配`)
    }
    if (!Object.values(snapshots).some(snapshot => content.category in snapshot.categories)) {
      throw new Error(`备份内容 ${content.category} 缺少领域数据`)
    }
  }
  return { manifest, snapshots }
}

/**
 * Build a filesystem-safe backup name that exposes reason, scope, and local time.
 * @param input - Backup reason, creation time, and either categories or explicit labels.
 * @returns A readable filename ending in `.pabackup`.
 */
export function readableBackupFilename(input: {
  reason: BackupReason
  categoryLabels?: string[]
  categories?: BackupCategory[]
  createdAt: Date
  timezoneOffsetMinutes?: number
}): string {
  const timezoneOffsetMinutes = input.timezoneOffsetMinutes ?? input.createdAt.getTimezoneOffset()
  const local = new Date(input.createdAt.getTime() - timezoneOffsetMinutes * 60_000)
  const pad = (value: number) => String(value).padStart(2, '0')
  const timestamp = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}_${pad(local.getUTCHours())}-${pad(local.getUTCMinutes())}-${pad(local.getUTCSeconds())}`
  const allCategories: readonly BackupCategory[] = BACKUP_CATEGORIES
  const categoryLabels = input.categoryLabels
    ?? (allCategories.every(category => input.categories?.includes(category))
      ? ['全量数据']
      : (input.categories ?? []).map(category => CATEGORY_LABELS[category]))
  const scopeLabel = categoryLabels.join('').replace(/[\\/:*?"<>|]/g, '') || '投研数据'
  const reasonLabel = REASON_LABELS[input.reason]
  return ['投研备份', reasonLabel, scopeLabel, timestamp].filter(Boolean).join('-') + '.pabackup'
}
