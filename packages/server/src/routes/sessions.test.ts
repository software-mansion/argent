import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { EventEmitter } from 'node:events'
import { createSessionsRouter } from './sessions'
import type { Config, Session } from '../types/index'

// ── Mock factory helpers ──────────────────────────────────────────────────────

function makeMockProc(overrides: Partial<{
  tokenState: 'no_token' | 'validating' | 'valid' | 'invalid'
  streamUrl: string
  state: 'starting' | 'ready' | 'dead'
  screenshot: ReturnType<typeof vi.fn>
  startRecording: ReturnType<typeof vi.fn>
  stopAndSaveRecording: ReturnType<typeof vi.fn>
  saveReplay: ReturnType<typeof vi.fn>
  updateToken: ReturnType<typeof vi.fn>
  setReplay: ReturnType<typeof vi.fn>
  setShowTouches: ReturnType<typeof vi.fn>
  touch: ReturnType<typeof vi.fn>
  key: ReturnType<typeof vi.fn>
  button: ReturnType<typeof vi.fn>
  rotate: ReturnType<typeof vi.fn>
  paste: ReturnType<typeof vi.fn>
  scroll: ReturnType<typeof vi.fn>
  currentSettings: { replay: boolean; showTouches: boolean }
}> = {}) {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    tokenState: overrides.tokenState ?? 'valid',
    streamUrl: overrides.streamUrl ?? 'http://127.0.0.1:9000/stream.mjpeg',
    state: overrides.state ?? 'ready',
    currentSettings: overrides.currentSettings ?? { replay: true, showTouches: true },
    screenshot: overrides.screenshot ?? vi.fn().mockResolvedValue({ url: 'http://host/shot.png', filePath: '/tmp/shot.png' }),
    startRecording: overrides.startRecording ?? vi.fn(),
    stopAndSaveRecording: overrides.stopAndSaveRecording ?? vi.fn().mockResolvedValue({ url: 'http://host/rec.mp4', filePath: '/tmp/rec.mp4', durationSecs: 'full' }),
    saveReplay: overrides.saveReplay ?? vi.fn().mockResolvedValue([{ url: 'http://host/replay-5s.mp4', filePath: '/tmp/replay-5s.mp4', durationSecs: 5 }]),
    updateToken: overrides.updateToken ?? vi.fn(),
    setReplay: overrides.setReplay ?? vi.fn(),
    setShowTouches: overrides.setShowTouches ?? vi.fn(),
    touch: overrides.touch ?? vi.fn(),
    key: overrides.key ?? vi.fn(),
    button: overrides.button ?? vi.fn(),
    rotate: overrides.rotate ?? vi.fn(),
    paste: overrides.paste ?? vi.fn(),
    scroll: overrides.scroll ?? vi.fn(),
    kill: vi.fn(),
  })
}

type MockProc = ReturnType<typeof makeMockProc>

function makeInternalSession(id: string, proc: MockProc) {
  return { id, udid: 'UDID-1234', process: proc, createdAt: new Date('2024-01-01') }
}

function makePublicSession(id: string): Session {
  return {
    id,
    udid: 'UDID-1234',
    streamUrl: 'http://127.0.0.1:9000/stream.mjpeg',
    state: 'ready',
    createdAt: '2024-01-01T00:00:00.000Z',
    settings: { replay: true, showTouches: true },
  }
}

function makeMockManager(proc: MockProc, sessionId = 'session-123') {
  const internal = makeInternalSession(sessionId, proc)
  const publicSession = makePublicSession(sessionId)
  return {
    get: vi.fn((id: string) => (id === sessionId ? internal : undefined)),
    list: vi.fn(() => [publicSession]),
    create: vi.fn().mockResolvedValue(publicSession),
    destroy: vi.fn((id: string) => id === sessionId),
    toPublic: vi.fn(() => publicSession),
    destroyAll: vi.fn(),
  }
}

const defaultConfig: Config = { port: 3000, replay: true, showTouches: true }

