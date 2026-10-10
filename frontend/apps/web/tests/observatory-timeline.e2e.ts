import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { start, stop, page, requests, errors, seek, settled, control, refresh, evidenceDir, apiOrigin } from './observatory-bundle-fixture.ts'
beforeAll(start)
afterAll(() => stop())
it('uses one real batch and one price range; every navigation path shares valid dates', async () => {
  expect(await seek().getAttribute('aria-valuetext')).toBe('2026-10-09')
  expect(requests).toHaveLength(1)
  const backend = await (await fetch(`${apiOrigin}/__fixture`)).json() as { calls: unknown[] }
  expect(backend.calls).toHaveLength(1)
  await page.getByRole('button', { name: '前一日', exact: true }).click()
  expect(await seek().getAttribute('aria-valuetext')).toBe('2026-09-30')
  await page.getByRole('button', { name: '前一日', exact: true }).click()
  expect(await seek().getAttribute('aria-valuetext')).toBe('2026-09-28')
  await page.getByRole('button', { name: /选择日期，当前/ }).click()
  const dialog = page.getByRole('dialog')
  expect(await dialog.getByRole('button', { name: '27', exact: true }).isDisabled()).toBe(true)
  expect(await dialog.getByRole('button', { name: '29', exact: true }).isDisabled()).toBe(true)
  await dialog.getByRole('button', { name: '25', exact: true }).click()
  expect(await seek().getAttribute('aria-valuetext')).toBe('2026-09-25')
  expect(requests).toHaveLength(1)
  const calendar = page.getByRole('region', { name: '每日盈亏日历' })
  const closed = calendar.getByRole('button', { name: '2026-09-27，休市', exact: true })
  expect(await closed.locator('strong').innerText()).toBe('休市')
  expect(await closed.isDisabled()).toBe(true)
  const missing = calendar.getByRole('button', { name: '2026-09-29，交易日，无记录', exact: true })
  expect(await missing.locator('strong').innerText()).toBe('无记录')
  expect(await missing.isDisabled()).toBe(true)
  expect(await calendar.getByRole('button', { name: /2026-09-28，交易日，估算盈亏/ }).locator('strong').innerText()).toBe('¥4.00')
  expect(await calendar.getByRole('button', { name: /2026-09-30，交易日，已有估值/ }).locator('strong').innerText()).toBe('—')
  await calendar.screenshot({ path: join(evidenceDir, 'calendar-states.png') })
  expect(await page.getByRole('region', { name: '全局时间切片' }).innerText()).toMatchInlineSnapshot(`
    "第一天
    ←
    选择日期
    2026.09.25
    →
    最新数据
    播放
    刷新数据
    2026.09.25 · 持仓估值 ¥20.00
    1 / 4"
  `)
})
it('plays through weekends, gaps and holidays with synchronized amounts and zero requests', async () => {
  await page.getByRole('button', { name: '播放', exact: true }).click()
  for (const [date, amount] of [['2026-09-28', '¥24.00'], ['2026-09-30', '¥26.00'], ['2026-10-09', '¥30.00']]) {
    await page.clock.runFor(1_200)
    expect(await seek().getAttribute('aria-valuetext')).toBe(date)
    expect(await page.getByRole('region', { name: '持仓概览' }).innerText()).toContain(amount)
  }
  await page.clock.runFor(1_200)
  expect(requests).toHaveLength(1)
  await seek().focus(); await page.keyboard.press('Home')
  expect(await seek().getAttribute('aria-valuetext')).toBe('2026-09-25')
  await page.keyboard.press('ArrowRight')
  expect(await seek().getAttribute('aria-valuetext')).toBe('2026-09-28')
  await page.getByRole('img', { name: '持仓历史估值折线图。使用左右方向键逐点查看。' }).focus()
  await page.keyboard.press('ArrowRight')
  expect(await seek().getAttribute('aria-valuetext')).toBe('2026-09-30')
  expect(await page.getByRole('region', { name: '持仓概览' }).innerText()).toContain('¥26.00')
  expect(requests).toHaveLength(1)
})
it('filters, paginates and opens safe details entirely from the batch', async () => {
  await page.getByRole('button', { name: '最新数据', exact: true }).click()
  const before = requests.length
  await page.getByRole('button', { name: '加载更多', exact: true }).click()
  expect(await page.getByRole('button', { name: /个股研究报告/ }).count()).toBe(25)
  await page.getByRole('button', { name: /个股研究报告/ }).first().click()
  expect(await page.getByRole('dialog').innerText()).toContain('不公开报告正文')
  expect(await page.locator('body').innerText()).not.toContain('PRIVATE_NEVER_PUBLIC')
  await page.keyboard.press('Escape')
  await page.getByRole('combobox', { name: '记录类型', exact: true }).click()
  await page.getByRole('option', { name: '操作', exact: true }).click()
  expect(await page.getByText('当前筛选条件下暂无公开记录。').isVisible()).toBe(true)
  await page.getByRole('button', { name: '清除筛选' }).click()
  expect(requests).toHaveLength(before)
})
it('retains cached browsing offline and updates once on the next day', async () => {
  const before = requests.length
  await page.context().setOffline(true)
  await page.getByRole('button', { name: '第一天', exact: true }).click()
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await page.clock.runFor(1_200)
  expect(await seek().getAttribute('aria-valuetext')).toBe('2026-09-28')
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.context().setOffline(false)
  await page.clock.runFor(120_000)
  expect(requests).toHaveLength(before)
  await page.clock.setSystemTime(new Date('2026-10-11T06:00:00Z'))
  await page.clock.runFor(30_000); await settled()
  expect(requests).toHaveLength(before + 1)
  expect(await seek().getAttribute('aria-valuetext')).toBe('2026-09-28')
})
it('disables playback for zero or one valid date and restores after a new batch', async () => {
  await control({ mode: 'empty' }); await refresh()
  expect(await page.getByText('当前区间暂无可用历史估值。休市和缺少估值的日期已跳过。').isVisible()).toBe(true)
  expect(await page.getByRole('button', { name: '播放', exact: true }).isDisabled()).toBe(true)
  await page.screenshot({ path: join(evidenceDir, 'empty.png') })
  await control({ mode: 'single' }); await refresh()
  expect(await page.getByRole('button', { name: '播放', exact: true }).isDisabled()).toBe(true)
  await control({ mode: 'healthy' }); await refresh()
  expect(await page.getByRole('button', { name: '播放', exact: true }).isEnabled()).toBe(true)
  expect(errors).toEqual([])
})
