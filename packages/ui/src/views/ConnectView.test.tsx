import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import ConnectView from './ConnectView'

describe('ConnectView', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('pre-fills the input from localStorage', () => {
    localStorage.setItem('rl-serverUrl', 'http://my-server:4000')
    render(<ConnectView onConnect={vi.fn()} />)
    expect(screen.getByRole<HTMLInputElement>('textbox')).toHaveValue('http://my-server:4000')
  })

  it('defaults to http://localhost:3000 when localStorage is empty', () => {
    render(<ConnectView onConnect={vi.fn()} />)
    expect(screen.getByRole<HTMLInputElement>('textbox')).toHaveValue('http://localhost:3000')
  })

  it('calls onConnect with the trimmed URL on submit', async () => {
    const user = userEvent.setup()
    const onConnect = vi.fn()
    render(<ConnectView onConnect={onConnect} />)
    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, 'http://localhost:3000  ')
    await user.click(screen.getByRole('button', { name: /connect/i }))
    expect(onConnect).toHaveBeenCalledWith('http://localhost:3000')
  })

  it('does not call onConnect for whitespace-only input', async () => {
    const user = userEvent.setup()
    const onConnect = vi.fn()
    // Render with a non-default initial URL so we can clear it to spaces
    localStorage.setItem('rl-serverUrl', 'http://x.com')
    render(<ConnectView onConnect={onConnect} />)
    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, '   ')
    // Bypass HTML5 url validation by submitting the form directly
    const form = input.closest('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(onConnect).not.toHaveBeenCalled()
  })
})
