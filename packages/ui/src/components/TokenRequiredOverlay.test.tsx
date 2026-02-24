import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import TokenRequiredOverlay from './TokenRequiredOverlay'

const mockSend = vi.fn()

vi.mock('../App', () => ({
  useAdapter: () => ({
    send: mockSend,
    onMessage: vi.fn(() => vi.fn()),
    capabilities: { canChangePanelLocation: false },
  }),
}))

describe('TokenRequiredOverlay', () => {
  beforeEach(() => {
    mockSend.mockClear()
  })

  it('renders "Provide token" button initially', () => {
    render(<TokenRequiredOverlay />)
    expect(screen.getByRole('button', { name: /provide token/i })).toBeInTheDocument()
  })

  it('calls adapter.send with requestToken when button is clicked', async () => {
    const user = userEvent.setup()
    render(<TokenRequiredOverlay />)
    await user.click(screen.getByRole('button', { name: /provide token/i }))
    expect(mockSend).toHaveBeenCalledWith({ type: 'requestToken' })
  })

  it('replaces button with "Waiting for token…" text after clicking', async () => {
    const user = userEvent.setup()
    render(<TokenRequiredOverlay />)
    await user.click(screen.getByRole('button', { name: /provide token/i }))
    expect(screen.getByText(/Waiting for token/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /provide token/i })).not.toBeInTheDocument()
  })
})
