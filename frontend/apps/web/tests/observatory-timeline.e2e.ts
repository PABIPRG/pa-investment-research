import { createServer, type Server } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { preview, type PreviewServer } from 'vite'
import { afterAll, beforeAll, expect, it } from 'vitest'

const appRoot = fileURLToPath(new URL('../../public-observatory/', import.meta.url))
const evidenceDir = join(process.env.OBSERVATORY_UAT_DIR ?? '/private/tmp/observatory-feedback-uat', 'timeline')
const appPort = Number(process.env.OBSERVATORY_UAT_PORT ?? 3398)
const apiPort = Number(process.env.OBSERVATORY_UAT_API_PORT ?? 3399)
const origin = `http://127.0.0.1:${appPort}`
const apiOrigin = `http://127.0.0.1:${apiPort}`
const dates = ['15', '16', '17', '18', '21', '22', '23', '24', '28', '29', '30'].map(day => `2026-09-${day}`)
const points = dates.map((date, i) => ({ date, value: String(28620 + i * 120), profit_loss: String(i * (i % 2 ? -40 : 50)) }))
const limitations = ['金额加权收益率根据持仓变更日市场价值推算，不含现金、分红和费用。', '所选开始日期早于可用历史，已从 2026-09-15 计算。']
let api: Server
let app: PreviewServer
let browser: Browser
let page: Page
let failHistory = false
let dataMode: 'full' | 'empty' | 'single' = 'full'
const requests: string[] = []
const errors: string[] = []
const settled = async () => { await page.waitForFunction(() => document.querySelectorAll('[data-refresh-indicator][data-loading="true"]').length === 0) }
const seek = () => page.getByRole('slider', { name: '跳转历史播放日期' })

beforeAll(async () => {
  await mkdir(evidenceDir, { recursive: true })
  api = createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin)
    if (!url.pathname.startsWith('/api/public/performance/v1/')) { res.writeHead(404).end(); return }
    requests.push(url.pathname + url.search)
    const path = url.pathname.split('/').at(-1)
    const date = url.searchParams.get('date') ?? '2026-10-03'
    const month = url.searchParams.get('month') ?? '2026-09'
    const selected = dataMode === 'empty' ? [] : dataMode === 'single' ? points.slice(0, 1) : points
    const body = path === 'live' ? {
      availability: 'available', date, currency: 'CNY', source: date === '2026-10-03' ? 'current_holdings' : 'recorded_holdings', holdings_as_of: date,
      summary: { holdings_cost: '41166.24', market_value: '28620.80', floating_profit_loss: '-12545.44', cost_return: '-0.3048', cash: null, initial_capital: null, total_equity: null },
      items: [{ ticker: '513050', name: '中概互联网ETF易方达长中文证券名称检查', quantity: '6800', cost_price: '1.09', market_price: '1.006', market_value: '6840.80', profit_loss: '-37.40', return_rate: '-0.005' }],
      freshness: { stale: false, message: null },
    } : path === 'history' ? {
      from: url.searchParams.get('from'), to: url.searchParams.get('to'), currency: 'CNY', quality: 'estimated', available_since: '2026-09-15', limitations,
      points: selected.filter(point => point.date >= url.searchParams.get('from')! && point.date <= url.searchParams.get('to')!),
    } : path === 'calendar' ? {
      days: Array.from({ length: month.endsWith('09') ? 30 : 31 }, (_, i) => {
        const day = `${month}-${String(i + 1).padStart(2, '0')}`
        return { date: day, trading_status: [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay()) ? 'closed' : i === 24 ? 'unknown' : 'trading' }
      }),
    } : { as_of: date, items: [], next_cursor: null }
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('content-type', 'application/json')
    if (path === 'history' && failHistory) res.statusCode = 503
    res.end(JSON.stringify(body))
  })
  await new Promise<void>(resolve => api.listen(apiPort, '127.0.0.1', resolve))
  app = await preview({ root: appRoot, preview: { host: '127.0.0.1', port: appPort, strictPort: true } })
  browser = await chromium.launch()
  page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1024, height: 879 }, reducedMotion: 'reduce', colorScheme: 'light' })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => [origin, apiOrigin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort())
  await page.clock.install({ time: new Date('2026-10-03T06:00:00Z') })
  await page.goto(origin)
  await settled()
})
afterAll(async () => {
  await writeFile(join(evidenceDir, 'requests.json'), JSON.stringify(requests, null, 2))
  await browser?.close()
  if (api) await new Promise<void>(resolve => api.close(() => { resolve() }))
  if (app) await new Promise<void>(resolve => app.httpServer.close(() => { resolve() }))
})

