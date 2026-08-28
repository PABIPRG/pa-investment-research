/** Terminal confirmation for switching the single investment product surface. */

import { createInterface } from 'node:readline/promises'
import type {
  InvestmentInstanceConflictDecision,
  InvestmentInstanceOwner,
} from './investment-instance.ts'

function surfaceName(mode: InvestmentInstanceOwner['mode']): string {
  return mode === 'web' ? 'Web 版' : 'Electron 版'
}

/** Ask an interactive CLI user whether the existing product surface may stop. */
export async function confirmInvestmentInstanceReplacement(
  owner: InvestmentInstanceOwner,
): Promise<InvestmentInstanceConflictDecision> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return 'cancel'
  process.stderr.write(
    `\n检测到${surfaceName(owner.mode)}投研正在运行（PID ${String(owner.pid)}）。\n`
    + 'Web 与 Electron 共用投研后台，当前不能同时运行。\n',
  )
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await prompt.question(`是否停止${surfaceName(owner.mode)}并继续启动？[y/N] `)
    return /^(?:y|yes)$/iu.test(answer.trim()) ? 'replace' : 'cancel'
  } finally {
    prompt.close()
  }
}
