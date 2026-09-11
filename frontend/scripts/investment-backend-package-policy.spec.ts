import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { backendPathAllowed, scanPackagedBackends } from './investment-backend-package-policy.ts'

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