it('starts at the first index and plays the full interval with synchronized details and stable T+1 reads', async () => {
  expect(await page.getByRole('button', { name: '2026-10-05，交易日，无历史估值', exact: true }).innerText()).toContain('未到')
  await page.getByRole('button', { name: '第一天', exact: true }).click()
  await page.getByText('持仓记录于 2026-09-15').waitFor()
  await settled()
  expect(await seek().getAttribute('max')).toBe('10')
  expect(await seek().inputValue()).toBe('0')
  const dailyRequests = () => requests.filter(path => /\/(history|calendar)\?/.test(path))
  const before = dailyRequests().length
  expect(dailyRequests().some(path => path.includes('from=2026-07-05&to=2026-10-02'))).toBe(true)
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await page.clock.runFor(1_200)
  expect(await seek().getAttribute('aria-valuetext')).toBe('2026-09-16')
  expect(await page.getByRole('button', { name: /选择日期/ }).innerText()).toContain('2026.09.16')
  await page.getByText('持仓记录于 2026-09-16').waitFor()
  await settled()
  expect(requests.some(path => path.includes('/live?date=2026-09-16'))).toBe(true)
  expect(requests.some(path => path.includes('/activities?as_of=2026-09-16'))).toBe(true)
  expect(dailyRequests().length).toBe(before)
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByText('持仓记录于 2026-09-16').waitFor()
  await settled()
  expect(await seek().getAttribute('max')).toBe('10')
  expect(await page.getByRole('region', { name: '全局时间切片' }).innerText()).toMatchInlineSnapshot(`
    "第一天
    ←
    选择日期
    2026.09.16
    →
    当日
    播放
    历史日期 · 自动刷新暂停
    刷新数据
    2026.09.16 · 持仓估值 ¥28,740.00
    2 / 11"
  `)
})

it('seeks with the keyboard, resumes, completes and replays from the first estimate', async () => {
  await seek().focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await settled()
  expect(await seek().getAttribute('aria-valuetext')).toBe('2026-09-16')
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await page.clock.runFor(1_200)
  expect(await seek().getAttribute('aria-valuetext')).toBe('2026-09-17')
  await seek().focus()
  await page.keyboard.press('End')
  await page.getByText('持仓记录于 2026-09-30').waitFor()
  await settled()
  await page.clock.runFor(1_200)
  expect(await page.getByRole('button', { name: '播放', exact: true }).isEnabled()).toBe(true)
  await page.getByRole('button', { name: '播放', exact: true }).click()
  expect(await seek().getAttribute('aria-valuetext')).toBe('2026-09-15')
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await settled()
})

it('keeps explanations in hover/focus/touch help and the date range in the header', async () => {
  const history = page.getByRole('region', { name: '持仓历史表现' })
  expect(await history.innerText()).not.toContain('金额加权收益率')
  expect(await history.innerText()).toContain('2026-09-15 — 2026-09-30')
  const trigger = page.getByRole('button', { name: '历史收益说明', exact: true })
  await trigger.hover()
  const tip = page.getByRole('tooltip')
  await tip.waitFor()
  await expect.poll(() => tip.innerText()).toContain('不含现金、分红和费用')
  await tip.hover()
  await page.clock.runFor(300)
  expect(await tip.isVisible()).toBe(true)
  await page.screenshot({ path: join(evidenceDir, 'help-hover-1024.png') })
  await trigger.focus()
  await page.keyboard.press('Escape')
  expect(await tip.count()).toBe(0)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect.poll(() => trigger.evaluate(el => el === document.activeElement)).toBe(true)
  await tip.waitFor()
  expect(await tip.isVisible()).toBe(true)
  await page.keyboard.press('Escape')
  await trigger.click()
  await tip.waitFor()
  expect(await tip.isVisible()).toBe(true)
  await tip.getByText('历史收益为估算值，不含现金；缺失数据不补零。', { exact: true }).click()
  expect(await tip.isVisible()).toBe(true)
  await page.getByRole('heading', { name: '每日盈亏', exact: true }).click()
  expect(await tip.count()).toBe(0)
})

