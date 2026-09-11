import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { AriaComponent, GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { compactMoney, number, text } from './data.ts'
import css from './InvestmentShell.module.css'

echarts.use([LineChart, GridComponent, TooltipComponent, AriaComponent, CanvasRenderer])

interface PortfolioPerformanceChartProps {
  readonly ariaLabel: string
  readonly series: readonly Record<string, unknown>[]
}

interface PortfolioPerformanceDatum {
  readonly date: string
  readonly value: number
  readonly profitLoss: number | undefined
}

function signedMoney(value: number | undefined): string {
  if (value === undefined) return '—'
  const normalized = Object.is(value, -0) ? 0 : value
  if (normalized === 0) return compactMoney(0)
  return `${normalized > 0 ? '+' : '-'}${compactMoney(Math.abs(normalized))}`
}

function axisMoney(value: number, visibleRange: number): string {
  if (visibleRange < 1_000) return `¥${Math.round(value).toLocaleString('zh-CN')}`
  const absolute = Math.abs(value)
  if (absolute >= 100_000_000) return `¥${(value / 100_000_000).toFixed(2)}亿`
  if (absolute >= 10_000) return `¥${(value / 10_000).toFixed(2)}万`
  if (absolute >= 1_000) return `¥${(value / 1_000).toFixed(1)}千`
  return `¥${Math.round(value).toLocaleString('zh-CN')}`
}

function shortDate(value: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})/.exec(value)
  return match === null ? value : `${match[1]}-${match[2]}`
}

function eventDataIndex(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = (value as { dataIndex?: unknown }).dataIndex
  return typeof candidate === 'number' ? candidate : undefined
}

function tooltipDataIndex(value: unknown): number | undefined {
  return eventDataIndex(Array.isArray(value) ? value[0] : value)
}

function token(element: HTMLElement, name: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim()
}

function chartOption(element: HTMLElement, data: readonly PortfolioPerformanceDatum[], ariaLabel: string): EChartsCoreOption {
  const primary = token(element, '--investment-primary')
  const background = token(element, '--dsw-alias-bg-base')
  const overlay = token(element, '--dsw-alias-bg-overlay')
  const border = token(element, '--dsw-alias-border-l2')
  const labelPrimary = token(element, '--dsw-alias-label-primary')
  const labelSecondary = token(element, '--dsw-alias-label-secondary')
  const labelTertiary = token(element, '--dsw-alias-label-tertiary')
  const values = data.map(point => point.value)
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const range = maximum - minimum
  const padding = range === 0 ? Math.max(Math.abs(maximum) * 0.02, 1) : range * 0.12
  const visibleRange = maximum + padding - Math.max(0, minimum - padding)

  return {
    animationDuration: 420,
    animationEasing: 'cubicOut',
    aria: { enabled: true, label: { description: `${ariaLabel}。使用左右方向键逐点查看估值明细。` } },
    grid: { top: 36, right: 24, bottom: 58, left: 78, containLabel: false },
    tooltip: {
      trigger: 'axis',
      confine: true,
      renderMode: 'richText',
      backgroundColor: overlay,
      borderColor: border,
      borderWidth: 1,
      padding: [9, 11],
      textStyle: {
        color: labelSecondary,
        fontSize: 12,
        lineHeight: 19,
        rich: {
          date: { color: labelPrimary, fontSize: 12, fontWeight: 700, lineHeight: 22 },
          value: { color: labelPrimary, fontWeight: 700 },
        },
      },
      axisPointer: { type: 'line', lineStyle: { color: primary, width: 1 } },
      formatter: (params: unknown) => {
        const index = tooltipDataIndex(params)
        const point = index === undefined ? undefined : data[index]
        if (point === undefined) return ''
        return `{date|${point.date}}\n总资产  {value|${compactMoney(point.value)}}\n累计盈亏  {value|${signedMoney(point.profitLoss)}}`
      },
    },
    xAxis: {
      type: 'category',
      name: '估值日',
      nameLocation: 'middle',
      nameGap: 38,
      boundaryGap: false,
      data: data.map(point => point.date),
      axisLine: { lineStyle: { color: border } },
      axisTick: { alignWithLabel: true, lineStyle: { color: border } },
      axisLabel: {
        color: labelTertiary,
        fontSize: 11,
        margin: 13,
        hideOverlap: true,
        formatter: (value: string) => shortDate(value),
      },
      nameTextStyle: { color: labelTertiary, fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      name: '总资产（元）',
      nameLocation: 'end',
      nameGap: 17,
      scale: true,
      min: Math.max(0, minimum - padding),
      max: maximum + padding,
      splitNumber: 4,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: labelTertiary, fontSize: 11, formatter: (value: number) => axisMoney(value, visibleRange) },
      nameTextStyle: { color: labelTertiary, fontSize: 11, align: 'left' },
      splitLine: { lineStyle: { color: border, type: 'dashed' } },
    },
    series: [{
      name: '总资产估值',
      type: 'line',
      data: data.map(point => point.value),
      smooth: 0.32,
      showSymbol: true,
      symbol: 'circle',
      symbolSize: 9,
      lineStyle: { color: primary, width: 3 },
      itemStyle: { color: primary, borderColor: background, borderWidth: 3 },
      areaStyle: { color: primary, opacity: 0.08 },
      label: {
        show: data.length <= 5,
        position: 'top',
        distance: 10,
        color: labelPrimary,
        fontSize: 11,
        formatter: (params: unknown) => {
          const index = eventDataIndex(params)
          return index === undefined ? '' : compactMoney(data[index]?.value ?? 0)
        },
      },
      endLabel: {
        show: data.length > 5,
        color: labelPrimary,
        fontSize: 11,
        formatter: (params: unknown) => {
          const index = eventDataIndex(params)
          return index === undefined ? '' : compactMoney(data[index]?.value ?? 0)
        },
      },
      emphasis: { focus: 'series', scale: 1.45 },
    }],
  }
}

