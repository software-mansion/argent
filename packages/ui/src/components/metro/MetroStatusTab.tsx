import { useState } from 'react'
import type { ToolsClient, MetroStatusInfo } from '../../api/client'

interface MetroStatusTabProps {
  api: ToolsClient
  metroPort: number
  status: MetroStatusInfo | null
  onConnected: (info: MetroStatusInfo) => void
  onError: (error: string) => void
}

export default function MetroStatusTab({
  api,
  metroPort,
  status,
  onConnected,
  onError,
}: MetroStatusTabProps) {
  const [connecting, setConnecting] = useState(false)

  async function handleConnect() {
    setConnecting(true)
    try {
      const info = await api.metroStatus(metroPort)
      onConnected(info)
    } catch (e) {
      onError(String(e))
    } finally {
      setConnecting(false)
    }
  }

  async function handleRefresh() {
    try {
      const info = await api.metroStatus(metroPort)
      onConnected(info)
    } catch (e) {
      onError(String(e))
    }
  }

  if (!status) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 flex-1 p-4">
        <PlugIcon />
        <p className="text-xs text-rl-fg-muted text-center">
          Connect to a running Metro dev server to enable debugging tools
        </p>
        <button
          onClick={handleConnect}
          disabled={connecting}
          className="px-4 py-1.5 rounded text-xs font-medium bg-rl-accent text-white hover:bg-rl-accent-hover transition-colors disabled:opacity-50"
        >
          {connecting ? 'Connecting...' : `Connect to :${metroPort}`}
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div className="flex items-center gap-2">
        <span className={status.connected ? 'text-green-400' : 'text-rl-danger'}>
          {status.connected ? '●' : '○'}
        </span>
        <span className="text-rl-fg font-medium">
          {status.connected ? 'Connected' : 'Disconnected'}
        </span>
        <button
          onClick={handleRefresh}
          className="ml-auto text-rl-fg-muted hover:text-rl-fg"
          title="Refresh"
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        <span className="text-rl-fg-muted">Port</span>
        <span className="text-rl-fg tabular-nums">{status.port}</span>

        <span className="text-rl-fg-muted">Project</span>
        <span className="text-rl-fg truncate" title={status.projectRoot}>{status.projectRoot}</span>

        <span className="text-rl-fg-muted">Device</span>
        <span className="text-rl-fg">{status.deviceName}</span>

        <span className="text-rl-fg-muted">Debugger</span>
        <span className="text-rl-fg">{status.isNewDebugger ? 'Fusebox (new)' : 'Legacy'}</span>

        <span className="text-rl-fg-muted">Scripts</span>
        <span className="text-rl-fg tabular-nums">{status.loadedScripts}</span>

        <span className="text-rl-fg-muted">Domains</span>
        <span className="text-rl-fg">{status.enabledDomains.join(', ')}</span>
      </div>
    </div>
  )
}

function PlugIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-rl-fg-muted">
      <path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" />
      <path d="M18 8v5a6 6 0 0 1-12 0V8z" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M1 4v6h6" /><path d="M23 20v-6h-6" />
      <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
    </svg>
  )
}
