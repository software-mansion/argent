import { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import type { Orientation, InspectItem } from '../api/client'
import { createSessionClient } from '../api/client'
import DeviceScreen from '../components/DeviceScreen'
import TokenRequiredOverlay from '../components/TokenRequiredOverlay'
import MetroPanel from '../components/metro/MetroPanel'
import { useAdapter, useApi } from '../App'

interface FpsReport {
  fps: number
  received: number
  dropped: number
  timestamp: number
}

interface SessionViewProps {
  apiUrl: string
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
  apiUrl,
  sessionId,
  streamUrl,
  serverUrl,
  token,
  tokenNeeded,
  onSessionEnded,
  onTokenNeeded,
}: SessionViewProps) {
  const adapter = useAdapter()
  const toolsApi = useApi()
  const [fps, setFps] = useState<number | null>(null)
  const [orientationIdx, setOrientationIdx] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const panelLocationRef = useRef<'left' | 'right' | 'bottom'>('left')

  // Metro debugger state
  const [metroOpen, setMetroOpen] = useState(false)
  const [inspectMode, setInspectMode] = useState(false)
  const [inspectResult, setInspectResult] = useState<{ x: number; y: number; items: InspectItem[] } | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [includeSkipped, setIncludeSkipped] = useState(false)
  const metroPort = 8081

  const sessionClient = useMemo(() => createSessionClient(apiUrl), [apiUrl])
  useEffect(() => () => sessionClient.close(), [sessionClient])

  useEffect(() => {
    if (!token) return
    sessionClient.updateToken(sessionId, token).catch(() => {})
  }, [sessionClient, sessionId, token])

  useEffect(() => {
    const { ws } = sessionClient
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as { event: string; data?: Partial<FpsReport> }
      if (msg.event === 'fps_report') setFps(msg.data?.fps ?? null)
    }
    const closeHandler = () => onSessionEnded()
    const errorHandler = () => setError('WebSocket error')
    ws.addEventListener('message', handler)
    ws.addEventListener('close', closeHandler)
    ws.addEventListener('error', errorHandler)
    return () => {
      ws.removeEventListener('message', handler)
      ws.removeEventListener('close', closeHandler)
      ws.removeEventListener('error', errorHandler)
    }
  }, [sessionClient, onSessionEnded])

  const handleInspectClick = useCallback(
    async (x: number, y: number) => {
      if (!toolsApi || !inspectMode) return
      setInspecting(true)
      try {
        const result = await toolsApi.metroInspectElement(x, y, metroPort, { includeSkipped })
        if ('error' in result) {
          setError(result.error)
        } else {
          setInspectResult(result)
        }
      } catch (e) {
        setError(String(e))
      } finally {
        setInspecting(false)
      }
    },
    [toolsApi, inspectMode, metroPort, includeSkipped]
  )

  async function handleRotate() {
    const nextIdx = (orientationIdx + 1) % ORIENTATIONS.length
    setOrientationIdx(nextIdx)
    try {
      await sessionClient.rotate(sessionId, ORIENTATIONS[nextIdx])
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleScreenshot() {
    try {
      await sessionClient.screenshot(sessionId)
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
      await sessionClient.destroySession(sessionId)
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

        <div className="w-px h-4 bg-rl-border mx-1" />

        <button
          onClick={() => setMetroOpen((v) => !v)}
          title={metroOpen ? 'Close Metro Debugger' : 'Open Metro Debugger'}
          className={`p-1 rounded transition-colors ${
            metroOpen
              ? 'bg-rl-accent text-white'
              : 'text-rl-fg-muted hover:text-rl-fg hover:bg-rl-bg'
          }`}
        >
          <MetroIcon />
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

      {/* Main content: device screen + optional metro panel */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex items-center justify-center overflow-hidden p-2 relative">
          <DeviceScreen
            streamUrl={streamUrl}
            sessionId={sessionId}
            serverUrl={serverUrl}
            api={sessionClient}
            inspectMode={inspectMode}
            onInspectClick={handleInspectClick}
          />

          {inspectMode && (
            <div className="absolute top-2 left-2 px-2 py-1 rounded bg-rl-accent/80 text-white text-[10px] font-medium pointer-events-none">
              Inspect mode — click on the screen
            </div>
          )}
        </div>

        {metroOpen && toolsApi && (
          <MetroPanel
            api={toolsApi}
            metroPort={metroPort}
            inspectMode={inspectMode}
            onToggleInspect={() => setInspectMode((v) => !v)}
            inspectResult={inspectResult}
            inspecting={inspecting}
            includeSkipped={includeSkipped}
            onToggleIncludeSkipped={() => setIncludeSkipped((v) => !v)}
          />
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center px-3 py-1 border-t border-rl-border bg-rl-surface text-xs text-rl-fg-muted shrink-0">
        <span className="flex-1 truncate">Session: {sessionId}</span>
        {fps !== null && (
          <span className="ml-2 tabular-nums">{fps} fps</span>
        )}
      </div>

      {tokenNeeded && <TokenRequiredOverlay />}
    </div>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────

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

function MetroIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" />
      <path d="M8 12h.01M12 12h.01M16 12h.01" />
    </svg>
  )
}
