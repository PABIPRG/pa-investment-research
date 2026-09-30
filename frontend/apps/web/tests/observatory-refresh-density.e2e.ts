import { createServer, type Server } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { preview, type PreviewServer } from 'vite'
import { afterAll, beforeAll, expect, it } from 'vitest'

const appRoot = fileURLToPath(new URL('../../public-observatory/', import.meta.url))
const evidenceDir = process.env.OBSERVATORY_UAT_DIR ?? '/private/tmp/observatory-feedback-uat'
const points = Array.from({ length: 16 }, (_, i) => ({
  date: `2026-09-${15 + i}`, value: String(28_000 + i * 40), profit_loss: String(i * 40),
}))
const activity = {
  public_id: 'a'.repeat(24), category: 'operation', status: 'completed',
  occurred_at: '2026-09-23T16:23:00+08:00', title: '完成 · 持仓数据更新：科士达 · 002518',
  summary: '持仓资料已保存。数据调整不代表买卖成交；时间为记录时间。',
}
let api: Server
let app: PreviewServer
let browser: Browser
let page: Page
let paused = new Set<string>()
let failLive = false
const pending: Array<{ path: string; send: () => void }> = []
const release = (part?: string) => {
  if (part) paused.delete(part)
  else paused.clear()
  for (const request of [...pending]) {
    if (part && request.path !== part) continue
    pending.splice(pending.indexOf(request), 1)
    request.send()
  }
}
const geometry = async () => page.locator('main > div, main > section').evaluateAll(nodes => nodes.map((node) => {
  const box = node.getBoundingClientRect()
  return { y: Math.round(box.y + scrollY), height: Math.round(box.height) }
}))

beforeAll(async () => {
  await readFile(join(appRoot, 'dist/index.html'))
  await mkdir(evidenceDir, { recursive: true })
  api = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1:3399')
    const path = url.pathname.split('/').at(-1)!
    const date = url.searchParams.get('date') ?? '2026-09-30'
    const body = path === 'live' ? {
      availability: 'available', date, currency: 'CNY', source: 'current_holdings', holdings_as_of: date,
      summary: { holdings_cost: '41166.24', market_value: '28691.20', floating_profit_loss: '-12475.04', cost_return: '-0.303', cash: null, initial_capital: null, total_equity: null },
      items: [
        { ticker: '002518', name: '科士达', quantity: '100', cost_price: '36.712', market_price: '34.44', market_value: '3444.00', profit_loss: '-227.20', return_rate: '-0.062' },
        { ticker: '513050', name: '中概互联网ETF易方达长中文名称展示检查', quantity: '6800', cost_price: '1.09', market_price: '1.003', market_value: '6820.40', profit_loss: '-578.80', return_rate: '-0.078' },
      ], freshness: { stale: false, message: null },
    } : path === 'history' ? {
      from: url.searchParams.get('from'), to: url.searchParams.get('to'), currency: 'CNY', quality: 'estimated',
      available_since: '2026-09-15', limitations: ['历史表现为估算，不含现金。'],
      points: points.filter(row => row.date >= url.searchParams.get('from')! && row.date <= url.searchParams.get('to')!),
    } : path === 'calendar' ? {
      days: Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, trading_status: [0, 6].includes(new Date(2026, 8, i + 1).getDay()) ? 'closed' : 'unknown' })),
    } : path === 'activities' ? { as_of: '2026-09-30', items: [activity], next_cursor: null } : {
      ...activity, related_snapshot_id: null,
      holdings_changes: [{ ticker: '002518', name: '科士达', before_quantity: '200', after_quantity: '100', before_cost_price: '36.712', after_cost_price: '36.712' }],
    }
    const send = () => {
      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('content-type', 'application/json')
      if (path === 'live' && failLive) res.statusCode = 503
      res.end(JSON.stringify(body))
    }
    if (paused.has(path)) pending.push({ path, send })
    else send()
  })
  await new Promise<void>(resolve => api.listen(3399, '127.0.0.1', resolve))
  app = await preview({ root: appRoot, preview: { host: '127.0.0.1', port: 3398, strictPort: true } })
  browser = await chromium.launch()
  page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1024, height: 879 }, reducedMotion: 'reduce' })
  await page.clock.install({ time: new Date('2026-09-30T06:00:00Z') })
  await page.goto('http://127.0.0.1:3398')
  await page.getByRole('button', { name: activity.title }).waitFor()
  await page.waitForFunction(() => document.querySelectorAll('[data-refresh-indicator][data-loading="true"]').length === 0)
})
afterAll(async () => {
  release()
  await browser?.close()
  if (app) await new Promise<void>(resolve => app.httpServer.close(() => resolve()))
  if (api) await new Promise<void>(resolve => api.close(() => resolve()))
})

