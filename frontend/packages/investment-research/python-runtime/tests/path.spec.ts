import path, { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { resolveBackendAddress, resolveBackendPaths } from '../src/path.ts'
import type { PythonBackendDefinition } from '../src/types.ts'

function backend(overrides: Partial<PythonBackendDefinition> = {}): PythonBackendDefinition {
  return {
    id: 'trading-core',
    service: 'trading-core',
    mode: 'managed',
    baseUrl: 'http://127.0.0.1:8000',
    repositoryPath: ['backend', 'dsh-trading-core'],
    module: 'adapter.app:app',
    healthPath: '/health',
    healthOk: { status: 'ok' },
    initCommand: { posix: './init.sh', windows: 'init.bat' },
    ...overrides,
  }
}

describe('investment backend path resolution', () => {
  it('discovers the source checkout backend from import.meta.url defaults without reading cwd', () => {
    const expectedProjectDir = path.normalize(fileURLToPath(new URL(
      '../../../../../backend/dsh-trading-core',
      import.meta.url,
    )))
    const cwd = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('cwd must not be read')
    })
    try {
      const resolved = resolveBackendPaths(backend())
      expect(resolved.projectDir).toBe(expectedProjectDir)
      expect(cwd).not.toHaveBeenCalled()
    } finally {
      cwd.mockRestore()
    }
  })

  it.each([
    {
      platform: 'darwin' as const,
      pathApi: posix,
      projectDir: '/Volumes/Research Space/投研/backend/dsh-trading-core',
      pythonExecutable: '/Volumes/Research Space/投研/backend/dsh-trading-core/env/bin/python',
    },
    {
      platform: 'win32' as const,
      pathApi: win32,
      projectDir: 'C:\\Research Space\\投研\\backend\\dsh-trading-core',
      pythonExecutable: 'C:\\Research Space\\投研\\backend\\dsh-trading-core\\env\\Scripts\\python.exe',
    },
  ])('uses the platform venv interpreter without corrupting spaces or Chinese paths on $platform', ({
    platform,
    pathApi,
    projectDir,
    pythonExecutable,
  }) => {
    const resolved = resolveBackendPaths(backend({ projectDir }), {
      packageDir: pathApi.join(projectDir, 'node_modules', '@deepseek-ai', 'dsh-investment-python-runtime', 'lib'),
      pathApi,
      platform,
      isDirectory: candidate => candidate === projectDir,
    })

    expect(resolved).toEqual({ projectDir, pythonExecutable })
  })

  it.each([
    {
      platform: 'linux' as const,
      pathApi: posix,
      packageDir: '/repo with spaces/投研/frontend/node_modules/@deepseek-ai/dsh-investment-python-runtime/lib',
      projectDir: '/repo with spaces/投研/backend/dsh-trading-core',
    },
    {
      platform: 'win32' as const,
      pathApi: win32,
      packageDir: 'D:\\repo with spaces\\投研\\frontend\\node_modules\\@deepseek-ai\\dsh-investment-python-runtime\\lib',
      projectDir: 'D:\\repo with spaces\\投研\\backend\\dsh-trading-core',
    },
  ])('walks upward from the installed package and never consults cwd on $platform', ({
    platform,
    pathApi,
    packageDir,
    projectDir,
  }) => {
    const cwd = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('cwd must not be read')
    })
    try {
      const resolved = resolveBackendPaths(backend(), {
        packageDir,
        pathApi,
        platform,
        isDirectory: candidate => candidate === projectDir,
      })

      expect(resolved.projectDir).toBe(projectDir)
      expect(cwd).not.toHaveBeenCalled()
    } finally {
      cwd.mockRestore()
    }
  })

  it('prefers an explicit projectDir over a discoverable repository backend', () => {
    const explicit = '/explicit/投研 backend'
    const discovered = '/repo/backend/dsh-trading-core'
    const resolved = resolveBackendPaths(backend({ projectDir: explicit }), {
      packageDir: '/repo/frontend/packages/investment-research/python-runtime/lib',
      pathApi: posix,
      platform: 'linux',
      isDirectory: candidate => candidate === explicit || candidate === discovered,
    })

    expect(resolved.projectDir).toBe(explicit)
  })

  it('explains the explicit projectDir recovery when no repository backend is discoverable', () => {
    expect(() => resolveBackendPaths(backend(), {
      packageDir: '/opt/dsh/node_modules/@deepseek-ai/dsh-investment-python-runtime/lib',
      pathApi: posix,
      platform: 'linux',
      isDirectory: () => false,
    })).toThrow(/trading-core.*projectDir/)
  })

  it.each(['relative/backend', '/missing/backend'])('rejects an unusable explicit projectDir without resolving it from cwd: %s', (projectDir) => {
    const cwd = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('cwd must not be read')
    })
    try {
      expect(() => resolveBackendPaths(backend({ projectDir }), {
        packageDir: '/repo/frontend/packages/investment-research/python-runtime/lib',
        pathApi: posix,
        platform: 'linux',
        isDirectory: () => false,
      })).toThrow(/trading-core.*projectDir/)
      expect(cwd).not.toHaveBeenCalled()
    } finally {
      cwd.mockRestore()
    }
  })
})

describe('investment backend address resolution', () => {
  it.each([
    ['http://127.0.0.1:8000', '127.0.0.1', 8000],
    ['http://localhost:8100', 'localhost', 8100],
    ['http://[::1]:8200', '::1', 8200],
  ] as const)('accepts managed loopback HTTP and derives Uvicorn host and port from %s', (baseUrl, host, port) => {
    expect(resolveBackendAddress(backend({ baseUrl }))).toEqual({ baseUrl, host, port })
  })

  it('uses the HTTP default port when a managed loopback URL omits it', () => {
    expect(resolveBackendAddress(backend({ baseUrl: 'http://127.0.0.1' })).port).toBe(80)
  })

  it.each([
    'https://127.0.0.1:8000',
    'http://192.168.1.10:8000',
    'http://research.example:8000',
  ])('rejects a managed backend address that is not loopback HTTP: %s', (baseUrl) => {
    expect(() => resolveBackendAddress(backend({ baseUrl }))).toThrow(/managed.*loopback HTTP/)
  })

  it.each([
    'http://research.internal:8100',
    'https://research.example/api',
  ])('accepts an explicit external HTTP(S) address: %s', (baseUrl) => {
    expect(resolveBackendAddress(backend({ mode: 'external', baseUrl })).baseUrl).toBe(baseUrl)
  })

  it('rejects non-HTTP protocols in external mode', () => {
    expect(() => resolveBackendAddress(backend({ mode: 'external', baseUrl: 'file:///tmp/backend' })))
      .toThrow(/external.*HTTP\(S\)/)
  })

  it('rejects a malformed Base URL with the backend id', () => {
    expect(() => resolveBackendAddress(backend({ baseUrl: 'not a URL' })))
      .toThrow(/trading-core.*Base URL/)
  })
})
