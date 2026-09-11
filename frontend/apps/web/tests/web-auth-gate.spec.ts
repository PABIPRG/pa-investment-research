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
      initialPhase: 'unavailable', onLogin: async () => 'unavailable' as const, onRetry: retry,
    }))
    expect(screen.getByText('管理员登录尚未配置完成，请联系部署管理员。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('submits credentials and presents the generic failure state', async () => {
    const login = vi.fn(async () => 'invalid' as const)
    render(React.createElement(LoginGate, { initialPhase: 'ready', onLogin: login, onRetry: () => {} }))
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'admin' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => { expect(screen.getByText('用户名或密码不正确，请重试。')).toBeTruthy() })
    expect(login).toHaveBeenCalledWith('admin', 'wrong')
  })

  it('surfaces an expired-session reason before the user retries', () => {
    render(React.createElement(LoginGate, {
      initialPhase: 'expired', onLogin: async () => 'success' as const, onRetry: () => {},
    }))
    expect(screen.getByText('登录已过期，请重新登录。')).toBeTruthy()
  })
})
