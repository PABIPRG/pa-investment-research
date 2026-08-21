import { statSync } from 'node:fs'
import path, { dirname } from 'node:path'
import type { PlatformPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  PythonBackendDefinition,
  ResolvedBackendAddress,
  ResolvedBackendPaths,
} from './types.ts'

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/** Injectable filesystem and platform facts used by cross-platform path tests. */
export interface BackendPathResolutionOptions {
  /** Directory containing the installed runtime module. */
  readonly packageDir?: string
  /** Target process platform. */
  readonly platform?: NodeJS.Platform
  /** Node path implementation matching the target platform. */
  readonly pathApi?: PlatformPath
  /** Return whether a candidate is an existing directory. */
  readonly isDirectory?: (candidate: string) => boolean
}

function directoryExists(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

function resolutionError(definition: PythonBackendDefinition): Error {
  return new Error(
    `investment Python backend "${definition.id}": cannot resolve projectDir; configure an explicit absolute projectDir for ${definition.repositoryPath.join('/')}`,
  )
}

/**
 * Resolve a backend without reading the caller's current working directory.
 * @param definition - registered backend definition.
 * @param options - injected package, platform, path, and filesystem facts.
 * @returns absolute backend directory and venv interpreter.
 */
export function resolveBackendPaths(
  definition: PythonBackendDefinition,
  options: BackendPathResolutionOptions = {},
): ResolvedBackendPaths {
  const platform = options.platform ?? process.platform
  const pathApi = options.pathApi ?? path
  const isDirectory = options.isDirectory ?? directoryExists

  let projectDir: string | undefined
  if (definition.projectDir !== undefined) {
    if (!pathApi.isAbsolute(definition.projectDir) || !isDirectory(definition.projectDir)) {
      throw resolutionError(definition)
    }
    projectDir = pathApi.normalize(definition.projectDir)
  } else {
    let cursor = options.packageDir ?? PACKAGE_DIR
    while (true) {
      const candidate = pathApi.join(cursor, ...definition.repositoryPath)
      if (isDirectory(candidate)) {
        projectDir = candidate
        break
      }
      const parent = pathApi.dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
  }

  if (projectDir === undefined) throw resolutionError(definition)
  const pythonExecutable = platform === 'win32'
    ? pathApi.join(projectDir, 'env', 'Scripts', 'python.exe')
    : pathApi.join(projectDir, 'env', 'bin', 'python')
  return { projectDir, pythonExecutable }
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

/**
 * Validate a backend URL and derive managed Uvicorn bind arguments.
 * @param definition - registered backend definition.
 * @returns validated URL, host, and port.
 */
export function resolveBackendAddress(definition: PythonBackendDefinition): ResolvedBackendAddress {
  let url: URL
  try {
    url = new URL(definition.baseUrl)
  } catch (cause) {
    throw new Error(`investment Python backend "${definition.id}": invalid Base URL`, { cause })
  }

  const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
  if (definition.mode === 'managed') {
    if (url.protocol !== 'http:' || !isLoopbackHost(host)) {
      throw new Error(`investment Python backend "${definition.id}": managed mode requires loopback HTTP`)
    }
  } else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`investment Python backend "${definition.id}": external mode requires HTTP(S)`)
  }

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  return { baseUrl: definition.baseUrl, host, port }
}
