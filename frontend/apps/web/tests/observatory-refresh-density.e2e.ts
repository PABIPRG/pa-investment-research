import { createServer, type Server } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { preview, type PreviewServer } from 'vite'
import { afterAll, beforeAll, expect, it } from 'vitest'

const appRoot = fileURLToPath(new URL('../../public-observatory/', import.meta.url))
const appPort = Number(process.env.OBSERVATORY_UAT_PORT ?? 3398)
const apiPort = Number(process.env.OBSERVATORY_UAT_API_PORT ?? 3399)
const requestCounts = new Map<string, number>()
const evidenceDir = process.env.OBSERVATORY_UAT_DIR ?? '/private/tmp/observatory-feedback-uat'
const points = Array.from({ length: 16 }, (_, i) => ({
  date: `2026-09-${15 + i}`, value: String(28_000 + i * 40), profit_loss: String(i === 2 ? -20 : i * 40),
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
let failHistory = false
let abortedResponses = 0
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
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${apiPort}`)
    const path = url.pathname.split('/').at(-1)!
    requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1)
    const date = url.searchParams.get('date') ?? '2026-09-30'
    const dayIndex = Math.round((Date.parse(date) - Date.parse('2026-09-15')) / 86_400_000)
    const marketValue = 28000 + dayIndex * 40
    const cost = 27000 + dayIndex * 2000
    const body = path === 'live' ? {
      availability: 'available', date, currency: 'CNY', source: date === '2026-09-30' ? 'current_holdings' : 'recorded_holdings', holdings_as_of: date,
      summary: date === '2026-09-30' ? { holdings_cost: '41166.24', market_value: '28691.20', floating_profit_loss: '-12475.04', cost_return: '-0.303', cash: null, initial_capital: null, total_equity: null } : { holdings_cost: cost.toFixed(2), market_value: marketValue.toFixed(2), floating_profit_loss: (marketValue - cost).toFixed(2), cost_return: String((marketValue - cost) / cost), cash: null, initial_capital: null, total_equity: null },
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
      if (res.destroyed) return
      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('content-type', 'application/json')
      if ((path === 'live' && failLive) || (path === 'history' && failHistory)) res.statusCode = 503
      res.end(JSON.stringify(body))
    }
    if (paused.has(path)) {
      pending.push({ path, send })
      res.once('close', () => { if (!res.writableEnded) abortedResponses++ })
    }
    else send()
  })
  await new Promise<void>(resolve => api.listen(apiPort, '127.0.0.1', resolve))
  app = await preview({ root: appRoot, preview: { host: '127.0.0.1', port: appPort, strictPort: true } })
  browser = await chromium.launch()
  page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1024, height: 879 }, reducedMotion: 'reduce' })
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.clock.install({ time: new Date('2026-09-30T06:00:00Z') })
  await page.goto(`http://127.0.0.1:${appPort}`)
  await page.getByRole('button', { name: activity.title }).waitFor()
  await page.waitForFunction(() => document.querySelectorAll('[data-refresh-indicator][data-loading="true"]').length === 0)
})
afterAll(async () => {
  release()
  await browser?.close()
  if (app) await new Promise<void>(resolve => app.httpServer.close(() =>{  resolve() }))
  if (api) await new Promise<void>(resolve => api.close(() =>{  resolve() }))
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
  const historicalCounts = [requestCounts.get('history'), requestCounts.get('calendar')]
  paused = new Set(['live', 'activities'])
  await page.clock.runFor(15_000)
  await page.waitForFunction(() => document.querySelectorAll('[data-refresh-indicator][data-loading="true"]').length === 3)
  expect([requestCounts.get('history'), requestCounts.get('calendar')]).toEqual(historicalCounts)
  expect(await geometry()).toEqual(before)
  expect(await page.locator('main').innerText()).not.toContain('正在刷新')
  await page.screenshot({ path: join(evidenceDir, 'refresh-1024.png'), fullPage: true })
  release('live')
  await page.waitForFunction(() => document.querySelectorAll('[data-refresh-indicator][data-loading="true"]').length === 1)
  expect(await geometry()).toEqual(before)
  release('activities')
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

it('plays synchronized summary amounts, waits for slow data and seeks with the keyboard', async () => {
  const counts = [requestCounts.get('history'), requestCounts.get('calendar')]
  const summary = page.getByRole('region', { name: '持仓概览' })
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await page.getByText('持仓记录于 2026-09-15').waitFor()
  for (const value of ['28,000.00', '27,000.00', '1,000.00', '3.70%']) expect(await summary.innerText()).toContain(value)
  expect(await summary.innerText()).toMatchInlineSnapshot(`
    "截至 2026.09.15 · 持仓浮盈
    ¥1,000.00

    3.70%

    计算口径
    持仓市值
    ¥28,000.00
    不含现金
    持仓成本
    ¥27,000.00
    所选日期持仓数量 × 成本价

    现金 — · 完整总权益 —；暂无可靠来源，当前金额仅反映持仓。"
  `)
  await page.screenshot({ path: join(evidenceDir, 'playback-positive.png') })
  paused = new Set(['live'])
  await page.clock.runFor(1_200)
  await page.waitForFunction(() => document.querySelector('[aria-label="持仓概览"]')?.textContent?.includes('2026.09.16'))
  await page.clock.runFor(5_000)
  expect(await summary.innerText()).toContain('2026.09.16')
  expect(await summary.innerText()).not.toContain('28,000.00')
  release('live')
  await page.getByText('持仓记录于 2026-09-16').waitFor()
  for (const value of ['28,040.00', '29,000.00', '-¥960.00', '-3.31%']) expect(await summary.innerText()).toContain(value)
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  expect([requestCounts.get('history'), requestCounts.get('calendar')]).toEqual(counts)
  await page.screenshot({ path: join(evidenceDir, 'playback-negative.png') })
  const seek = page.getByRole('slider', { name: '跳转历史播放日期' })
  await seek.focus()
  await page.keyboard.press('End')
  await page.getByText('持仓记录于 2026-09-29').waitFor()
  await page.keyboard.press('Home')
  await page.getByText('持仓记录于 2026-09-15').waitFor()
  expect(await summary.innerText()).toContain('27,000.00')
  expect([requestCounts.get('history'), requestCounts.get('calendar')]).toEqual(counts)
  await page.getByRole('button', { name: '展开持仓明细' }).click()
  expect(await page.getByRole('dialog').locator('caption').innerText()).toContain('2026-09-15')
  await page.keyboard.press('Escape')
  await expect.poll(() => page.getByRole('button', { name: '展开持仓明细' }).evaluate(node => node === document.activeElement)).toBe(true)
  expect(await page.getByRole('button', { name: '展开持仓明细' }).innerText()).toBe('')
  await page.getByRole('button', { name: '当日', exact: true }).click()
  await page.getByText('持仓记录于 2026-09-30').waitFor()
})

it('survives slow requests, backs off failures and recovers without polling T+1 data', async () => {
  const idle = () => page.waitForFunction(() => document.querySelectorAll('[data-refresh-indicator][data-loading="true"]').length === 0)
  await idle()
  const historicalCounts = [requestCounts.get('history'), requestCounts.get('calendar')]
  const before = requestCounts.get('live')!
  const aborted = abortedResponses
  paused = new Set(['activities'])
  await page.clock.runFor(15_000)
  await page.waitForFunction(() => document.querySelector('[data-refresh-indicator="操作记录"]')?.getAttribute('data-loading') === 'true' && document.querySelector('[data-refresh-indicator="持仓"]')?.getAttribute('data-loading') === 'false')
  await page.clock.runFor(20_000)
  expect(requestCounts.get('live')).toBe(before + 1)
  expect(abortedResponses).toBe(aborted)
  release()
  await idle()
  failLive = true
  await page.clock.runFor(15_000)
  const warning = page.getByText('持仓刷新失败，当前显示上次结果，可能已过期。')
  await warning.waitFor()
  await idle()
  const firstFailure = requestCounts.get('live')!
  // 浏览器继续渲染时真实时间也会前进；精确毫秒边界由 refresh.spec.ts 的假时钟覆盖。
  await page.clock.runFor(29_000)
  expect(requestCounts.get('live')).toBe(firstFailure)
  await page.clock.runFor(1_100)
  await expect.poll(() => requestCounts.get('live')).toBe(firstFailure + 1)
  await idle()
  failLive = false
  await page.clock.runFor(59_000)
  expect(requestCounts.get('live')).toBe(firstFailure + 1)
  expect(await warning.isVisible()).toBe(true)
  await page.screenshot({ path: join(evidenceDir, 'resident-backoff.png'), fullPage: true })
  await page.clock.runFor(1_100)
  await warning.waitFor({ state: 'hidden' })
  await idle()
  expect(requestCounts.get('live')).toBe(firstFailure + 2)
  await page.clock.runFor(15_000)
  await expect.poll(() => requestCounts.get('live')).toBe(firstFailure + 3)
  await idle()
  expect([requestCounts.get('history'), requestCounts.get('calendar')]).toEqual(historicalCounts)

  paused = new Set(['live'])
  await page.clock.runFor(15_000)
  await page.waitForFunction(() => document.querySelector('[data-refresh-indicator="持仓"]')?.getAttribute('data-loading') === 'true')
  const timeoutStart = requestCounts.get('live')!
  await page.clock.runFor(30_000)
  await warning.waitFor()
  await idle()
  expect(requestCounts.get('live')).toBe(timeoutStart)
  await expect.poll(() => abortedResponses).toBe(aborted + 1)
  release()
  await page.clock.runFor(30_000)
  await warning.waitFor({ state: 'hidden' })
  await idle()
  await writeFile(join(evidenceDir, 'resident-recovery.json'), JSON.stringify({ slowRequestPreserved: true, retryDelays: [30000, 60000], timeoutMs: 30000, recovered: true, historicalCounts }, null, 2))
})

it('pauses hidden and offline requests, preserves playback and retries only failed daily data', async () => {
  const idle = () => page.waitForFunction(() => document.querySelectorAll('[data-refresh-indicator][data-loading="true"]').length === 0)
  await idle()
  const before = Object.fromEntries(requestCounts)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.runFor(120_000)
  expect(Object.fromEntries(requestCounts)).toEqual(before)
  await page.context().setOffline(true)
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'visibilityState')
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.getByText('网络已断开 · 自动刷新暂停', { exact: true }).waitFor()
  expect(await page.getByRole('checkbox').locator('..').innerText()).toMatchInlineSnapshot('"网络已断开 · 自动刷新暂停"')
  await page.clock.runFor(120_000)
  expect(Object.fromEntries(requestCounts)).toEqual(before)
  await page.screenshot({ path: join(evidenceDir, 'resident-offline.png'), fullPage: true })
  await page.context().setOffline(false)
  await page.clock.runFor(1)
  await expect.poll(() => requestCounts.get('live')).toBe(before.live! + 1)
  await idle()
  expect(requestCounts.get('history')).toBe(before.history)
  expect(requestCounts.get('calendar')).toBe(before.calendar)

  await page.getByRole('button', { name: '播放', exact: true }).click()
  await page.getByText('持仓记录于 2026-09-15').waitFor()
  await page.context().setOffline(true)
  await page.getByText('网络已断开 · 自动刷新暂停', { exact: true }).waitFor()
  await page.clock.runFor(60_000)
  expect(await page.getByRole('region', { name: '持仓概览' }).innerText()).toContain('2026.09.15')
  await page.context().setOffline(false)
  await page.getByRole('checkbox', { name: '播放预览 · 自动刷新暂停' }).waitFor()
  await page.clock.runFor(1_200)
  await page.getByText('持仓记录于 2026-09-16').waitFor()
  expect(await page.getByRole('region', { name: '持仓概览' }).innerText()).toContain('29,000.00')
  await page.getByRole('button', { name: '当日', exact: true }).click()
  await idle()

  failHistory = true
  await page.getByRole('button', { name: '刷新数据' }).click()
  await page.getByText('历史表现刷新失败，当前显示上次结果，可能已过期。').waitFor()
  await page.getByText('日历刷新失败，当前显示上次结果，可能已过期。').waitFor()
  await idle()
  const historyFailures = requestCounts.get('history')!
  failHistory = false
  await page.clock.runFor(30_000)
  await page.getByText('历史表现刷新失败，当前显示上次结果，可能已过期。').waitFor({ state: 'hidden' })
  await page.getByText('日历刷新失败，当前显示上次结果，可能已过期。').waitFor({ state: 'hidden' })
  await idle()
  expect(requestCounts.get('history')).toBe(historyFailures + 2)
  const recovered = [requestCounts.get('history'), requestCounts.get('calendar')]
  for (let i = 0; i < 4; i++) { await page.clock.runFor(15_000); await idle() }
  expect([requestCounts.get('history'), requestCounts.get('calendar')]).toEqual(recovered)
  await page.screenshot({ path: join(evidenceDir, 'resident-recovered.png'), fullPage: true })
})

it('keeps long names, values and controls usable at all supported sizes and themes', async () => {
  await page.getByRole('checkbox', { name: '每 15 秒自动刷新' }).uncheck()
  const sizes = []
  for (const theme of ['light', 'dark'] as const) {
    if (theme === 'dark') await page.getByRole('button', { name: '深色', exact: true }).click()
    await page.clock.runFor(100)
    const colors = await page.evaluate(() => {
      const context = document.createElement('canvas').getContext('2d')!
      const rgb = (value: string) => {
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = value
        context.fillRect(0, 0, 1, 1)
        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
      }
      const color = (selector: string) => rgb(getComputedStyle(document.querySelector(selector)!).color)
      const background = (selector: string) => rgb(getComputedStyle(document.querySelector(selector)!).backgroundColor)
      return { gainBackground: background('[data-direction="positive"]'), lossBackground: background('[data-direction="negative"]'), summaryBackground: background('[aria-label="持仓概览"]'), gain: color('[data-direction="positive"] strong'), loss: color('[data-direction="negative"] strong'), summary: color('[aria-label="持仓概览"] strong'), rate: color('[aria-label="持仓概览"] p') }
    })
    const [gainRed, gainGreen] = colors.gain
    const [lossRed, lossGreen] = colors.loss
    expect(gainRed).toBeGreaterThan(gainGreen!)
    expect(lossGreen).toBeGreaterThan(lossRed!)
    expect(colors.summary).toEqual(colors.loss)
    expect(colors.rate).toEqual(colors.loss)
    const luminance = (color: number[]) => color.reduce((sum, value, index) => {
      const channel = value / 255
      return sum + (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index]!
    }, 0)
    const pairs = [[colors.gain, colors.gainBackground], [colors.loss, colors.lossBackground], [colors.rate, colors.summaryBackground]]
    for (const [foreground, background] of pairs) {
      const values = [luminance(foreground!), luminance(background!)].sort((a, b) => b - a)
      expect((values[0]! + 0.05) / (values[1]! + 0.05)).toBeGreaterThanOrEqual(4.5)
    }
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 879 })
      await page.screenshot({ path: join(evidenceDir, `${theme}-${width}.png`), fullPage: true })
      if (width === 1024) await page.screenshot({ path: join(evidenceDir, `${theme}-1024-viewport.png`) })
      const bounds = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
      expect(bounds.document).toBeLessThanOrEqual(bounds.viewport)
      expect(await page.getByRole('button', { name: '展开操作记录' }).isVisible()).toBe(true)
      if (width === 390) {
        const target = await page.getByRole('button', { name: '展开持仓明细' }).boundingBox()
        expect(target!.width).toBeGreaterThanOrEqual(44)
        expect(target!.height).toBeGreaterThanOrEqual(44)
      }
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


it('follows today across a hidden midnight without refreshing the previous day first', async () => {
  await page.setViewportSize({ width: 1024, height: 879 })
  await page.getByRole('checkbox', { name: '每 15 秒自动刷新' }).check()
  await page.clock.runFor(1)
  await page.waitForFunction(() => document.querySelectorAll('[data-refresh-indicator][data-loading="true"]').length === 0)
  const dates: string[] = []
  page.on('request', (req) => { const url = new URL(req.url()); if (url.pathname.endsWith('/live')) dates.push(url.searchParams.get('date')!) })
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.setSystemTime(new Date('2026-09-30T16:01:00Z'))
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'visibilityState')
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.runFor(1)
  await page.getByText('持仓记录于 2026-10-01').waitFor()
  expect(dates).toEqual(['2026-10-01'])
  await page.waitForFunction(() => document.querySelectorAll('[data-refresh-indicator][data-loading="true"]').length === 0)
  await page.clock.runFor(15_000)
  await expect.poll(() => dates).toEqual(['2026-10-01', '2026-10-01'])
  await page.screenshot({ path: join(evidenceDir, 'resident-midnight.png'), fullPage: true })
})
