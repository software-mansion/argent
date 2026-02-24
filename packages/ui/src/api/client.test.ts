import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createClient } from './client'
import type { Simulator, Session } from './client'

describe('createClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  function mockFetch(data: unknown, status = 200) {
    const ok = status >= 200 && status < 300
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok,
      status,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(String(data)),
    })
  }

  it('listRunningSimulators returns a bare array', async () => {
    const simulators: Simulator[] = [
      { udid: 'abc-123', name: 'iPhone 15', state: 'Booted', runtime: 'iOS 17.0' },
    ]
    mockFetch(simulators)
    const client = createClient('http://localhost:3000')
    const result = await client.listRunningSimulators()
    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual(simulators)
  })

  it('listSimulators returns a bare array', async () => {
    const simulators: Simulator[] = [
      { udid: 'abc-123', name: 'iPhone 15', state: 'Shutdown', runtime: 'iOS 17.0' },
    ]
    mockFetch(simulators)
    const client = createClient('http://localhost:3000')
    const result = await client.listSimulators()
    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual(simulators)
  })

  it('createSession POSTs correct body and returns Session', async () => {
    const session: Session = {
      id: 'sess-1',
      udid: 'abc-123',
      state: 'running',
      streamUrl: 'http://127.0.0.1:9000/stream.mjpeg',
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    mockFetch(session)
    const client = createClient('http://localhost:3000')
    const result = await client.createSession({ udid: 'abc-123', token: 'jwt-token' })
    expect(result).toEqual(session)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/sessions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ udid: 'abc-123', token: 'jwt-token' }),
      })
    )
  })

  it('throws on non-2xx responses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    })
    const client = createClient('http://localhost:3000')
    await expect(client.listSimulators()).rejects.toThrow('404')
  })

  it('strips trailing slash from base URL', async () => {
    mockFetch([])
    const client = createClient('http://localhost:3000/')
    await client.listSimulators()
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/simulators',
      expect.anything()
    )
  })
})
