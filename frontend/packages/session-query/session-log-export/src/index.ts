/** Web Session-log download command over the host endpoint owned by ApiProxy. */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'

export const name = 'session-log-download'
export const inject = ['commands']

const REQUESTED: CommandResult = {
  kind: 'success',
  text: 'Conversation backup download requested.',
}

/**
 * Register the Web-only `/export` command that the browser download plugin observes.
 * @param ctx - Host context carrying the human-command registry.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.commands.register({
    name: 'export',
    description: 'Export this conversation as a ZIP backup',
    handler: invocation => Promise.resolve(invocation.rawInput.trim() === ''
      ? REQUESTED
      : {
        kind: 'error',
        text: 'Enter /export without a file path. The backup location follows your download settings.',
      }),
  }), 'session-log-download: command')
}
