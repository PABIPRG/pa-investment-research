import { describe, expect, it, vi } from 'vitest'
import { uploadBackup } from '../src/client/backup-upload.ts'

describe('uploadBackup', () => {
  it('uploads ordered chunks, reports progress, and inspects the complete file', async () => {
    const chunks: Array<{ offset: number; bytes: number }> = []
    const api = {
      backupUploadBegin: vi.fn(async () => ({ id: 'upload-1', chunkSize: 3 })),
      backupUploadChunk: vi.fn(async (input: { offset: number; base64: string }) => {
        const bytes = Uint8Array.from(atob(input.base64), character => character.charCodeAt(0))
        chunks.push({ offset: input.offset, bytes: bytes.byteLength })
        return { received: input.offset + bytes.byteLength }
      }),
      backupUploadInspect: vi.fn(async () => ({ id: 'preview-1' })),
      backupUploadCancel: vi.fn(async () => {}),
    }
    const progress = vi.fn()
    const file = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7])], '外部备份.pabackup')

    await expect(uploadBackup(file, api as never, progress)).resolves.toEqual({ id: 'preview-1' })
    expect(chunks).toEqual([{ offset: 0, bytes: 3 }, { offset: 3, bytes: 3 }, { offset: 6, bytes: 1 }])
    expect(progress).toHaveBeenLastCalledWith(1)
    expect(api.backupUploadCancel).not.toHaveBeenCalled()
  })

  it('rejects an empty file and releases a started upload after cancellation or failure', async () => {
    const api = {
      backupUploadBegin: vi.fn(async () => ({ id: 'upload-2', chunkSize: 2 })),
      backupUploadChunk: vi.fn(async () => { throw new Error('network failed') }),
      backupUploadInspect: vi.fn(),
      backupUploadCancel: vi.fn(async () => {}),
    }
    await expect(uploadBackup(new File([], 'empty.pabackup'), api as never)).rejects.toThrow(/不能为空/)
    expect(api.backupUploadBegin).not.toHaveBeenCalled()

    await expect(uploadBackup(new File(['abc'], 'broken.pabackup'), api as never)).rejects.toThrow('network failed')
    expect(api.backupUploadCancel).toHaveBeenCalledWith('upload-2')
  })
})
