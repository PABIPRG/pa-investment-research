import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { start, stop, page, requests, errors, control, refresh, evidenceDir } from './observatory-bundle-fixture.ts'
beforeAll(start)
afterAll(() => stop('density'))
async function settleLayout() {
  // ResizeObserver and the chart's render frame must both settle after a breakpoint or zoom change.
  await expect.poll(async () => {
    await page.clock.runFor(100)
    return page.getByRole('img', { name: '持仓历史估值折线图。使用左右方向键逐点查看。' }).evaluate((root) => {
      const canvas = root.querySelector('canvas')
      return canvas !== null && Math.abs(canvas.getBoundingClientRect().width - root.getBoundingClientRect().width) < 1 &&
        document.documentElement.scrollWidth <= innerWidth + 1
    })
  }).toBe(true)
  await page.clock.runFor(300)
}
it('retains one complete batch while refreshing and recovers from a real backend failure', async () => {
  const summary = page.getByRole('region', { name: '持仓概览' })
  const before = await summary.innerText()
  await control({ mode: 'fail' })
  await refresh()
  expect(await page.getByText('观察室数据刷新失败，当前显示上次结果，可能已过期。').isVisible()).toBe(true)
  expect(await summary.innerText()).toBe(before)
  await page.screenshot({ path: join(evidenceDir, 'failed-retained.png') })
  await control({ mode: 'healthy', delay: 0.3 })
  const pending = refresh('重试观察室数据')
  await page.waitForFunction(() => document.querySelectorAll('[data-refresh-indicator][data-loading="true"]').length > 0)
  expect(await summary.innerText()).toBe(before)
  await pending; await control({ delay: 0 })
  expect(await page.getByText('观察室数据刷新失败，当前显示上次结果，可能已过期。').count()).toBe(0)
  expect(await summary.innerText()).toBe(before)
  await page.screenshot({ path: join(evidenceDir, 'recovered.png') })
})
it('keeps controls, names and numbers readable in four viewports and both themes', async () => {
  const before = requests.length
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const dark of [false, true]) {
      const toggle = page.getByRole('button', { name: dark ? '深色' : '浅色', exact: true })
      if (await toggle.count()) await toggle.click()
      await page.waitForFunction(expected => document.body.hasAttribute('data-ds-dark-theme') === expected, dark)
      await settleLayout()
      await page.screenshot({ path: join(evidenceDir, `layout-${width}-${dark ? 'dark' : 'light'}.png`), fullPage: true })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
      expect(await page.getByRole('button', { name: '最新数据', exact: true }).isVisible()).toBe(true)
      expect(await page.getByRole('button', { name: '刷新数据', exact: true }).isVisible()).toBe(true)
    }
  }
  expect(requests).toHaveLength(before)
  await page.setViewportSize({ width: 1024, height: 879 })
  await settleLayout()
  await page.evaluate(() => { document.documentElement.style.zoom = '1.25' })
  await settleLayout()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.screenshot({ path: join(evidenceDir, 'zoom-125.png'), fullPage: true })
  await page.evaluate(() => { document.documentElement.style.zoom = '' })
  await settleLayout()
})
it('supports holdings focus return and help via keyboard without new reads', async () => {
  const before = requests.length
  const open = page.getByRole('button', { name: '展开持仓明细' })
  await open.focus(); await page.keyboard.press('Enter')
  expect(await page.getByRole('dialog').innerText()).toContain('虚构证券超长中文名称验证')
  expect(await page.getByRole('dialog').innerText()).toContain('¥15.00')
  await page.keyboard.press('Escape'); await page.clock.runFor(100)
  expect(await open.evaluate(el => el === document.activeElement)).toBe(true)
  const help = page.getByRole('button', { name: '历史收益说明' })
  await help.focus()
  await page.getByText('历史收益为估算值，不含现金；缺失数据不补零。').waitFor()
  await page.keyboard.press('Escape')
  expect(requests).toHaveLength(before); expect(errors).toEqual([])
})
