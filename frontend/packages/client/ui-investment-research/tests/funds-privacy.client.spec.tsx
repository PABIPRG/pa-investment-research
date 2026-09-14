// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FundsPrivacyProvider, privateFunds, useFundsPrivacy } from '../src/client/funds-privacy.tsx'

function Probe() {
  const preference = useFundsPrivacy()
  return (
    <div>
      <span>{privateFunds('¥123,456', preference.hidden)}</span>
      <span>{privateFunds('—', preference.hidden)}</span>
      <button type="button" aria-pressed={preference.hidden} onClick={preference.toggle}>切换资金可见性</button>
    </div>
  )
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('资金隐私偏好', () => {
  it('首次使用默认隐藏资金，并保留缺失数据标记', () => {
    render(<FundsPrivacyProvider><Probe /></FundsPrivacyProvider>)

    expect(screen.getByText('***')).toBeTruthy()
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.queryByText('¥123,456')).toBeNull()
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true')
  })

  it('允许显示资金，并在重新挂载后记住选择', () => {
    const first = render(<FundsPrivacyProvider><Probe /></FundsPrivacyProvider>)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('¥123,456')).toBeTruthy()
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false')

    first.unmount()
    render(<FundsPrivacyProvider><Probe /></FundsPrivacyProvider>)
    expect(screen.getByText('¥123,456')).toBeTruthy()
  })
})