it('retains named activities and unknown-calendar estimates in the built page and its detail', async () => {
  expect(await page.getByRole('button', { name: activity.title }).count()).toBe(1)
  expect(await page.getByRole('button', { name: activity.title }).innerText()).toMatchInlineSnapshot(`
    "操作 · 记录于 09/23 16:23
    完成 · 持仓数据更新：科士达 · 002518"
  `)
  const estimate = page.getByRole('button', { name: /2026-09-16，交易日待确认，估算盈亏/ })
  expect(await estimate.isEnabled()).toBe(true)
  expect(await estimate.innerText()).toContain('40.00')
  await page.getByRole('button', { name: '展开操作记录' }).click()
  expect(await page.getByRole('dialog').innerText()).toContain('科士达 · 002518')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: activity.title }).click()
  const dialog = page.getByRole('dialog')
  expect(await dialog.innerText()).toContain('科士达')
  expect(await dialog.locator('tbody').innerText()).toContain('002518')
  await page.screenshot({ path: join(evidenceDir, 'detail-1024.png') })
  await page.keyboard.press('Escape')
  await expect.poll(() => page.getByRole('button', { name: activity.title }).evaluate(node => node === document.activeElement)).toBe(true)
  await estimate.click()
  await page.getByText('持仓记录于 2026-09-16').waitFor()
  expect(await page.getByRole('checkbox').isDisabled()).toBe(true)
  await page.getByRole('button', { name: '当日', exact: true }).click()
  await page.getByText('持仓记录于 2026-09-30').waitFor()
  await page.waitForFunction(() => document.querySelectorAll('[data-refresh-indicator][data-loading="true"]').length === 0)
})

it('uses independent title icons without moving modules during automatic refresh, and recovers from failure', async () => {
  const before = await geometry()
  paused = new Set(['live', 'history', 'calendar', 'activities'])
  await page.clock.runFor(15_000)
  await page.waitForFunction(() => document.querySelectorAll('[data-refresh-indicator][data-loading="true"]').length === 5)
  expect(await geometry()).toEqual(before)
  expect(await page.locator('main').innerText()).not.toContain('正在刷新')
  await page.screenshot({ path: join(evidenceDir, 'refresh-1024.png'), fullPage: true })
  release('live')
  await page.waitForFunction(() => document.querySelectorAll('[data-refresh-indicator][data-loading="true"]').length === 3)
  expect(await geometry()).toEqual(before)
  release('activities')
  await page.waitForFunction(() => document.querySelectorAll('[data-refresh-indicator][data-loading="true"]').length === 2)
  release('history')
  await page.waitForFunction(() => document.querySelector('[data-refresh-indicator="历史表现"]')?.getAttribute('data-loading') === 'false')
  expect(await page.locator('[data-refresh-indicator="日历"]').getAttribute('data-loading')).toBe('true')
  release()
  await page.waitForFunction(() => document.querySelectorAll('[data-refresh-indicator][data-loading="true"]').length === 0)
  expect(await geometry()).toEqual(before)
  failLive = true
  await page.getByRole('button', { name: '刷新数据' }).click()
  await page.getByText('持仓刷新失败，当前显示上次结果，可能已过期。').waitFor()
  expect(await page.getByRole('region', { name: '持仓概览' }).innerText()).toContain('28,691.20')
  failLive = false
  await page.getByRole('button', { name: '重试持仓' }).click()
  await page.getByText('持仓刷新失败，当前显示上次结果，可能已过期。').waitFor({ state: 'hidden' })
  await writeFile(join(evidenceDir, 'geometry.json'), JSON.stringify({ before, after: await geometry(), shift: 0 }, null, 2))
})

it('keeps long names, values and controls usable at all supported sizes and themes', async () => {
  await page.getByRole('checkbox', { name: '每 15 秒自动刷新' }).uncheck()
  const sizes = []
  for (const theme of ['light', 'dark'] as const) {
    if (theme === 'dark') await page.getByRole('button', { name: '深色', exact: true }).click()
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 879 })
      await page.screenshot({ path: join(evidenceDir, `${theme}-${width}.png`), fullPage: true })
      if (width === 1024) await page.screenshot({ path: join(evidenceDir, `${theme}-1024-viewport.png`) })
      const bounds = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
      expect(bounds.document).toBeLessThanOrEqual(bounds.viewport)
      expect(await page.getByRole('button', { name: '展开操作记录' }).isVisible()).toBe(true)
      sizes.push({ theme, width, ...bounds })
    }
  }
  await page.setViewportSize({ width: 1024, height: 879 })
  await page.evaluate(() => { document.documentElement.style.zoom = '1.25' })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const zoomBounds = await page.evaluate(() => ({
    width: innerWidth, scroll: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll('main *, header *, section *')].filter(node => node.getBoundingClientRect().right > innerWidth).map(node => ({ tag: node.tagName, className: node.className, text: node.textContent?.slice(0, 90), right: node.getBoundingClientRect().right })),
  }))
  await writeFile(join(evidenceDir, 'zoom.json'), JSON.stringify(zoomBounds, null, 2))
  await page.screenshot({ path: join(evidenceDir, 'zoom-1024.png') })
  expect(zoomBounds.scroll).toBeLessThanOrEqual(zoomBounds.width)
  await writeFile(join(evidenceDir, 'viewports.json'), JSON.stringify(sizes, null, 2))
})
