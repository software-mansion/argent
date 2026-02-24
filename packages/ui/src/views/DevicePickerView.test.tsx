import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import DevicePickerView from './DevicePickerView'
import type { ApiClient, Simulator, Session } from '../api/client'

function makeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listRunningSimulators: vi.fn().mockResolvedValue([]),
    listSimulators: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    bootSimulator: vi.fn(),
    destroySession: vi.fn(),
    updateToken: vi.fn(),
    touch: vi.fn(),
    scroll: vi.fn(),
    button: vi.fn(),
    rotate: vi.fn(),
    paste: vi.fn(),
    screenshot: vi.fn(),
    eventsUrl: vi.fn(),
    streamUrl: vi.fn(),
    ...overrides,
  } as unknown as ApiClient
}

describe('DevicePickerView', () => {
  it('shows a booted simulator in the list', async () => {
    const sim: Simulator = { udid: 'abc-123', name: 'iPhone 15', state: 'Booted', runtime: 'iOS 17.0' }
    const api = makeApi({ listRunningSimulators: vi.fn().mockResolvedValue([sim]) })
    render(
      <DevicePickerView api={api} loading={false} onStarting={vi.fn()} onSessionCreated={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('iPhone 15')).toBeInTheDocument())
    expect(screen.getByText(/Booted/)).toBeInTheDocument()
  })

  it('shows "No simulators found" for an empty list', async () => {
    const api = makeApi({ listRunningSimulators: vi.fn().mockResolvedValue([]) })
    render(
      <DevicePickerView api={api} loading={false} onStarting={vi.fn()} onSessionCreated={vi.fn()} />
    )
    await waitFor(() =>
      expect(screen.getByText(/No simulators found/i)).toBeInTheDocument()
    )
  })

  it('shows error message when API rejects', async () => {
    const api = makeApi({
      listRunningSimulators: vi.fn().mockRejectedValue(new Error('Network error')),
    })
    render(
      <DevicePickerView api={api} loading={false} onStarting={vi.fn()} onSessionCreated={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText(/Network error/)).toBeInTheDocument())
  })

  it('renders the list from a bare array — regression for {simulators} shape mismatch', async () => {
    // Before the fix, listRunningSimulators was typed as { simulators: Simulator[] }
    // and the component accessed r.simulators, which was undefined on a bare array.
    // This test confirms the fixed component works with a plain Simulator[].
    const sims: Simulator[] = [
      { udid: 'fix-123', name: 'Regression Phone', state: 'Booted', runtime: 'iOS 17.0' },
    ]
    const api = makeApi({ listRunningSimulators: vi.fn().mockResolvedValue(sims) })
    render(
      <DevicePickerView api={api} loading={false} onStarting={vi.fn()} onSessionCreated={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Regression Phone')).toBeInTheDocument())
    // Confirm no "No simulators found" — the map did not receive undefined
    expect(screen.queryByText(/No simulators found/i)).not.toBeInTheDocument()
  })

  it('clicking a booted device calls onStarting and onSessionCreated', async () => {
    const user = userEvent.setup()
    const sim: Simulator = { udid: 'abc-123', name: 'iPhone 15', state: 'Booted', runtime: 'iOS 17.0' }
    const session: Session = {
      id: 'sess-1',
      udid: 'abc-123',
      state: 'running',
      streamUrl: 'http://127.0.0.1:9000/stream.mjpeg',
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    const onStarting = vi.fn()
    const onSessionCreated = vi.fn()
    const api = makeApi({
      listRunningSimulators: vi.fn().mockResolvedValue([sim]),
      createSession: vi.fn().mockResolvedValue(session),
    })
    render(
      <DevicePickerView
        api={api}
        loading={false}
        onStarting={onStarting}
        onSessionCreated={onSessionCreated}
      />
    )
    await waitFor(() => screen.getByText('iPhone 15'))
    await user.click(screen.getByText('iPhone 15'))
    expect(onStarting).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(onSessionCreated).toHaveBeenCalledWith('sess-1', 'http://127.0.0.1:9000/stream.mjpeg')
    )
  })
})
