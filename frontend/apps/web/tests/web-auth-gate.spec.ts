// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginGate } from '../src/web-auth.tsx'

afterEach(cleanup)

describe('Web administrator login gate', () => {
  it('shows fail-closed configuration guidance and a retry action', () => {
    const retry = vi.fn()
    render(React.createElement(LoginGate, {
      initialPhase: 'unavailable', onLogin: async () => ({ phase: 'unavailable' as const }), onRefresh: async () => ({ phase: 'ready' as const }), onRetry: retry,
    }))
    expect(screen.getByText('管理员登录尚未配置完成，请联系部署管理员。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('submits credentials and presents the generic failure state', async () => {
    const login = vi.fn(async () => ({ phase: 'invalid' as const }))
    render(React.createElement(LoginGate, { initialPhase: 'ready', onLogin: login, onRefresh: async () => ({ phase: 'ready' as const }), onRetry: () => {} }))
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'admin' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => { expect(screen.getByText('用户名或密码不正确，请重试。')).toBeTruthy() })
    expect(login).toHaveBeenCalledWith('admin', 'wrong', undefined)
  })

  it('surfaces an expired-session reason before the user retries', () => {
    render(React.createElement(LoginGate, {
      initialPhase: 'expired', onLogin: async () => ({ phase: 'success' as const }), onRefresh: async () => ({ phase: 'ready' as const }), onRetry: () => {},
    }))
    expect(screen.getByText('登录已过期，请重新登录。')).toBeTruthy()
  })

  it('uses the investment product brand and icon on the login gate', () => {
    render(React.createElement(LoginGate, {
      initialPhase: 'ready', onLogin: async () => ({ phase: 'success' as const }), onRefresh: async () => ({ phase: 'ready' as const }), onRetry: () => {},
    }))
    expect(screen.getByText('投研智能体')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '管理员登录' })).toBeTruthy()
    expect(screen.getByRole('img', { name: '投研智能体' }).getAttribute('src'))
      .toBe('/icons/app-icon-001/icon-192.png')
    expect(screen.queryByText('DeepSeek Harness')).toBeNull()
  })

  it('distinguishes retryable network loss from configuration and secure-transport failures', () => {
    const retry = vi.fn()
    const network = render(React.createElement(LoginGate, {
      initialPhase: 'network', onLogin: async () => ({ phase: 'network' as const }), onRefresh: async () => ({ phase: 'ready' as const }), onRetry: retry,
    }))
    expect(screen.getByText('无法连接到登录服务，请检查网络后重试。')).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>('用户名').disabled).toBe(false)
    network.unmount()

    render(React.createElement(LoginGate, {
      initialPhase: 'transport', onLogin: async () => ({ phase: 'transport' as const }), onRefresh: async () => ({ phase: 'ready' as const }), onRetry: retry,
    }))
    expect(screen.getByText('当前连接未经过受信任的 HTTPS 入口，请使用部署管理员提供的安全地址。')).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>('用户名').disabled).toBe(true)
  })
})

const challenge = (id = 'opaque-id') => ({ id, image: 'data:image/png;base64,aGVsbG8=', expiresAt: Date.now() + 120_000 })
function fillCredentials() {
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'admin' } })
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'wrong' } })
}

describe('adaptive captcha form', () => {
  it('keeps the captcha hidden until the server requires it and focuses its input', async () => {
    const captcha = challenge()
    const login = vi.fn().mockResolvedValueOnce({ phase: 'invalid' as const }).mockResolvedValueOnce({ phase: 'invalid' as const, captcha })
    render(React.createElement(LoginGate, { initialPhase: 'ready', onLogin: login,
      onRefresh: async () => ({ phase: 'ready' as const, captcha }), onRetry: () => {} }))
    fillCredentials()
    fireEvent.submit(screen.getByRole('button', { name: '登录' }).closest('form')!)
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('用户名或密码'))
    expect(screen.queryByLabelText('验证码')).toBeNull()
    fireEvent.submit(screen.getByRole('button', { name: '登录' }).closest('form')!)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('验证码')))
    expect(screen.getByLabelText<HTMLInputElement>('用户名').value).toBe('admin')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '登录' }).disabled).toBe(true)
    expect(screen.getByRole('img', { name: '登录验证码，6 位数字' }).getAttribute('alt')).not.toContain('222222')
  })

  it('refreshes without submitting credentials, clears stale input, and restores keyboard focus', async () => {
    const login = vi.fn()
    const refresh = vi.fn().mockResolvedValueOnce({ phase: 'ready' as const, captcha: challenge('first') })
      .mockResolvedValueOnce({ phase: 'ready' as const, captcha: challenge('second') })
    render(React.createElement(LoginGate, { initialPhase: 'ready', initialCaptchaRequired: true,
      onLogin: login, onRefresh: refresh, onRetry: () => {} }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('验证码')))
    fireEvent.change(screen.getByLabelText('验证码'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: '换一张' }))
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('验证码').value).toBe(''))
    expect(login).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByLabelText('验证码'))
    expect(screen.getByRole('status').textContent).toContain('验证码已更新')
  })

  it('submits the current proof and replaces it after a server rejection', async () => {
    const login = vi.fn(async () => ({ phase: 'captcha-invalid' as const, captcha: challenge('new') }))
    render(React.createElement(LoginGate, { initialPhase: 'ready', initialCaptchaRequired: true, onLogin: login,
      onRefresh: async () => ({ phase: 'ready' as const, captcha: challenge() }), onRetry: () => {} }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('验证码')))
    fillCredentials()
    fireEvent.change(screen.getByLabelText('验证码'), { target: { value: '222222' } })
    fireEvent.submit(screen.getByRole('button', { name: '登录' }).closest('form')!)
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('验证码不正确'))
    expect(login).toHaveBeenCalledWith('admin', 'wrong', { id: 'opaque-id', answer: '222222' })
    expect(screen.getByLabelText<HTMLInputElement>('验证码').value).toBe('')
  })

  it('prevents duplicate requests while verification is pending', async () => {
    let settle!: (outcome: { phase: 'invalid' }) => void
    const login = vi.fn(() => new Promise<{ phase: 'invalid' }>(resolve => { settle = resolve }))
    render(React.createElement(LoginGate, { initialPhase: 'ready', onLogin: login,
      onRefresh: async () => ({ phase: 'ready' as const }), onRetry: () => {} }))
    fillCredentials()
    const form = screen.getByRole('button', { name: '登录' }).closest('form')!
    fireEvent.submit(form); fireEvent.submit(form)
    expect(login).toHaveBeenCalledOnce()
    settle({ phase: 'invalid' as const })
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('用户名或密码'))
  })

  it('retains the challenge area on network loss and blocks submission after image load failure', async () => {
    const refresh = vi.fn().mockResolvedValueOnce({ phase: 'ready' as const, captcha: challenge() }).mockRejectedValueOnce(new Error('offline'))
    render(React.createElement(LoginGate, { initialPhase: 'ready', initialCaptchaRequired: true,
      onLogin: async () => ({ phase: 'invalid' as const }), onRefresh: refresh, onRetry: () => {} }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('验证码')))
    fillCredentials()
    fireEvent.click(screen.getByRole('button', { name: '换一张' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('无法连接'))
    expect(screen.getByLabelText('验证码')).toBeTruthy()
    fireEvent.error(screen.getByRole('img', { name: '登录验证码，6 位数字' }))
    fireEvent.change(screen.getByLabelText('验证码'), { target: { value: '222222' } })
    expect(screen.getByText('图片加载失败，请换一张')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '登录' }).disabled).toBe(true)
  })
})
