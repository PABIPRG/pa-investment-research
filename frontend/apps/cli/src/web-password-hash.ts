import { hashPassword } from '@deepseek-ai/dsh-api-web-auth'

const MAX_PASSWORD_BYTES = 4_096

/** Read a bounded password from stdin and emit only its versioned hash. */
export async function runWebPasswordHash(): Promise<number> {
  if (process.stdin.isTTY) {
    process.stderr.write('请通过标准输入提供密码，避免密码出现在命令行参数中。\n')
    return 1
  }
  const chunks: Uint8Array[] = []; let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_PASSWORD_BYTES) {
      process.stderr.write('密码输入过长。\n')
      return 1
    }
    chunks.push(new Uint8Array(bytes))
  }
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  if (password.length === 0) {
    process.stderr.write('密码不能为空。\n')
    return 1
  }
  try {
    process.stdout.write(`${hashPassword(password)}\n`)
    return 0
  } catch {
    process.stderr.write('密码至少需要 12 个字符。\n')
    return 1
  }
}
