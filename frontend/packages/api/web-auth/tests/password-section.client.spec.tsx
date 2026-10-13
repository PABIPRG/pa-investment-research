// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PasswordSection } from '../src/client/PasswordSection.tsx'
const runtime = { useSessions: vi.fn(), useWorkspaces: vi.fn() } as unknown as Parameters<typeof PasswordSection>[0]
afterEach(cleanup)
function fields(current: string, next: string, confirm = next) {
  fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: current } })
  fireEvent.change(screen.getByLabelText('新密码', { exact: true }), { target: { value: next } })
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: confirm } })
}
it('keeps the username read-only and explains unavailable deployments', () => {
  render(<PasswordSection {...runtime} username="alice" canChangePassword={false} onSubmit={vi.fn()} />)
  expect(screen.getByText('alice')).toBeTruthy()
  expect(screen.queryByLabelText('当前密码')).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('尚未启用')
})
it('rejects mismatched and weak passwords before submitting', () => {
  const submit = vi.fn()
  render(<PasswordSection {...runtime} username="alice" canChangePassword onSubmit={submit} />)
  fields('old password', 'new long password', 'different')
  fireEvent.click(screen.getByRole('button', { name: '保存新密码' }))
  expect(screen.getByRole('status').textContent).toContain('不一致')
  fields('old password', 'short')
  fireEvent.click(screen.getByRole('button', { name: '保存新密码' }))
  expect(screen.getByRole('status').textContent).toContain('12 个字符')
  expect(submit).not.toHaveBeenCalled()
})
it('blocks repeat submissions and clears secrets after an error while retaining feedback', async () => {
  let finish!: (result: string) => void
  const submit = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
  render(<PasswordSection {...runtime} username="alice" canChangePassword onSubmit={submit} />)
  fields('old password', 'new long password')
  fireEvent.click(screen.getByRole('button', { name: '保存新密码' }))
  expect(screen.getByRole('button', { name: '正在保存…' }).hasAttribute('disabled')).toBe(true)
  finish('current-password-invalid')
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('当前密码不正确') })
  expect(screen.getByLabelText<HTMLInputElement>('当前密码').value).toBe('')
  expect(submit).toHaveBeenCalledOnce()
})
it('clears the form without sending and reports successful change', async () => {
  const submit = vi.fn(async () => 'changed')
  render(<PasswordSection {...runtime} username="alice" canChangePassword onSubmit={submit} />)
  fields('old password', 'new long password')
  fireEvent.click(screen.getByRole('button', { name: '清空' }))
  expect(submit).not.toHaveBeenCalled()
  fields('old password', 'new long password')
  fireEvent.click(screen.getByRole('button', { name: '保存新密码' }))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('密码已更新') })
})
