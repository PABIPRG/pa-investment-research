/** Identify the Electron provider across separately deployed module copies. */
import type { ElectronConnectionService } from './index.ts'

export function isElectronConnectionService(value: unknown): value is ElectronConnectionService {
  if (typeof value !== 'object' || value === null) return false
  return 'transport' in value && value.transport === 'electron'
    && 'owns' in value && typeof value.owns === 'function'
    && 'fetch' in value && typeof value.fetch === 'function'
    && 'openStream' in value && typeof value.openStream === 'function'
}
