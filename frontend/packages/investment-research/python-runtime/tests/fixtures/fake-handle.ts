import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputReader,
} from '@deepseek-ai/dsh-subprocess'

function reader(chunks: string[]): SubprocessOutputReader {
  return {
    readFrom(fromByte) {
      const text = chunks.join('')
      return { text: text.slice(fromByte), nextOffset: text.length, lossy: false }
    },
  }
}

export interface FakeHandle extends SubprocessHandle {
  readonly stdoutChunks: string[]
  readonly stderrChunks: string[]
  readonly terminateCalls: number
  autoExitOnTerminate: boolean
  exit(outcome?: SubprocessOutcome): void
  fail(error: unknown): void
}

export function fakeHandle(pid = 101): FakeHandle {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const settled = Promise.withResolvers<SubprocessOutcome>()
  let terminateCalls = 0
  let exited = false
  return {
    pid,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: reader(stdoutChunks), stderr: reader(stderrChunks) },
    done: settled.promise,
    get terminateCalls() { return terminateCalls },
    stdoutChunks,
    stderrChunks,
    autoExitOnTerminate: false,
    terminate() {
      terminateCalls += 1
      if (this.autoExitOnTerminate) this.exit({ exitCode: null, signal: 'SIGTERM' })
    },
    async waitForExit() {
      await settled.promise
      return true
    },
    exit(outcome = { exitCode: 0, signal: null }) {
      if (exited) return
      exited = true
      settled.resolve(outcome)
    },
    fail(error) {
      if (exited) return
      exited = true
      settled.reject(error)
    },
  }
}
