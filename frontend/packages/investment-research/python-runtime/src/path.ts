import { statSync } from 'node:fs'
import path, { dirname } from 'node:path'
import type { PlatformPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyInvestmentRuntimeDescriptor } from './descriptor.ts'
import type { VerifiedInvestmentRuntime } from './descriptor.ts'
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
  /** Target process architecture. */
  readonly arch?: string
  /** Node path implementation matching the target platform. */
  readonly pathApi?: PlatformPath
  /** Harness home used for bundled backend writable state. */
  readonly dshHome?: string
  /** Return whether a candidate is an existing directory. */
  readonly isDirectory?: (candidate: string) => boolean
  /** Return whether a candidate is an existing regular file. */
  readonly isFile?: (candidate: string) => boolean
  /** Parse and verify one discovered sidecar descriptor. */
  readonly verifyDescriptor?: (descriptorPath: string) => VerifiedInvestmentRuntime
}

function directoryExists(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

function fileExists(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function resolutionError(definition: PythonBackendDefinition): Error {
  return new Error(
    `investment Python backend "${definition.id}": local Runtime is missing; configure a valid absolute projectDir or initialize ${definition.repositoryPath.join('/')}`,
  )
}

function sourceInterpreter(projectDir: string, platform: NodeJS.Platform, pathApi: PlatformPath): string {
  return platform === 'win32'
    ? pathApi.join(projectDir, 'env', 'Scripts', 'python.exe')
    : pathApi.join(projectDir, 'env', 'bin', 'python')
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
  const arch = options.arch ?? process.arch
  const pathApi = options.pathApi ?? path
  const isDirectory = options.isDirectory ?? directoryExists
  const isFile = options.isFile ?? fileExists
  const verifyDescriptor = options.verifyDescriptor ?? (descriptorPath => verifyInvestmentRuntimeDescriptor(descriptorPath, {
    platform,
    arch,
    pathApi,
  }))

  if (definition.projectDir !== undefined) {
    if (!pathApi.isAbsolute(definition.projectDir) || !isDirectory(definition.projectDir)) {
      throw resolutionError(definition)
    }
    const projectDir = pathApi.normalize(definition.projectDir)
    const pythonExecutable = sourceInterpreter(projectDir, platform, pathApi)
    if (!isFile(pythonExecutable)) throw resolutionError(definition)
    return { source: 'source', projectDir, pythonExecutable }
  }

  const packageDir = options.packageDir ?? PACKAGE_DIR
  let cursor = packageDir
  while (true) {
    const projectDir = pathApi.join(cursor, ...definition.repositoryPath)
    const pythonExecutable = sourceInterpreter(projectDir, platform, pathApi)
    if (isDirectory(projectDir) && isFile(pythonExecutable)) {
      return { source: 'source', projectDir, pythonExecutable }
    }
    const parent = pathApi.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }

  cursor = packageDir
  while (true) {
    const descriptorPath = pathApi.join(cursor, 'investment-python', 'runtime.json')
    if (isFile(descriptorPath)) {
      if (options.dshHome === undefined || !pathApi.isAbsolute(options.dshHome)) {
        throw new Error(`investment Python backend "${definition.id}": bundled Runtime requires an absolute dshHome`)
      }
      const bundled = verifyDescriptor(descriptorPath)
      const descriptorBackend = bundled.descriptor.backends[definition.id]
      if (descriptorBackend.module !== definition.module) {
        throw new Error(`investment Python packaged runtime is invalid (${definition.id} module); reinstall the application`)
      }
      return {
        source: 'bundled',
        projectDir: bundled.projectDirs[definition.id],
        pythonExecutable: bundled.pythonExecutable,
        sitePackages: bundled.sitePackages,
        stateDir: pathApi.join(options.dshHome, 'investment-research', definition.id),
      }
    }
    const parent = pathApi.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }

  throw resolutionError(definition)
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
