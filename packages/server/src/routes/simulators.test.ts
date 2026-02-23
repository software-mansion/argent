import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createSimulatorsRouter } from './simulators'
import type { SimulatorInfo } from '../types/index'

// ── Mock factory ──────────────────────────────────────────────────────────────

const SIMULATORS: SimulatorInfo[] = [
  { udid: 'UDID-1', name: 'iPhone 15', state: 'Booted', deviceTypeId: 'dt1', runtimeId: 'rt1' },
  { udid: 'UDID-2', name: 'iPhone 14', state: 'Shutdown', deviceTypeId: 'dt2', runtimeId: 'rt1' },
]

function makeMockService() {
  return {
    listAll: vi.fn().mockResolvedValue(SIMULATORS),
    listRunning: vi.fn().mockResolvedValue([SIMULATORS[0]]),
    boot: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function makeApp() {
  const service = makeMockService()
  const app = express()
  app.use(express.json())
  app.use('/simulators', createSimulatorsRouter(service as any))
  return { app, service }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('simulators router', () => {
  let service: ReturnType<typeof makeMockService>
  let app: express.Express

  beforeEach(() => {
    ;({ app, service } = makeApp())
  })

  // ── GET /simulators ─────────────────────────────────────────────────────────

  describe('GET /simulators', () => {
    it('returns all simulators', async () => {
      const res = await request(app).get('/simulators')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect(res.body).toHaveLength(2)
      expect(res.body[0].udid).toBe('UDID-1')
    })

    it('returns 500 when listAll throws', async () => {
      service.listAll.mockRejectedValueOnce(new Error('xcrun failed'))
      const res = await request(app).get('/simulators')
      expect(res.status).toBe(500)
      expect(res.body.error).toMatch(/xcrun failed/)
    })
  })

  // ── GET /simulators/running ─────────────────────────────────────────────────

  describe('GET /simulators/running', () => {
    it('returns only running simulators', async () => {
      const res = await request(app).get('/simulators/running')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect(res.body).toHaveLength(1)
      expect(res.body[0].state).toBe('Booted')
    })

    it('returns 500 when listRunning throws', async () => {
      service.listRunning.mockRejectedValueOnce(new Error('no devices'))
      const res = await request(app).get('/simulators/running')
      expect(res.status).toBe(500)
    })
  })

  // ── POST /simulators/:udid/boot ─────────────────────────────────────────────

  describe('POST /simulators/:udid/boot', () => {
    it('calls service.boot(udid) and returns success', async () => {
      const res = await request(app).post('/simulators/UDID-1/boot')
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(service.boot).toHaveBeenCalledWith('UDID-1')
    })

    it('returns 500 when boot throws', async () => {
      service.boot.mockRejectedValueOnce(new Error('already booted'))
      const res = await request(app).post('/simulators/UDID-1/boot')
      expect(res.status).toBe(500)
      expect(res.body.error).toMatch(/already booted/)
    })
  })

  // ── POST /simulators/:udid/shutdown ─────────────────────────────────────────

  describe('POST /simulators/:udid/shutdown', () => {
    it('calls service.shutdown(udid) and returns success', async () => {
      const res = await request(app).post('/simulators/UDID-1/shutdown')
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(service.shutdown).toHaveBeenCalledWith('UDID-1')
    })

    it('returns 500 when shutdown throws', async () => {
      service.shutdown.mockRejectedValueOnce(new Error('not running'))
      const res = await request(app).post('/simulators/UDID-1/shutdown')
      expect(res.status).toBe(500)
    })
  })
})