it('opens the same explanation by touch without overflowing a narrow viewport', async () => {
  const touch = await browser.newPage({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'light' })
  try {
    await touch.route('**/*', route => [origin, apiOrigin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort())
    await touch.clock.install({ time: new Date('2026-10-03T06:00:00Z') })
    await touch.goto(origin)
    await touch.getByRole('button', { name: '历史收益说明', exact: true }).tap()
    const tip = touch.getByRole('tooltip')
    await tip.waitFor()
    await expect.poll(() => tip.innerText()).toContain('不含现金、分红和费用')
    const bounds = await tip.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
    await touch.screenshot({ path: join(evidenceDir, 'touch-help-390.png') })
    await touch.getByRole('button', { name: '历史收益说明', exact: true }).tap()
    await tip.waitFor({ state: 'hidden' })
  } finally { await touch.close() }
})

it('distinguishes missing trading days from closures in both themes and all supported viewports', async () => {
  const missing = page.getByRole('button', { name: '2026-09-15，交易日，已有估值，缺少收益基准', exact: true })
  const closed = page.getByRole('button', { name: '2026-09-19，休市，无历史估值', exact: true })
  expect(await missing.innerText()).toContain('缺基准')
  const records = []
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: '深色', exact: true }).click()
    const missingBackground = await missing.evaluate(el => getComputedStyle(el).backgroundColor)
    expect(missingBackground).not.toBe(await closed.evaluate(el => getComputedStyle(el).backgroundColor))
    expect(await missing.evaluate(el => getComputedStyle(el).borderStyle)).toBe('dashed')
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 879 })
      await page.evaluate(() => { window.scrollTo(0, 0) })
      await page.clock.runFor(100)
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: join(evidenceDir, `${theme}-${width}.png`), fullPage: true })
      const bounds = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
      expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.viewport)
      records.push({ theme, width, ...bounds })
    }
  }
  await page.setViewportSize({ width: 1024, height: 879 })
  await page.evaluate(() => { window.scrollTo(0, 0) })
  await page.evaluate(() => { document.documentElement.style.zoom = '1.25' })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: join(evidenceDir, 'zoom-1024.png'), fullPage: true })
  await page.evaluate(() => { document.documentElement.style.zoom = '' })
  await writeFile(join(evidenceDir, 'viewports.json'), JSON.stringify(records, null, 2))
})

it('preserves the first-day timeline after refresh failure and recovers', async () => {
  failHistory = true
  await page.getByRole('button', { name: '刷新数据', exact: true }).click()
  await page.getByText('历史表现刷新失败，当前显示上次结果，可能已过期。').waitFor()
  expect(await seek().getAttribute('max')).toBe('10')
  expect(await seek().inputValue()).toBe('0')
  failHistory = false
  await page.getByRole('button', { name: '重试历史表现', exact: true }).click()
  await page.getByText('历史表现刷新失败，当前显示上次结果，可能已过期。').waitFor({ state: 'hidden' })
  await settled()
  expect(await page.getByText('历史表现刷新失败，当前显示上次结果，可能已过期。').count()).toBe(0)
  expect(await seek().getAttribute('max')).toBe('10')
})

it('handles empty and single-estimate histories without invented values', async () => {
  dataMode = 'empty'
  await page.reload()
  await settled()
  expect(await page.getByText('所选区间暂无持仓历史估值。').isVisible()).toBe(true)
  expect(await page.getByRole('button', { name: '第一天', exact: true }).isDisabled()).toBe(true)
  expect(await page.getByRole('button', { name: '播放', exact: true }).isDisabled()).toBe(true)
  dataMode = 'single'
  await page.getByRole('button', { name: '刷新数据', exact: true }).click()
  await settled()
  await page.getByRole('button', { name: '第一天', exact: true }).click()
  expect(await seek().getAttribute('max')).toBe('0')
  expect(await page.getByRole('button', { name: '播放', exact: true }).isDisabled()).toBe(true)
  expect(errors).toEqual([])
})

it('preserves a paused playback interval across midnight and releases it on today', async () => {
  dataMode = 'full'
  await page.reload()
  await settled()
  await page.getByRole('button', { name: '第一天', exact: true }).click()
  await settled()
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await page.clock.runFor(1_200)
  await page.getByText('持仓记录于 2026-09-16').waitFor()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  const before = requests.length
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.setSystemTime(new Date('2026-10-03T16:01:00Z'))
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'visibilityState')
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.runFor(1)
  await settled()
  expect(await seek().getAttribute('aria-valuetext')).toBe('2026-09-16')
  expect(await seek().getAttribute('max')).toBe('10')
  const historyReads = () => requests.slice(before).filter(path => path.includes('/history?from=2026-07-'))
  await expect.poll(() => historyReads().length).toBeGreaterThan(0)
  expect(historyReads().every(path => path.includes('to=2026-10-02'))).toBe(true)
  await page.getByRole('button', { name: '当日', exact: true }).click()
  await page.getByText('持仓记录于 2026-10-04').waitFor()
  await settled()
  expect(requests.some(path => path.includes('/history?from=2026-07-06&to=2026-10-03'))).toBe(true)
  expect(errors).toEqual([])
})
