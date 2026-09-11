/**
 * The web app's command-line provider: it parses the `dsh --profile web` flag
 * family (`--host`, `--port`, `--trusted-host`, `--trusted-proxy`) and its `--help`
 * text, then provides the immutable values as {@link WEB_STARTUP_SERVICE}.
 * Ordinary rows inject that service before reading it from lazy config.
 * @module @deepseek-ai/dsh-web-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

/** Stable Cordis plugin name. */
export const name = 'web-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
  /** `--host`, absent when the invocation did not name one. */
  host?: string
  /** `--port`, absent when the invocation did not name one. */
  port?: number
  /** Explicit `--trusted-host` authorities, in argument order. */
  trustedHosts: string[]
  /** Exact reverse-proxy socket addresses whose forwarding headers are accepted. */
  trustedProxyAddresses: string[]
  /** Whether the Web transport must authenticate one configured administrator. */
  authMode: 'disabled' | 'required'
  /** Administrator identifier, never a secret. */
  authUsername?: string
  /** Path to the protected versioned password-hash file. */
  authPasswordHashFile?: string
  /** Secure cookie policy; false is an explicit loopback-only development concession. */
  secureCookies: boolean
}

/** The web flag family, as commander parsed it. */
interface WebOptions {
  host?: string
  port?: string
  trustedHost?: string[]
  trustedProxy?: string[]
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .option('--trusted-proxy <address...>', 'exact reverse-proxy IP allowed to supply forwarding headers (repeatable)')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --port 8080              serve on another port
`)
}

/**
 * Parse and provide the Web invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named. An incomplete
 * non-loopback security boundary or a non-numeric `--port` is a usage error;
 * on rejection (and on `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = webCommand()
  program.action(() => {
    const options = program.opts<WebOptions>()
    const environment = launchEnvironmentOf(ctx)
    const authRaw = environment.get('DSH_WEB_AUTH')?.value
    if (authRaw !== undefined && authRaw !== '' && authRaw !== 'disabled' && authRaw !== 'required') {
      program.error(`error: DSH_WEB_AUTH must be disabled or required, got ${JSON.stringify(authRaw)}`)
    }
    const authMode = authRaw === 'required' ? 'required' : 'disabled'
    const authUsername = environment.get('DSH_WEB_ADMIN_USERNAME')?.value
    const authPasswordHashFile = environment.get('DSH_WEB_ADMIN_PASSWORD_HASH_FILE')?.value
    if (options.host === '0.0.0.0'
      && (authMode !== 'required' || authUsername === undefined || authUsername === ''
        || authPasswordHashFile === undefined || authPasswordHashFile === ''
        || options.trustedHost?.length === 0 || options.trustedHost === undefined
        || options.trustedProxy?.length === 0 || options.trustedProxy === undefined)) {
      program.error('error: --host 0.0.0.0 requires required authentication, --trusted-host, and --trusted-proxy')
    }
    if (options.host === '0.0.0.0' && environment.get('DSH_WEB_INSECURE_COOKIES')?.value === '1') {
      program.error('error: DSH_WEB_INSECURE_COOKIES=1 is allowed only with the loopback Web server')
    }
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    ctx.provide(WEB_STARTUP_SERVICE, {
      ...options.host !== undefined && { host: options.host },
      ...options.port !== undefined && { port: Number(options.port) },
      trustedHosts: options.trustedHost ?? [],
      trustedProxyAddresses: options.trustedProxy ?? [],
      authMode,
      ...authUsername !== undefined && { authUsername },
      ...authPasswordHashFile !== undefined && { authPasswordHashFile },
      secureCookies: environment.get('DSH_WEB_INSECURE_COOKIES')?.value !== '1',
    } satisfies WebStartupValues)
  })
  parseCmdline(ctx, program)
}