function makeApp(proc: MockProc, sessionId = 'session-123') {
  const manager = makeMockManager(proc, sessionId)
  const app = express()
  app.use(express.json())
  app.use('/sessions', createSessionsRouter(manager as any, defaultConfig))
  return { app, manager, proc }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('sessions router', () => {
  let proc: MockProc

  beforeEach(() => {
    proc = makeMockProc()
  })

  // ── POST /sessions ──────────────────────────────────────────────────────────

  describe('POST /sessions', () => {
    it('returns 400 when udid is missing', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions').send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/udid/)
    })

    it('returns 201 with session body on success', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions').send({ udid: 'UDID-1234' })
      expect(res.status).toBe(201)
      expect(res.body.id).toBe('session-123')
    })

    it('returns 500 when create throws', async () => {
      const { app, manager } = makeApp(proc)
      manager.create.mockRejectedValueOnce(new Error('spawn failed'))
      const res = await request(app).post('/sessions').send({ udid: 'UDID-1234' })
      expect(res.status).toBe(500)
    })
  })

  // ── GET /sessions ───────────────────────────────────────────────────────────

  describe('GET /sessions', () => {
    it('returns array of sessions', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).get('/sessions')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect(res.body[0].id).toBe('session-123')
    })
  })

  // ── GET /sessions/:id ───────────────────────────────────────────────────────

  describe('GET /sessions/:id', () => {
    it('returns session JSON', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).get('/sessions/session-123')
      expect(res.status).toBe(200)
      expect(res.body.id).toBe('session-123')
    })

    it('returns 404 for unknown id', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).get('/sessions/unknown-id')
      expect(res.status).toBe(404)
    })
  })

  // ── DELETE /sessions/:id ────────────────────────────────────────────────────

  describe('DELETE /sessions/:id', () => {
    it('returns 204 on success', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).delete('/sessions/session-123')
      expect(res.status).toBe(204)
    })

    it('returns 404 for unknown id', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).delete('/sessions/unknown-id')
      expect(res.status).toBe(404)
    })
  })

  // ── PUT /sessions/:id/token ─────────────────────────────────────────────────

  describe('PUT /sessions/:id/token', () => {
    it('returns 400 when token is missing', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).put('/sessions/session-123/token').send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/token/)
    })

    it('calls updateToken() and returns success', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).put('/sessions/session-123/token').send({ token: 'new.jwt' })
      expect(res.status).toBe(200)
      expect(proc.updateToken).toHaveBeenCalledWith('new.jwt')
    })

    it('returns 404 for unknown id', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).put('/sessions/unknown-id/token').send({ token: 'jwt' })
      expect(res.status).toBe(404)
    })
  })

  // ── PUT /sessions/:id/settings ──────────────────────────────────────────────

  describe('PUT /sessions/:id/settings', () => {
    it('calls setReplay when replay is in body', async () => {
      const { app } = makeApp(proc)
      await request(app).put('/sessions/session-123/settings').send({ replay: false })
      expect(proc.setReplay).toHaveBeenCalledWith(false)
    })

    it('calls setShowTouches when showTouches is in body', async () => {
      const { app } = makeApp(proc)
      await request(app).put('/sessions/session-123/settings').send({ showTouches: false })
      expect(proc.setShowTouches).toHaveBeenCalledWith(false)
    })
  })

  // ── POST /sessions/:id/screenshot ───────────────────────────────────────────

  describe('POST /sessions/:id/screenshot', () => {
    it('returns 403 when tokenState is "no_token"', async () => {
      const p = makeMockProc({ tokenState: 'no_token' })
      const { app } = makeApp(p)
      const res = await request(app).post('/sessions/session-123/screenshot').send({})
      expect(res.status).toBe(403)
      expect(res.body.error).toMatch(/Token required/)
    })

    it('returns 403 when tokenState is "invalid"', async () => {
      const p = makeMockProc({ tokenState: 'invalid' })
      const { app } = makeApp(p)
      const res = await request(app).post('/sessions/session-123/screenshot').send({})
      expect(res.status).toBe(403)
    })

    it('proceeds when tokenState is "validating"', async () => {
      const p = makeMockProc({ tokenState: 'validating' })
      const { app } = makeApp(p)
      const res = await request(app).post('/sessions/session-123/screenshot').send({})
      expect(res.status).toBe(200)
      expect(res.body.url).toBeDefined()
    })

    it('returns 200 with url and filePath on success', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions/session-123/screenshot').send({})
      expect(res.status).toBe(200)
      expect(res.body.url).toBe('http://host/shot.png')
      expect(res.body.filePath).toBe('/tmp/shot.png')
    })

    it('returns 500 when process.screenshot() rejects', async () => {
      const p = makeMockProc({ screenshot: vi.fn().mockRejectedValue(new Error('timed out')) })
      const { app } = makeApp(p)
      const res = await request(app).post('/sessions/session-123/screenshot').send({})
      expect(res.status).toBe(500)
    })

    it('returns 404 for unknown session', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions/unknown-id/screenshot').send({})
      expect(res.status).toBe(404)
    })
  })

  // ── POST /sessions/:id/record/start ─────────────────────────────────────────

  describe('POST /sessions/:id/record/start', () => {
    it('is NOT gated by tokenState and calls startRecording()', async () => {
      const p = makeMockProc({ tokenState: 'no_token' })
      const { app } = makeApp(p)
      const res = await request(app).post('/sessions/session-123/record/start').send({})
      expect(res.status).toBe(200)
      expect(p.startRecording).toHaveBeenCalled()
    })
  })

  // ── POST /sessions/:id/record/stop ──────────────────────────────────────────

  describe('POST /sessions/:id/record/stop', () => {
    it('returns 403 when tokenState is "no_token"', async () => {
      const p = makeMockProc({ tokenState: 'no_token' })
      const { app } = makeApp(p)
      const res = await request(app).post('/sessions/session-123/record/stop').send({})
      expect(res.status).toBe(403)
    })

    it('returns 200 with video result on success', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions/session-123/record/stop').send({})
      expect(res.status).toBe(200)
      expect(res.body.url).toBe('http://host/rec.mp4')
    })
  })

  // ── POST /sessions/:id/replay ───────────────────────────────────────────────

  describe('POST /sessions/:id/replay', () => {
    it('returns 403 when tokenState is "no_token"', async () => {
      const p = makeMockProc({ tokenState: 'no_token' })
      const { app } = makeApp(p)
      const res = await request(app).post('/sessions/session-123/replay').send({})
      expect(res.status).toBe(403)
    })

    it('returns 403 when tokenState is "invalid"', async () => {
      const p = makeMockProc({ tokenState: 'invalid' })
      const { app } = makeApp(p)
      const res = await request(app).post('/sessions/session-123/replay').send({})
      expect(res.status).toBe(403)
    })

    it('returns 409 when replay is disabled for the session', async () => {
      const p = makeMockProc({ currentSettings: { replay: false, showTouches: true } })
      const { app } = makeApp(p)
      const res = await request(app).post('/sessions/session-123/replay').send({})
      expect(res.status).toBe(409)
    })

    it('returns 200 with array of replay results on success', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions/session-123/replay').send({ durations: [5] })
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect(res.body[0].durationSecs).toBe(5)
    })
  })

  // ── Input routes ─────────────────────────────────────────────────────────────

  describe('POST /sessions/:id/input/touch', () => {
    it('returns 400 when type or points are missing', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions/session-123/input/touch').send({ type: 'Down' })
      expect(res.status).toBe(400)
    })

    it('returns 200 and calls touch() on success', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions/session-123/input/touch').send({ type: 'Down', points: [{ x: 0.5, y: 0.5 }] })
      expect(res.status).toBe(200)
      expect(proc.touch).toHaveBeenCalledWith('Down', [{ x: 0.5, y: 0.5 }])
    })
  })

  describe('POST /sessions/:id/input/key', () => {
    it('returns 400 when direction or keyCode missing', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions/session-123/input/key').send({ direction: 'Down' })
      expect(res.status).toBe(400)
    })

    it('returns 200 and calls key()', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions/session-123/input/key').send({ direction: 'Down', keyCode: 13 })
      expect(res.status).toBe(200)
      expect(proc.key).toHaveBeenCalledWith('Down', 13)
    })
  })

  describe('POST /sessions/:id/input/button', () => {
    it('returns 400 when direction or button missing', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions/session-123/input/button').send({ direction: 'Down' })
      expect(res.status).toBe(400)
    })

    it('returns 200 and calls button()', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions/session-123/input/button').send({ direction: 'Down', button: 'home' })
      expect(res.status).toBe(200)
      expect(proc.button).toHaveBeenCalledWith('Down', 'home')
    })
  })

  describe('POST /sessions/:id/input/rotate', () => {
    it('returns 400 when orientation missing', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions/session-123/input/rotate').send({})
      expect(res.status).toBe(400)
    })

    it('returns 200 and calls rotate()', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions/session-123/input/rotate').send({ orientation: 'LandscapeLeft' })
      expect(res.status).toBe(200)
      expect(proc.rotate).toHaveBeenCalledWith('LandscapeLeft')
    })
  })

  describe('POST /sessions/:id/input/paste', () => {
    it('returns 400 when text is undefined', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions/session-123/input/paste').send({})
      expect(res.status).toBe(400)
    })

    it('returns 200 and calls paste()', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions/session-123/input/paste').send({ text: 'hello' })
      expect(res.status).toBe(200)
      expect(proc.paste).toHaveBeenCalledWith('hello')
    })
  })

  describe('POST /sessions/:id/input/scroll', () => {
    it('returns 400 when any scroll param is missing', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions/session-123/input/scroll').send({ x: 0.5, y: 0.5 })
      expect(res.status).toBe(400)
    })

    it('returns 200 and calls scroll()', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).post('/sessions/session-123/input/scroll').send({ x: 0.5, y: 0.5, deltaX: 0, deltaY: -100 })
      expect(res.status).toBe(200)
      expect(proc.scroll).toHaveBeenCalledWith(0.5, 0.5, 0, -100)
    })
  })

  // ── GET /sessions/:id/events (SSE) ───────────────────────────────────────────

  describe('GET /sessions/:id/events', () => {
    it('returns 404 for unknown session', async () => {
      const { app } = makeApp(proc)
      const res = await request(app).get('/sessions/unknown-id/events')
      expect(res.status).toBe(404)
    })

    it('sets SSE headers', async () => {
      const { app } = makeApp(proc)
      const server = await new Promise<http.Server>((resolve) => {
        const s = app.listen(0, () => resolve(s))
      })
      const port = (server.address() as AddressInfo).port

      await new Promise<void>((resolve, reject) => {
        const req = http.request({ port, path: '/sessions/session-123/events' }, (res) => {
          expect(res.headers['content-type']).toMatch(/text\/event-stream/)
          expect(res.headers['cache-control']).toBe('no-cache')
          req.destroy()
          server.close()
          resolve()
        })
        req.on('error', () => { server.close(); resolve() })
        req.end()
      })
    })

    it('forwards events from the process', async () => {
      const { app } = makeApp(proc)
      const server = await new Promise<http.Server>((resolve) => {
        const s = app.listen(0, () => resolve(s))
      })
      const port = (server.address() as AddressInfo).port

      await new Promise<void>((resolve, reject) => {
        const req = http.request({ port, path: '/sessions/session-123/events' }, (res) => {
          let data = ''
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString()
            if (data.includes('fps_report')) {
              expect(data).toContain('"fps":30')
              req.destroy()
              server.close()
              resolve()
            }
          })
          res.on('error', () => { server.close(); resolve() })
        })
        req.on('error', () => { server.close(); resolve() })
        req.end()

        // Emit event after connection is established
        setTimeout(() => {
          proc.emit('fps_report', { fps: 30, received: 60, dropped: 0, timestamp: 100 })
        }, 50)
      })
    })
  })
})