/** Canvas-rendered interactive valuation chart with keyboard point navigation. */
export function PortfolioPerformanceChart({ ariaLabel, series }: PortfolioPerformanceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const data = useMemo(() => series.flatMap(item => {
    const value = number(item.value)
    if (value === undefined) return []
    return [{ date: text(item.date, '估值日未知'), value, profitLoss: number(item.profit_loss) }]
  }), [series])

  useEffect(() => {
    const container = containerRef.current
    if (container === null || data.length < 2) return
    let chart: ReturnType<typeof echarts.init> | undefined
    const render = () => { chart?.setOption(chartOption(container, data, ariaLabel), true) }
    const initialize = () => {
      if (chart !== undefined || container.clientWidth === 0 || container.clientHeight === 0) return
      try {
        chart = echarts.init(container, undefined, { renderer: 'canvas' })
      } catch {
        return
      }
      chartRef.current = chart
      render()
      chart.on('mouseover', (event: unknown) => {
        const index = eventDataIndex(event)
        if (index !== undefined) setActiveIndex(index)
      })
      chart.on('mouseout', () => { setActiveIndex(null) })
    }
    const handleResize = () => {
      initialize()
      chart?.resize()
    }
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(handleResize)
    resizeObserver?.observe(container)
    window.addEventListener('resize', handleResize)
    const themeObserver = typeof MutationObserver === 'undefined'
      ? undefined
      : new MutationObserver(render)
    themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
    initialize()

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', handleResize)
      themeObserver?.disconnect()
      chart?.dispose()
      chartRef.current = null
    }
  }, [ariaLabel, data])

  const revealPoint = (index: number) => {
    const normalized = Math.max(0, Math.min(index, data.length - 1))
    setActiveIndex(normalized)
    chartRef.current?.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: normalized })
  }
  const activePoint = activeIndex === null ? data.at(-1) : data[activeIndex]

  return (
    <div className={css.performanceChartFrame} role="group" aria-label={ariaLabel}>
      <div className={css.performanceChartLegend}>
        <span><i aria-hidden="true" />总资产估值</span>
        <small>{data.length} 个估值日</small>
      </div>
      <div
        ref={containerRef}
        className={css.performanceChartCanvas}
        role="img"
        tabIndex={0}
        aria-label={`${ariaLabel}。使用左右方向键逐点查看估值明细。`}
        onFocus={() => { revealPoint(activeIndex ?? data.length - 1) }}
        onBlur={() => {
          setActiveIndex(null)
          chartRef.current?.dispatchAction({ type: 'hideTip' })
        }}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          if (event.key === 'Home') revealPoint(0)
          else if (event.key === 'End') revealPoint(data.length - 1)
          else if (event.key === 'ArrowLeft') revealPoint((activeIndex ?? data.length) - 1)
          else revealPoint((activeIndex ?? -1) + 1)
        }}
      />
      {activePoint !== undefined && (
        <div className={css.performanceChartPointSummary} aria-live="polite">
          <strong>{activeIndex === null ? `最新估值 · ${activePoint.date}` : activePoint.date}</strong>
          <span>总资产 <b>{compactMoney(activePoint.value)}</b></span>
          <span>累计盈亏 <b data-tone={activePoint.profitLoss === undefined || activePoint.profitLoss === 0 ? undefined : activePoint.profitLoss > 0 ? 'positive' : 'negative'}>{signedMoney(activePoint.profitLoss)}</b></span>
        </div>
      )}
      <p className={css.performanceChartHelp}>悬停节点查看明细；键盘聚焦图表后，可用左右方向键切换估值日。</p>
    </div>
  )
}
