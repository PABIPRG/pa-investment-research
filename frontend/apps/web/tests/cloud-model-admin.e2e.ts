/** Real cloud administrator entry, model persistence, and HTTPS proxy regression. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:https'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { hashPassword } from '@deepseek-ai/dsh-api-web-auth'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

describe('cloud model administrator', () => {
  it('adds a provider, stores a key and model, and reads them after a host restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cloud-model-uat-'))
    const home = join(root, 'home')
    await mkdir(home)
    const passwordFile = join(root, 'password.hash')
    await writeFile(passwordFile, hashPassword('exclusive-model-uat-password'), { mode: 0o600 })
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=models.localhost'], { stdio: 'ignore' })
    let scaffold: WebScaffold | undefined
    let browser: Browser | undefined
    let page: Page | undefined
    let upstream = 0
    const proxy = createServer({ key: await readFile(join(root, 'key.pem')), cert: await readFile(join(root, 'cert.pem')) }, (req, res) => {
      const call = request({ hostname: '127.0.0.1', port: upstream, path: req.url, method: req.method,
        headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.20' } }, reply => {
        res.writeHead(reply.statusCode ?? 502, reply.headers)
        reply.pipe(res)
      })
      call.on('error', () => { res.writeHead(502); res.end() })
      req.pipe(call)
    })
    proxy.on('upgrade', (req, socket, head) => {
      const call = request({ hostname: '127.0.0.1', port: upstream, path: req.url,
        headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.20' } })
      call.on('upgrade', (reply, remote, remoteHead) => {
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
        if (remoteHead.length) socket.write(remoteHead)
        if (head.length) remote.write(head)
        remote.pipe(socket).pipe(remote)
        socket.on('close', () => remote.destroy())
        remote.on('error', () => socket.destroy())
      })
      call.on('error', () => socket.destroy())
      call.end()
    })
    await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(Number(process.env.CLOUD_MODEL_UAT_PORT ?? 0), '127.0.0.1', resolve) })
    const authority = `models.localhost:${(proxy.address() as AddressInfo).port}`
    const overlay = join(root, 'cloud.yml')
    await writeFile(overlay, JSON.stringify([
      { id: 'deployment-capabilities', config: { surface: 'cloud-web' } },
      { id: 'web-auth', config: { mode: 'required', username: 'admin', passwordHashFile: passwordFile, secureCookies: true, trustedHosts: [authority], trustedProxyAddresses: ['127.0.0.1'] } },
    ]))
    const boot = async () => {
      scaffold = await launchWebScaffold({ harnessHome: home, extraOverlayPath: overlay, webArgs: ['--trusted-host', authority, '--trusted-proxy', '127.0.0.1'] })
      upstream = Number(new URL(scaffold.baseUrl).port)
    }
    const login = async () => {
      await page!.goto(`https://${authority}`)
      await page!.getByLabel('用户名', { exact: true }).fill('admin')
      await page!.getByLabel('密码', { exact: true }).fill('exclusive-model-uat-password')
      await page!.getByRole('button', { name: '登录', exact: true }).click()
      const welcome = page!.getByRole('button', { name: '继续', exact: true })
      await page!.getByRole('button', { name: /^(继续|设置)$/ }).first().waitFor({ timeout: 30_000 })
      if (await welcome.isVisible()) await welcome.click()
      await page!.getByRole('button', { name: '设置', exact: true }).click()
      await page!.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '模型', exact: true }).click()
    }
    try {
      await boot()
      browser = await chromium.launch()
      page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
      const adminRequests: string[] = []
      page.on('response', res => { if (res.status() >= 400) console.log('HTTP failure', res.status(), new URL(res.url()).pathname) })
      page.on('requestfailed', req => console.log('Request failure', new URL(req.url()).pathname, req.failure()?.errorText))
      page.on('pageerror', error => console.log('Page error', error.message))
      page.on('request', req => { if (req.url().includes('/api/modelAdmin.')) adminRequests.push(req.url().split('/api/')[1]!) })
      await page.route('**/api/modelAdmin.describe', async route => {
        await route.fulfill({ status: 403, body: 'forbidden' })
      }, { times: 1 })
      await login()
      await page.getByRole('alert').filter({ hasText: '当前会话无权管理模型配置' }).waitFor()
      await page.getByRole('button', { name: '重试', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '设置' })
      await dialog.getByRole('button', { name: '添加自定义提供方', exact: true }).click()
      await dialog.getByLabel('Provider ID').fill('cloud-uat')
      await dialog.getByLabel('显示名称', { exact: true }).fill('云端验收模型')
      await dialog.getByLabel('API 地址', { exact: true }).fill('https://api.example.com/v1')
      await dialog.getByLabel('API 协议', { exact: true }).selectOption('openai-completions')
      await dialog.getByLabel('API 密钥', { exact: true }).fill('exclusive-cloud-model-test-key')
      await dialog.getByRole('button', { name: '添加模型', exact: true }).click()
      await dialog.getByLabel('模型 ID 1', { exact: true }).fill('cloud-test-model')
      await dialog.getByRole('button', { name: '创建提供方', exact: true }).click()
      await dialog.getByRole('img', { name: 'API 密钥已配置', exact: true }).waitFor()
      expect(adminRequests).toContain('modelAdmin.mutate')
      expect(adminRequests).toContain('modelAdmin.setCredential')
      const settings = await readFile(join(home, 'settings.yaml'), 'utf8')
      expect(settings).toContain('cloud-test-model')
      expect(settings).toContain('CLOUD_UAT_API_KEY')
      expect(settings).not.toContain('exclusive-cloud-model-test-key')
      expect(await page.locator('body').innerText()).not.toContain('exclusive-cloud-model-test-key')
      expect({ providerVisible: await dialog.getByText('云端验收模型', { exact: true }).count() > 0,
        keyConfigured: await dialog.getByRole('img', { name: 'API 密钥已配置', exact: true }).count() > 0,
        modelPersisted: settings.includes('cloud-test-model'), keyValueInSettings: settings.includes('exclusive-cloud-model-test-key'),
      }).toMatchInlineSnapshot(`
        {
          "keyConfigured": true,
          "keyValueInSettings": false,
          "modelPersisted": true,
          "providerVisible": true,
        }
      `)
      for (const width of [1440, 1024, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 })
        await page.screenshot({ path: join(root, `models-${width}.png`), fullPage: true })
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.screenshot({ path: join(root, 'models-dark.png'), fullPage: true })
      await browser.close(); browser = undefined
      await scaffold!.close(); scaffold = undefined
      await boot()
      browser = await chromium.launch()
      page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
      await login()
      const restored = page.getByRole('dialog', { name: '设置' })
      await restored.getByRole('img', { name: 'API 密钥已配置', exact: true }).waitFor()
      expect(await restored.getByText('云端验收模型', { exact: true }).count()).toBeGreaterThan(0)
      await page.screenshot({ path: join(root, 'models-after-restart.png'), fullPage: true })
      console.log(`Cloud model UAT evidence: ${root}`)
    } finally {
      if (page && !page.isClosed()) await page.screenshot({ path: join(root, 'last-state.png'), fullPage: true }).catch(() => {})
      await browser?.close()
      await scaffold?.close()
      proxy.closeAllConnections()
      await new Promise<void>(resolve => proxy.close(() => resolve()))
    }
  }, 180_000)
})
