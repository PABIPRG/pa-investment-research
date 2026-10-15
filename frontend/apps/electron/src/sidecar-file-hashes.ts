import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

/** Hash complete files without buffering whole native libraries in memory. */
export async function hashSidecarFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path, { highWaterMark: 256 * 1024 }), hash)
  return hash.digest('hex')
}

/** Keep four file operations in flight; drain them before propagating any failure. */
export async function mapSidecarFiles<Input, Output>(
  files: readonly Input[],
  action: (file: Input) => Promise<Output>,
): Promise<Output[]> {
  const results: Output[] = []
  const entries = files.entries()
  let failure: Error | undefined
  const worker = async () => {
    while (failure === undefined) {
      const next = entries.next()
      if (next.done) return
      const [index, file] = next.value
      try {
        results[index] = await action(file)
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error('Sidecar file operation failed', { cause: error })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker))
  if (failure !== undefined) throw failure
  return results
}
