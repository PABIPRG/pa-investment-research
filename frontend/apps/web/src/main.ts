/**
 * Web application entry: thin bootstrap over the shell library. Everything —
 * loader holding, module-table seeding, AppRoot gate, plugin assembly — lives
 * in @deepseek-ai/dsh-client-web; this file only finds the mount point.
 */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import { bootstrapWebAuth } from './web-auth.tsx'

const el = document.getElementById('root')
if (el === null) throw new Error('web app: missing #root')
const run = async () => { await new AppWebEntry(el).run() }
const electron = (globalThis as typeof globalThis & { __DSH_ELECTRON__?: unknown }).__DSH_ELECTRON__
void (electron === undefined ? bootstrapWebAuth(el, run) : run())
