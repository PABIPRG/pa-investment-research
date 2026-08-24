/** Narrow parser for profile selection owned by the Electron main process. */

/**
 * Resolve the unique `--profile <name>` pair in Electron argv.
 * Electron's executable and application-directory arguments, plus unrelated
 * runtime switches, are ignored. Absence preserves the desktop `web` default.
 */
export function resolveElectronProfile(argv: readonly string[] = process.argv): string {
  let profile: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--profile') continue
    if (profile !== undefined) throw new Error('dsh-electron: --profile may be specified only once')
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error('dsh-electron: --profile requires a value')
    }
    if (value === '') throw new Error('dsh-electron: --profile requires a non-empty name')
    profile = value
    index += 1
  }
  return profile ?? 'web'
}
