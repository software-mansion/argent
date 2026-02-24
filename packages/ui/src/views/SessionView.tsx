import { useEffect, useState, useRef } from 'react'
import type { ApiClient, Orientation } from '../api/client'
import DeviceScreen from '../components/DeviceScreen'
import TokenRequiredOverlay from '../components/TokenRequiredOverlay'
import { useAdapter } from '../App'

interface FpsReport {
  fps: number
  received: number
  dropped: number
  timestamp: number
}

interface SessionViewProps {
  api: ApiClient
  sessionId: string
  streamUrl: string
  serverUrl: string
  token?: string
  tokenNeeded: boolean
  onSessionEnded: () => void
  onTokenNeeded: () => void
}

const ORIENTATIONS: Orientation[] = [
  'Portrait',
  'LandscapeLeft',
  'PortraitUpsideDown',
  'LandscapeRight',
]

export default function SessionView({
  api,
  sessionId,
  streamUrl,
  serverUrl,
  token,
  tokenNeeded,
  onSessionEnded,
  onTokenNeeded,
}: SessionViewProps) {
  const adapter = useAdapter()
  const [fps, setFps] = useState<number | null>(null)
  const [orientationIdx, setOrientationIdx] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const panelLocationRef = useRef<'left' | 'right' | 'bottom'>('left')

  // Push token to server whenever host provides one
  useEffect(() => {
    if (!token) return
    api.updateToken(sessionId, token).catch(() => {})
  }, [api, sessionId, token])

  // SSE connection
  useEffect(() => {
    const eventsUrl = api.eventsUrl(sessionId)
    const es = new EventSource(eventsUrl)

    es.addEventListener('fps_report', (e) => {
      const data = JSON.parse(e.data) as FpsReport
      setFps(data.fps)
    })

    es.addEventListener('exit', () => {
      es.close()
      onSessionEnded()
    })

    es.onerror = () => {
      // SSE will auto-reconnect; just note the error
      setError('Stream connection lost — reconnecting…')
    }

    return () => es.close()
  }, [api, sessionId, onSessionEnded])

  async function handleRotate() {
    const nextIdx = (orientationIdx + 1) % ORIENTATIONS.length
    setOrientationIdx(nextIdx)
    try {
      await api.rotate(sessionId, ORIENTATIONS[nextIdx])
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleScreenshot() {
    try {
      await api.screenshot(sessionId)
    } catch (e) {
      const msg = String(e)
      if (msg.includes('403') || msg.includes('token')) {
        onTokenNeeded()
      } else {
        setError(msg)
      }
    }
  }

  async function handleDestroy() {
    try {
      await api.destroySession(sessionId)
    } finally {
      onSessionEnded()
    }
  }

  function handleMovePanelLocation() {
    const cycle = { left: 'right', right: 'bottom', bottom: 'left' } as const
    panelLocationRef.current = cycle[panelLocationRef.current]
    adapter.send({ type: 'setPanelLocation', location: panelLocationRef.current })
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden relative">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-rl-border bg-rl-surface shrink-0">
        <button
          onClick={handleRotate}
          title="Rotate"
          className="p-1 rounded text-rl-fg-muted hover:text-rl-fg hover:bg-rl-bg transition-colors"
        >
          <RotateIcon />
        </button>

        <button
          onClick={handleScreenshot}
          title="Screenshot"
          className="p-1 rounded text-rl-fg-muted hover:text-rl-fg hover:bg-rl-bg transition-colors"
        >
          <CameraIcon />
        </button>

        <div className="flex-1" />

        {adapter.capabilities.canChangePanelLocation && (
          <button
            onClick={handleMovePanelLocation}
            title="Move panel"
            className="p-1 rounded text-rl-fg-muted hover:text-rl-fg hover:bg-rl-bg transition-colors"
          >
            <MoveIcon />
          </button>
        )}

        <button
          onClick={handleDestroy}
          title="End session"
          className="p-1 rounded text-rl-fg-muted hover:text-rl-danger hover:bg-rl-bg transition-colors"
        >
          <StopIcon />
        </button>
      </div>

      {error && (
        <div className="text-xs text-rl-danger bg-rl-surface px-3 py-1 border-b border-rl-border shrink-0">
          {error}
          <button
            className="ml-2 underline"
            onClick={() => setError(null)}
          >
            dismiss
          </button>
        </div>
      )}

      {/* Device screen — fills remaining space */}
      <div className="flex-1 flex items-center justify-center overflow-hidden p-2">
        <DeviceScreen
          streamUrl={streamUrl}
          sessionId={sessionId}
          serverUrl={serverUrl}
          api={api}
        />
      </div>

      {/* Status bar */}
      <div className="flex items-center px-3 py-1 border-t border-rl-border bg-rl-surface text-xs text-rl-fg-muted shrink-0">
        <span className="flex-1 truncate">Session: {sessionId}</span>
        {fps !== null && (
          <span className="ml-2 tabular-nums">{fps} fps</span>
        )}
      </div>

      {/* Token needed overlay */}
      {tokenNeeded && <TokenRequiredOverlay />}
    </div>
  )
}

// ── Icons (inline SVG) ─────────────────────────────────────────────────────────

function RotateIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M1 4v6h6" />
      <path d="M3.51 15a9 9 0 1 0 .49-3" />
    </svg>
  )
}

function CameraIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    </svg>
  )
}

function MoveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="5 9 2 12 5 15" />
      <polyline points="9 5 12 2 15 5" />
      <polyline points="15 19 12 22 9 19" />
      <polyline points="19 9 22 12 19 15" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="12" y1="2" x2="12" y2="22" />
    </svg>
  )
}
