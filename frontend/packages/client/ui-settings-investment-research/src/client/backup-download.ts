/** Minimal client facade used by the browser-side chunk downloader. */
export interface BackupDownloadApi {
  backupDownloadBegin(filename: string, signal?: AbortSignal): Promise<{ id: string; filename: string; size: number; chunkSize: number }>
  backupDownloadChunk(
    input: { id: string; offset: number },
    signal?: AbortSignal,
  ): Promise<{ base64: string; nextOffset: number; done: boolean }>
  backupDownloadCancel(id: string): Promise<void>
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

/** Download one stored backup through the bounded authenticated Remote protocol. */
export async function downloadBackup(
  filename: string,
  api: BackupDownloadApi,
  onProgress: (progress: number) => void = () => {},
  signal?: AbortSignal,
): Promise<{ filename: string; blob: Blob }> {
  signal?.throwIfAborted()
  const download = await api.backupDownloadBegin(filename, signal)
  const chunks: Uint8Array[] = []
  try {
    let offset = 0
    while (offset < download.size) {
      signal?.throwIfAborted()
      const chunk = await api.backupDownloadChunk({ id: download.id, offset }, signal)
      if (chunk.nextOffset <= offset || chunk.nextOffset > download.size) throw new Error('下载分块位置无效')
      const bytes = fromBase64(chunk.base64)
      if (bytes.byteLength !== chunk.nextOffset - offset) throw new Error('下载分块大小无效')
      chunks.push(bytes)
      offset = chunk.nextOffset
      onProgress(offset / download.size)
      if (chunk.done !== (offset === download.size)) throw new Error('下载分块完成状态无效')
    }
    const parts = chunks.map(chunk => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer)
    return { filename: download.filename, blob: new Blob(parts, { type: 'application/zip' }) }
  }
  catch (error) {
    await api.backupDownloadCancel(download.id).catch(() => {})
    throw error
  }
}
