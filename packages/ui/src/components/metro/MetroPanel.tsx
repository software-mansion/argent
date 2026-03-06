import { useState, useCallback } from 'react'
import type { ToolsClient, MetroStatusInfo, InspectItem } from '../../api/client'
import MetroStatusTab from './MetroStatusTab'
import ComponentTreeTab from './ComponentTreeTab'
import InspectorTab from './InspectorTab'
import BreakpointsTab from './BreakpointsTab'
import EvalConsoleTab from './EvalConsoleTab'

type Tab = 'status' | 'tree' | 'inspector' | 'breakpoints' | 'console'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'status', label: 'Status', icon: '◉' },
  { id: 'tree', label: 'Tree', icon: '⊞' },
  { id: 'inspector', label: 'Inspect', icon: '⊕' },
  { id: 'breakpoints', label: 'Debug', icon: '◈' },
  { id: 'console', label: 'Console', icon: '⊳' },
]

interface MetroPanelProps {
  api: ToolsClient
  metroPort: number
  inspectMode: boolean
  onToggleInspect: () => void
  inspectResult: { x: number; y: number; items: InspectItem[] } | null
  inspecting: boolean
}

export default function MetroPanel({
  api,
  metroPort,
  inspectMode,
  onToggleInspect,
  inspectResult,
  inspecting,
}: MetroPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('status')
  const [status, setStatus] = useState<MetroStatusInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  const connected = status?.connected ?? false

  const handleConnected = useCallback((info: MetroStatusInfo) => {
    setStatus(info)
    setError(null)
  }, [])

  const handleError = useCallback((msg: string) => {
    setError(msg)
  }, [])

  return (
    <div className="flex flex-col w-80 min-w-[280px] border-l border-rl-border bg-rl-bg">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-rl-border shrink-0">
        <span className={`text-xs ${connected ? 'text-green-400' : 'text-rl-fg-muted'}`}>
          {connected ? '●' : '○'}
        </span>
        <span className="text-xs font-semibold text-rl-fg uppercase tracking-wide flex-1">
          Metro Debugger
        </span>
        {connected && (
          <button
            onClick={onToggleInspect}
            className={`p-1 rounded transition-colors ${
              inspectMode
                ? 'bg-rl-accent text-white'
                : 'text-rl-fg-muted hover:text-rl-fg hover:bg-rl-surface'
            }`}
            title={inspectMode ? 'Disable inspect mode' : 'Enable inspect mode'}
          >
            <InspectCursorIcon />
          </button>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-3 py-1 text-[10px] text-rl-danger bg-rl-surface border-b border-rl-border shrink-0 flex items-center gap-1">
          <span className="truncate flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-rl-fg-muted hover:text-rl-fg shrink-0">
            ✕
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex border-b border-rl-border shrink-0">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 py-1.5 text-[10px] font-medium transition-colors ${
              activeTab === tab.id
                ? 'text-rl-accent border-b-2 border-rl-accent'
                : 'text-rl-fg-muted hover:text-rl-fg'
            }`}
            title={tab.label}
          >
            <span className="block text-sm leading-none">{tab.icon}</span>
            <span className="block mt-0.5">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 flex flex-col min-h-0">
        {activeTab === 'status' && (
          <MetroStatusTab
            api={api}
            metroPort={metroPort}
            status={status}
            onConnected={handleConnected}
            onError={handleError}
          />
        )}
        {activeTab === 'tree' && (
          <ComponentTreeTab
            api={api}
            metroPort={metroPort}
            connected={connected}
            onError={handleError}
          />
        )}
        {activeTab === 'inspector' && (
          <InspectorTab
            connected={connected}
            inspectResult={inspectResult}
            inspecting={inspecting}
          />
        )}
        {activeTab === 'breakpoints' && (
          <BreakpointsTab
            api={api}
            metroPort={metroPort}
            connected={connected}
            onError={handleError}
          />
        )}
        {activeTab === 'console' && (
          <EvalConsoleTab
            api={api}
            metroPort={metroPort}
            connected={connected}
            onError={handleError}
          />
        )}
      </div>
    </div>
  )
}

function InspectCursorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="11" y1="8" x2="11" y2="14" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  )
}
