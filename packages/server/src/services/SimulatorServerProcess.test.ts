import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'

// ── Fake child process factory ────────────────────────────────────────────────

function makeFakeProc() {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new PassThrough()
  const emitter = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    stdin: PassThrough
    pid: number
    kill: ReturnType<typeof vi.fn>
  }
  ;(emitter as any).stdout = stdout
  ;(emitter as any).stderr = stderr
  ;(emitter as any).stdin = stdin
  ;(emitter as any).pid = 12345
  // NOTE: kill is a no-op — tests that need process exit emit it directly on fakeProc
  ;(emitter as any).kill = vi.fn()
  return emitter
}

// ── Mock node:child_process before importing the module under test ────────────

let fakeProc: ReturnType<typeof makeFakeProc>

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => fakeProc),
}))

// Import AFTER mock is set up
import { SimulatorServerProcess } from './SimulatorServerProcess'

// ── Helpers ───────────────────────────────────────────────────────────────────

function pushLine(line: string) {
  fakeProc.stdout.push(line + '\n')
}

function nextTick() {
  return new Promise<void>((resolve) => process.nextTick(resolve))
}

// Allow readline to process buffered lines
async function flush() {
  await nextTick()
  await nextTick()
  await nextTick()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SimulatorServerProcess', () => {
  beforeEach(() => {
    fakeProc = makeFakeProc()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ── Token state initialization ──────────────────────────────────────────────

  it('starts with tokenState "no_token" when no token option is given', () => {
    const proc = new SimulatorServerProcess({ udid: 'test-udid', replay: false, showTouches: false })
    expect(proc.tokenState).toBe('no_token')
    proc.kill()
  })

  it('starts with tokenState "validating" when token option is given', () => {
    const proc = new SimulatorServerProcess({ udid: 'test-udid', token: 'jwt.token.here', replay: false, showTouches: false })
    expect(proc.tokenState).toBe('validating')
    proc.kill()
  })

  // ── stream_ready ────────────────────────────────────────────────────────────

  it('stream_ready: sets state to ready, resolves waitForReady(), sends pointer + replay commands', async () => {
    const writtenCommands: string[] = []
    fakeProc.stdin.on('data', (chunk: Buffer) => writtenCommands.push(chunk.toString()))

    const proc = new SimulatorServerProcess({ udid: 'test-udid', replay: true, showTouches: true })
    const readyPromise = proc.waitForReady()

    pushLine('stream_ready http://127.0.0.1:9000/stream.mjpeg')
    await flush()

    const url = await readyPromise
    expect(url).toBe('http://127.0.0.1:9000/stream.mjpeg')
    expect(proc.state).toBe('ready')
    expect(proc.streamUrl).toBe('http://127.0.0.1:9000/stream.mjpeg')

    expect(writtenCommands.join('')).toContain('pointer show true')
    expect(writtenCommands.join('')).toContain('video replay start')
    proc.kill()
  })

  it('stream_ready: does NOT send replay start when replay=false', async () => {
    const writtenCommands: string[] = []
    fakeProc.stdin.on('data', (chunk: Buffer) => writtenCommands.push(chunk.toString()))

    const proc = new SimulatorServerProcess({ udid: 'test-udid', replay: false, showTouches: false })
    proc.waitForReady().catch(() => {})

    pushLine('stream_ready http://127.0.0.1:9000/stream.mjpeg')
    await flush()

    const combined = writtenCommands.join('')
    expect(combined).not.toContain('video replay start')
    proc.kill()
  })

  // ── token_valid / token_invalid ─────────────────────────────────────────────

  it('token_valid: sets tokenState to "valid" and emits event', async () => {
    const proc = new SimulatorServerProcess({ udid: 'test-udid', token: 'jwt', replay: false, showTouches: false })

    const events: unknown[] = []
    proc.on('token_valid', (d) => events.push(d))

    pushLine('token_valid pro')
    await flush()

    expect(proc.tokenState).toBe('valid')
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ plan: 'pro' })
    proc.kill()
  })

  it('token_invalid: sets tokenState to "invalid" and emits event', async () => {
    const proc = new SimulatorServerProcess({ udid: 'test-udid', token: 'jwt', replay: false, showTouches: false })

    const events: unknown[] = []
    proc.on('token_invalid', (d) => events.push(d))

    pushLine('token_invalid fingerprint_mismatch')
    await flush()

    expect(proc.tokenState).toBe('invalid')
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ reason: 'fingerprint_mismatch' })
    proc.kill()
  })

  it('token_invalid: captures multi-word reason', async () => {
    const proc = new SimulatorServerProcess({ udid: 'test-udid', token: 'jwt', replay: false, showTouches: false })
    proc.on('token_invalid', () => {})

    pushLine('token_invalid some reason with spaces')
    await flush()

    expect(proc.tokenState).toBe('invalid')
    proc.kill()
  })

  // ── updateToken() ───────────────────────────────────────────────────────────

  it('updateToken: resets tokenState to "validating" and sends command', async () => {
    const writtenCommands: string[] = []
    fakeProc.stdin.on('data', (chunk: Buffer) => writtenCommands.push(chunk.toString()))

    const proc = new SimulatorServerProcess({ udid: 'test-udid', replay: false, showTouches: false })
    // Simulate token_valid so state is "valid" first
    pushLine('token_valid pro')
    await flush()
    expect(proc.tokenState).toBe('valid')

    proc.updateToken('new.jwt.token')
    expect(proc.tokenState).toBe('validating')
    expect(writtenCommands.join('')).toContain('token new.jwt.token')
    proc.kill()
  })

  // ── fps_report ──────────────────────────────────────────────────────────────

  it('fps_report: emits fps_report event with parsed data', async () => {
    const proc = new SimulatorServerProcess({ udid: 'test-udid', replay: false, showTouches: false })

    const reports: unknown[] = []
    proc.on('fps_report', (d) => reports.push(d))

    pushLine('fps_report {"fps":60,"received":100,"dropped":2,"timestamp":1234567890}')
    await flush()

    expect(reports).toHaveLength(1)
    expect(reports[0]).toEqual({ fps: 60, received: 100, dropped: 2, timestamp: 1234567890 })
    proc.kill()
  })

  // ── screenshot_ready / screenshot_error ─────────────────────────────────────

  it('screenshot(): sends screenshot command and resolves on screenshot_ready', async () => {
    const writtenCommands: string[] = []
    fakeProc.stdin.on('data', (chunk: Buffer) => writtenCommands.push(chunk.toString()))

    const proc = new SimulatorServerProcess({ udid: 'test-udid', replay: false, showTouches: false })
    const screenshotPromise = proc.screenshot()

    await flush()
    // Extract the UUID from the written command
    const combined = writtenCommands.join('')
    const match = combined.match(/screenshot ([a-f0-9-]{36})/)
    expect(match).not.toBeNull()
    const id = match![1]!

    pushLine(`screenshot_ready ${id} http://127.0.0.1:9000/media/shot.png /tmp/shot.png`)
    await flush()

    const result = await screenshotPromise
    expect(result.url).toBe('http://127.0.0.1:9000/media/shot.png')
    expect(result.filePath).toBe('/tmp/shot.png')
    proc.kill()
  })

  it('screenshot(): rejects on screenshot_error', async () => {
    const writtenCommands: string[] = []
    fakeProc.stdin.on('data', (chunk: Buffer) => writtenCommands.push(chunk.toString()))

    const proc = new SimulatorServerProcess({ udid: 'test-udid', replay: false, showTouches: false })
    const screenshotPromise = proc.screenshot()

    await flush()
    const combined = writtenCommands.join('')
    const match = combined.match(/screenshot ([a-f0-9-]{36})/)
    const id = match![1]!

    pushLine(`screenshot_error ${id} Failed to capture`)
    await flush()

    await expect(screenshotPromise).rejects.toThrow('Failed to capture')
    proc.kill()
  })

  // ── video_ready (recording) ─────────────────────────────────────────────────

  it('video_ready recording: resolves stopAndSaveRecording promise', async () => {
    const proc = new SimulatorServerProcess({ udid: 'test-udid', replay: false, showTouches: false })
    const recordingPromise = proc.stopAndSaveRecording('Portrait')

    pushLine('video_ready recording http://127.0.0.1:9000/media/rec.mp4 /tmp/rec.mp4')
    await flush()

    const result = await recordingPromise
    expect(result.url).toBe('http://127.0.0.1:9000/media/rec.mp4')
    expect(result.filePath).toBe('/tmp/rec.mp4')
    proc.kill()
  })

  // ── video_ready (replay) ────────────────────────────────────────────────────

  it('video_ready replay: accumulates results and resolves saveReplay when count matches', async () => {
    const proc = new SimulatorServerProcess({ udid: 'test-udid', replay: true, showTouches: false })
    const replayPromise = proc.saveReplay('Portrait', [5, 10])

    pushLine('video_ready replay http://127.0.0.1:9000/media/replay-5s.mp4 /tmp/replay-5s.mp4')
    await flush()
    pushLine('video_ready replay http://127.0.0.1:9000/media/replay-10s.mp4 /tmp/replay-10s.mp4')
    await flush()

    const results = await replayPromise
    expect(results).toHaveLength(2)
    expect(results[0]!.durationSecs).toBe(5)
    expect(results[1]!.durationSecs).toBe(10)
    proc.kill()
  })

  // ── video_error (replay) ────────────────────────────────────────────────────

  it('video_error replay: rejects pending replay promise', async () => {
    const proc = new SimulatorServerProcess({ udid: 'test-udid', replay: true, showTouches: false })
    const replayPromise = proc.saveReplay('Portrait', [5])

    pushLine('video_error replay Replay buffer not available')
    await flush()

    await expect(replayPromise).rejects.toThrow('Replay buffer not available')
    proc.kill()
  })

  // ── Process exit ────────────────────────────────────────────────────────────

  it('process exit: sets state to "dead" and emits exit event', async () => {
    const proc = new SimulatorServerProcess({ udid: 'test-udid', replay: false, showTouches: false })
    // Suppress the unhandled rejection that readyReject would throw when exit fires
    proc.waitForReady().catch(() => {})

    const exitEvents: unknown[] = []
    proc.on('exit', (code) => exitEvents.push(code))

    fakeProc.emit('exit', 1)
    await flush()

    expect(proc.state).toBe('dead')
    expect(exitEvents).toContain(1)
    proc.kill()
  })
})
