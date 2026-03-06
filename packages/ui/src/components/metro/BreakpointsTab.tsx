import { useState } from 'react'
import type { ToolsClient } from '../../api/client'

interface Breakpoint {
  id: string
  file: string
  line: number
  locations: Array<{ scriptId: string; lineNumber: number; columnNumber: number }>
}

interface BreakpointsTabProps {
  api: ToolsClient
  metroPort: number
  connected: boolean
  onError: (error: string) => void
}

export default function BreakpointsTab({
  api,
  metroPort,
  connected,
  onError,
}: BreakpointsTabProps) {
  const [breakpoints, setBreakpoints] = useState<Breakpoint[]>([])
  const [file, setFile] = useState('')
  const [line, setLine] = useState('')
  const [condition, setCondition] = useState('')
  const [paused, setPaused] = useState(false)

  if (!connected) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 text-xs text-rl-fg-muted">
        Connect to Metro first
      </div>
    )
  }

  async function handleAddBreakpoint() {
    const l = parseInt(line, 10)
    if (!file.trim() || isNaN(l)) {
      onError('File and line are required')
      return
    }
    try {
      const result = await api.metroSetBreakpoint(
        file.trim(),
        l,
        metroPort,
        condition.trim() || undefined
      )
      setBreakpoints((prev) => [
        ...prev,
        { id: result.breakpointId, file: file.trim(), line: l, locations: result.locations },
      ])
      setFile('')
      setLine('')
      setCondition('')
    } catch (e) {
      onError(String(e))
    }
  }

  async function handleRemove(bp: Breakpoint) {
    try {
      await api.metroRemoveBreakpoint(bp.id, metroPort)
      setBreakpoints((prev) => prev.filter((b) => b.id !== bp.id))
    } catch (e) {
      onError(String(e))
    }
  }

  async function handlePause() {
    try {
      await api.metroPause(metroPort)
      setPaused(true)
    } catch (e) {
      onError(String(e))
    }
  }

  async function handleResume() {
    try {
      await api.metroResume(metroPort)
      setPaused(false)
    } catch (e) {
      onError(String(e))
    }
  }

  async function handleStep(action: 'stepOver' | 'stepInto' | 'stepOut') {
    try {
      await api.metroStep(action, metroPort)
    } catch (e) {
      onError(String(e))
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Debugger controls */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-rl-border shrink-0">
        <button
          onClick={paused ? handleResume : handlePause}
          className="p-1 rounded text-rl-fg-muted hover:text-rl-fg hover:bg-rl-bg transition-colors"
          title={paused ? 'Resume (F8)' : 'Pause'}
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
        </button>
        <button
          onClick={() => handleStep('stepOver')}
          disabled={!paused}
          className="p-1 rounded text-rl-fg-muted hover:text-rl-fg hover:bg-rl-bg transition-colors disabled:opacity-30"
          title="Step Over (F10)"
        >
          <StepOverIcon />
        </button>
        <button
          onClick={() => handleStep('stepInto')}
          disabled={!paused}
          className="p-1 rounded text-rl-fg-muted hover:text-rl-fg hover:bg-rl-bg transition-colors disabled:opacity-30"
          title="Step Into (F11)"
        >
          <StepIntoIcon />
        </button>
        <button
          onClick={() => handleStep('stepOut')}
          disabled={!paused}
          className="p-1 rounded text-rl-fg-muted hover:text-rl-fg hover:bg-rl-bg transition-colors disabled:opacity-30"
          title="Step Out (Shift+F11)"
        >
          <StepOutIcon />
        </button>
        {paused && (
          <span className="ml-2 text-[10px] text-yellow-400 font-medium">PAUSED</span>
        )}
      </div>

      {/* Add breakpoint form */}
      <div className="px-3 py-2 border-b border-rl-border flex flex-col gap-1.5 shrink-0">
        <div className="flex gap-1.5">
          <input
            value={file}
            onChange={(e) => setFile(e.target.value)}
            placeholder="File (e.g. App.tsx)"
            className="flex-1 min-w-0 px-2 py-1 rounded text-xs bg-rl-bg border border-rl-border text-rl-fg placeholder:text-rl-fg-muted focus:outline-none focus:border-rl-accent"
          />
          <input
            value={line}
            onChange={(e) => setLine(e.target.value)}
            placeholder="Line"
            type="number"
            className="w-16 px-2 py-1 rounded text-xs bg-rl-bg border border-rl-border text-rl-fg placeholder:text-rl-fg-muted focus:outline-none focus:border-rl-accent tabular-nums"
          />
        </div>
        <div className="flex gap-1.5">
          <input
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            placeholder="Condition (optional)"
            className="flex-1 min-w-0 px-2 py-1 rounded text-xs bg-rl-bg border border-rl-border text-rl-fg placeholder:text-rl-fg-muted focus:outline-none focus:border-rl-accent"
          />
          <button
            onClick={handleAddBreakpoint}
            className="px-3 py-1 rounded text-xs font-medium bg-rl-accent text-white hover:bg-rl-accent-hover transition-colors shrink-0"
          >
            Add
          </button>
        </div>
      </div>

      {/* Breakpoint list */}
      <div className="flex-1 overflow-auto">
        {breakpoints.length === 0 && (
          <div className="text-[10px] text-rl-fg-muted px-3 py-2">No breakpoints set</div>
        )}
        {breakpoints.map((bp) => (
          <div
            key={bp.id}
            className="flex items-center gap-2 px-3 py-1.5 border-b border-rl-border hover:bg-rl-surface group"
          >
            <span className="text-red-400 text-xs">●</span>
            <span className="text-xs text-rl-fg truncate flex-1">
              {bp.file}:{bp.line}
            </span>
            {bp.locations.length > 0 && (
              <span className="text-[10px] text-rl-fg-muted tabular-nums">
                {bp.locations.length} loc
              </span>
            )}
            <button
              onClick={() => handleRemove(bp)}
              className="text-rl-fg-muted hover:text-rl-danger opacity-0 group-hover:opacity-100 transition-opacity"
              title="Remove"
            >
              <XIcon />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  )
}

function StepOverIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="16" r="4" /><path d="M4 4h12a4 4 0 0 1 0 8h-4" /><path d="M14 8l-2 4 2 4" />
    </svg>
  )
}

function StepIntoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="2" x2="12" y2="14" /><polyline points="8 10 12 14 16 10" />
      <circle cx="12" cy="20" r="2" />
    </svg>
  )
}

function StepOutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="22" x2="12" y2="10" /><polyline points="16 14 12 10 8 14" />
      <circle cx="12" cy="4" r="2" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}
