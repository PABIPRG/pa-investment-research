import type { BackupPreview } from '@deepseek-ai/dsh-client-investment-research-runtime/client'

/** Minimal client facade used by the browser-side chunk uploader. */
export interface BackupUploadApi {
  backupUploadBegin(input: { filename: string; size: number }, signal?: AbortSignal): Promise<{ id: string; chunkSize: number }>
  backupUploadChunk(input: { id: string; offset: number; base64: string }, signal?: AbortSignal): Promise<{ received: number }>
  backupUploadInspect(id: string, signal?: AbortSignal): Promise<BackupPreview>
  backupUploadCancel(id: string): Promise<void>
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 1) {
    const byte = bytes[offset]
    if (byte === undefined) throw new Error('上传分块读取失败')
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/**
 * Upload one external backup through the bounded Host chunk protocol.
 * @param file - User-selected `.pabackup` file.
 * @param api - Activated investment runtime backup facade.
 * @param onProgress - Callback receiving a normalized value from zero to one.
 * @param signal - Optional cancellation signal for the upload loop.
 * @returns The validated import preview created from the completed upload.
 */
export async function uploadBackup(
  file: File,
  api: BackupUploadApi,
  onProgress: (progress: number) => void = () => {},
  signal?: AbortSignal,
): Promise<BackupPreview> {
  if (file.size <= 0) throw new Error('备份文件不能为空')
  signal?.throwIfAborted()
  const upload = await api.backupUploadBegin({ filename: file.name, size: file.size }, signal)
  try {
    let offset = 0
    while (offset < file.size) {
      signal?.throwIfAborted()
      const bytes = new Uint8Array(await file.slice(offset, offset + upload.chunkSize).arrayBuffer())
      signal?.throwIfAborted()
      const result = await api.backupUploadChunk({ id: upload.id, offset, base64: toBase64(bytes) }, signal)
      offset = result.received
      onProgress(offset / file.size)
    }
    signal?.throwIfAborted()
    return await api.backupUploadInspect(upload.id, signal)
  }
  catch (error) {
    await api.backupUploadCancel(upload.id).catch(() => {})
    throw error
  }
}
