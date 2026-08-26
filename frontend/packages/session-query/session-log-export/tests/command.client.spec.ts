import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import * as SessionLogDownload from '../src/index.ts'

describe('/export Web download command', () => {
  it('registers one pathless command and removes it with the plugin fiber', async () => {
    let descriptor: CommandDefinition | undefined
    const ctx = new Context()
    ctx.provide('commands', {
      register(next: CommandDefinition) {
        descriptor = next
        return () => { descriptor = undefined }
      },
    } as never)
    const fiber = await ctx.plugin(SessionLogDownload)

    expect(descriptor).toMatchObject({
      name: 'export',
      description: 'Export this conversation as a ZIP backup',
    })
    const invoke = (rawInput: string) => descriptor?.handler({ rawInput } as CommandInvocation)
    await expect(invoke('')).resolves.toEqual({
      kind: 'success', text: 'Conversation backup download requested.',
    })
    await expect(invoke(' output.zip')).resolves.toEqual({
      kind: 'error',
      text: 'Enter /export without a file path. The backup location follows your download settings.',
    })

    await fiber.dispose()
    expect(descriptor).toBeUndefined()
  })
})
