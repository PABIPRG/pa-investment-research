import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, DataZoomComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EquityPoint } from './api.ts'
import css from './App.module.css'

echarts.use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, CanvasRenderer])

const money = new Intl.NumberFormat('zh-CN', {
  style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2,
})

export function EquityChart({ points, dark }: { points: EquityPoint[]; dark: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)
  const [activeIndex, setActiveIndex] = useState(Math.max(0, points.length - 1))

  useEffect(() => {
    if (root.current === null) return
    chart.current?.dispose()
    const instance = echarts.init(root.current, dark ? 'dark' : undefined, { renderer: 'canvas' })
    chart.current = instance
    instance.setOption({
      backgroundColor: 'transparent',
      animationDuration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 420,
      grid: { left: 10, right: 18, top: 24, bottom: points.length > 20 ? 52 : 30, containLabel: true },
      tooltip: {
        trigger: 'axis',
        formatter: (raw: unknown) => {
          const row = (Array.isArray(raw) ? raw[0] : raw) as { dataIndex?: number } | undefined
          const point = points[row?.dataIndex ?? 0]
          return point === undefined ? '' : `${point.date}<br/><strong>${money.format(Number(point.total_equity))}</strong>`
        },
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: points.map(point => point.date.slice(5).replace('-', '.')),
        axisLine: { lineStyle: { color: dark ? '#55626d' : '#d5dce3' } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value', scale: true,
        axisLabel: { formatter: (value: number) => `${Math.round(value / 1000)}k` },
        splitLine: { lineStyle: { color: dark ? '#313b44' : '#edf0f3' } },
      },
      dataZoom: points.length > 20 ? [{ type: 'inside' }, { type: 'slider', height: 16 }] : [],
      series: [{
        type: 'line',
        data: points.map(point => Number(point.total_equity)),
        symbol: 'circle',
        symbolSize: points.length > 32 ? 4 : 7,
        showSymbol: points.length <= 32,
        lineStyle: { width: 3, color: '#13a8a8' },
        itemStyle: { color: '#13a8a8' },
        areaStyle: { color: dark ? 'rgba(19,168,168,.14)' : 'rgba(19,168,168,.10)' },
      }],
    })
    const resize = new ResizeObserver(() => { instance.resize() })
    resize.observe(root.current)
    return () => { resize.disconnect(); instance.dispose(); chart.current = null }
  }, [dark, points])

  if (points.length === 0) return <div className={css.empty}>所选区间暂无权益快照。</div>
  const active = points[Math.min(activeIndex, points.length - 1)]
  return (
    <>
      <div
        ref={root}
        className={css.chart}
        role="img"
        tabIndex={0}
        aria-label="权益轨迹折线图。使用左右方向键逐点查看。"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const next = Math.max(0, Math.min(points.length - 1, activeIndex + (event.key === 'ArrowRight' ? 1 : -1)))
          setActiveIndex(next)
          chart.current?.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: next })
        }}
      />
      <p className={css.srOnly} aria-live="polite">
        {active === undefined ? '' : `${active.date}，总权益 ${money.format(Number(active.total_equity))}`}
      </p>
    </>
  )
}
