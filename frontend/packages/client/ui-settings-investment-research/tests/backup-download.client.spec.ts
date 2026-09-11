import { describe, expect, it, vi } from 'vitest'
import { downloadBackup } from '../src/client/backup-download.ts'

describe('downloadBackup', () => {
  it('reads ordered chunks and returns the authenticated backup blob', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const api = {
      backupDownloadBegin: vi.fn(async () => ({ id: 'download-1', filename: '备份.pabackup', size: 5, chunkSize: 3 })),
      backupDownloadChunk: vi.fn(async ({ offset }: { offset: number }) => {
        const nextOffset = Math.min(offset + 3, bytes.length)
        const base64 = btoa(String.fromCharCode(...bytes.slice(offset, nextOffset)))
        return { base64, nextOffset, done: nextOffset === bytes.length }
      }),
      backupDownloadCancel: vi.fn(async () => {}),
    }
    const progress = vi.fn()
    const result = await downloadBackup('备份.pabackup', api, progress)
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(bytes)
    expect(result.filename).toBe('备份.pabackup')
    expect(progress).toHaveBeenLastCalledWith(1)
    expect(api.backupDownloadCancel).not.toHaveBeenCalled()
  })

  it('cancels a started download after transport failure', async () => {
    const api = {
      backupDownloadBegin: vi.fn(async () => ({ id: 'download-2', filename: '备份.pabackup', size: 5, chunkSize: 3 })),
      backupDownloadChunk: vi.fn(async () => { throw new Error('network failed') }),
      backupDownloadCancel: vi.fn(async () => {}),
    }
    await expect(downloadBackup('备份.pabackup', api)).rejects.toThrow('network failed')
    expect(api.backupDownloadCancel).toHaveBeenCalledWith('download-2')
  })

  it('rejects and cleans up a chunk whose declared span does not match its bytes', async () => {
    const api = {
      backupDownloadBegin: vi.fn(async () => ({ id: 'download-3', filename: '备份.pabackup', size: 4, chunkSize: 4 })),
      backupDownloadChunk: vi.fn(async () => ({ base64: 'eA==', nextOffset: 4, done: true })),
      backupDownloadCancel: vi.fn(async () => {}),
    }
    await expect(downloadBackup('备份.pabackup', api)).rejects.toThrow('下载分块大小无效')
    expect(api.backupDownloadCancel).toHaveBeenCalledWith('download-3')
  })

  it('passes cancellation into a hanging chunk request and releases the server session', async () => {
    let chunkSignal: AbortSignal | undefined
    const api = {
      backupDownloadBegin: vi.fn(async () => ({ id: 'download-4', filename: '备份.pabackup', size: 4, chunkSize: 4 })),
      backupDownloadChunk: vi.fn((_input: unknown, signal?: AbortSignal) => {
        chunkSignal = signal
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
          }, { once: true })
        })
      }),
      backupDownloadCancel: vi.fn(async () => {}),
    }
    const controller = new AbortController()
    const pending = downloadBackup('备份.pabackup', api, () => {}, controller.signal)
    await vi.waitFor(() => { expect(api.backupDownloadChunk).toHaveBeenCalledOnce() })

    controller.abort(new Error('user cancelled'))

    await expect(pending).rejects.toThrow('user cancelled')
    expect(chunkSignal).toBe(controller.signal)
    expect(api.backupDownloadCancel).toHaveBeenCalledWith('download-4')
  })
})
