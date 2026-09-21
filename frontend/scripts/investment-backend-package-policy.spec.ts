import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { backendPathAllowed, prunePythonDependencyTests, scanPackagedBackends } from './investment-backend-package-policy.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pab-package-policy-'))
  roots.push(root)
  for (const [backend, module] of [['dsh-trading-core', 'adapter'], ['market-watch', 'market_watch'], ['industry-chain', 'industry_chain']]) {
    await mkdir(join(root, 'backends', backend!, module!), { recursive: true })
    await writeFile(join(root, 'backends', backend!, module!, 'app.py'), 'import os\nkey = os.getenv("API_KEY", "")\n')
  }
  return root
}
it('allows runtime modules and licenses, excluding developer and local files at every depth', () => {
  expect(backendPathAllowed('dsh-trading-core', 'adapter/app.py', false)).toBe(true)
  expect(backendPathAllowed('dsh-trading-core', 'tradingagents/config/config_manager.py', false)).toBe(true)
  expect(backendPathAllowed('dsh-trading-core', 'LICENSE', false)).toBe(true)
  for (const path of ['docs/guide.MD', 'config/models.json', '.env.production', 'adapter/.env.local', 'adapter/key.pem', 'adapter/holdings.pabackup', 'adapter/app.py.bak', 'adapter/tests/test_app.py', 'adapter/__pycache__/app.pyc', 'adapter/private.json', 'adapter/data/private.py', 'tradingagents/dataflows/data_cache/local.py']) {
    expect(backendPathAllowed('dsh-trading-core', path, false), path).toBe(false)
  }
})
it('accepts a clean payload', async () => { await expect(scanPackagedBackends(await fixture())).resolves.toBeUndefined() })
it.each([
  ['personal-home', '# /Users/private-user/project'],
  ['personal-home', '# /Users/张三/project'],
  ['personal-home', 'path = "/Users/private-user"'],
  ['credential-literal', 'api_key = "abc"'],
  ['personal-home', '# C:\\Users\\private-user\\project'],
  ['personal-home', '# /home/private-user/project'],
  ['private-key', '-----BEGIN RSA PRIVATE KEY-----'],
  ['credential-token', `key = "sk-${'x'.repeat(32)}"`],
  ['credential-literal', 'api_key = "private-canary-123"'],
])('rejects %s without revealing matched content', async (rule, content) => {
  const root = await fixture()
  await writeFile(join(root, 'backends/dsh-trading-core/adapter/app.py'), content)
  const error = await scanPackagedBackends(root).catch(value => value as Error)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain(rule)
  expect((error as Error).message).not.toContain(content)
  expect((error as Error).message).not.toContain('private-canary')
})
it('rejects an extra file even when it was added after building', async () => {
  const root = await fixture()
  await writeFile(join(root, 'backends/dsh-trading-core/adapter/.env.production'), 'PRIVATE')
  await expect(scanPackagedBackends(root)).rejects.toThrow(/unexpected-file/)
})
it('rejects symbolic links without reading their targets', async () => {
  const root = await fixture()
  await symlink(root, join(root, 'backends/dsh-trading-core/adapter/link'), 'junction')
  await expect(scanPackagedBackends(root)).rejects.toThrow(/symbolic-link/)
})

async function dependencyFixture() {
  const root = await fixture()
  await mkdir(join(root, 'py_vapid/tests'), { recursive: true })
  await mkdir(join(root, 'py_vapid-1.9.4.dist-info'))
  await writeFile(join(root, 'py_vapid-1.9.4.dist-info/METADATA'), 'Name: py-vapid\nVersion: 1.9.4\n')
  await writeFile(join(root, 'py_vapid/__init__.py'), 'runtime module')
  await writeFile(join(root, 'py_vapid/tests/test_vapid.py'), 'inert fixture')
  await writeFile(join(root, 'py_vapid/tests/.test_vapid.py.swp'), 'inert fixture')
  return root
}
it('removes only reviewed dependency tests, preserving runtime modules and distribution metadata', async () => {
  const root = await dependencyFixture()
  const paths: string[] = []
  await prunePythonDependencyTests(root, async path => {
    paths.push(path)
    return path.endsWith('.swp')
      ? '178ec9b7bce4f39fcfbf8eb04207abaa8ec3b891eb1def7d75dd81e93c5c092d'
      : '460d5b05d85452117db2046ec1c0dc25dd3018b4df7fb1e6c8e0627c6b413897'
  })
  expect(paths).toHaveLength(2)
  expect(await readdir(join(root, 'py_vapid'))).toEqual(['__init__.py'])
  expect(await readFile(join(root, 'py_vapid/__init__.py'), 'utf8')).toBe('runtime module')
  expect(await readFile(join(root, 'py_vapid-1.9.4.dist-info/METADATA'), 'utf8')).toContain('Version: 1.9.4')
})
it('blocks changed test content and unexpected files instead of deleting unreviewed payloads', async () => {
  const root = await dependencyFixture()
  await expect(prunePythonDependencyTests(root)).rejects.toThrow(/unreviewed py-vapid/)
  await writeFile(join(root, 'py_vapid/tests/new.py'), 'keep me')
  await expect(prunePythonDependencyTests(root)).rejects.toThrow(/unreviewed py-vapid/)
  expect(await readFile(join(root, 'py_vapid/tests/new.py'), 'utf8')).toBe('keep me')
})
it('does not follow a symlink during dependency test cleanup', async () => {
  const root = await dependencyFixture()
  await rm(join(root, 'py_vapid/tests/test_vapid.py'))
  await symlink(join(root, 'py_vapid/__init__.py'), join(root, 'py_vapid/tests/test_vapid.py'))
  await expect(prunePythonDependencyTests(root)).rejects.toThrow(/unreviewed py-vapid/)
  expect(await readFile(join(root, 'py_vapid/__init__.py'), 'utf8')).toBe('runtime module')
})
