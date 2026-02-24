import { useState, useEffect } from 'react'
import type { ApiClient, Simulator } from '../api/client'

interface DevicePickerViewProps {
  api: ApiClient
  loading: boolean
  onStarting: () => void
  onSessionCreated: (sessionId: string, streamUrl: string) => void
}

export default function DevicePickerView({
  api,
  loading,
  onStarting,
  onSessionCreated,
}: DevicePickerViewProps) {
  const [running, setRunning] = useState<Simulator[]>([])
  const [all, setAll] = useState<Simulator[]>([])
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [booting, setBooting] = useState<string | null>(null)

  useEffect(() => {
    api
      .listRunningSimulators()
      .then((simulators) => setRunning(simulators))
      .catch((e: unknown) => setError(String(e)))
  }, [api])

  useEffect(() => {
    if (!showAll) return
    api
      .listSimulators()
      .then((simulators) => setAll(simulators))
      .catch((e: unknown) => setError(String(e)))
  }, [showAll, api])

  async function selectDevice(udid: string) {
    onStarting()
    try {
      const session = await api.createSession({ udid })
      onSessionCreated(session.id, session.streamUrl)
    } catch (e) {
      setError(String(e))
    }
  }

  async function bootAndSelect(udid: string) {
    setBooting(udid)
    try {
      await api.bootSimulator(udid)
      await selectDevice(udid)
    } catch (e) {
      setError(String(e))
      setBooting(null)
    }
  }

  const displayList = showAll ? all : running

  return (
    <div className="flex flex-col flex-1 p-4 gap-4 overflow-auto">
      <h2 className="text-sm font-semibold text-rl-fg-muted uppercase tracking-wide">
        {showAll ? 'All Simulators' : 'Running Simulators'}
      </h2>

      {error && (
        <div className="text-xs text-rl-danger bg-rl-surface border border-rl-border rounded px-3 py-2">
          {error}
        </div>
      )}

      {loading && (
        <div className="text-xs text-rl-fg-muted">Starting session…</div>
      )}

      <ul className="flex flex-col gap-1">
        {displayList.map((sim) => (
          <li key={sim.udid}>
            <button
              disabled={loading || booting !== null}
              onClick={() =>
                sim.state === 'Booted' ? selectDevice(sim.udid) : bootAndSelect(sim.udid)
              }
              className="
                w-full text-left px-3 py-2 rounded
                bg-rl-surface border border-rl-border
                hover:border-rl-accent
                disabled:opacity-50 disabled:cursor-not-allowed
                transition-colors
              "
            >
              <div className="text-sm text-rl-fg font-medium">{sim.name}</div>
              <div className="text-xs text-rl-fg-muted flex gap-2 mt-0.5">
                <span
                  className={
                    sim.state === 'Booted' ? 'text-green-400' : 'text-rl-fg-muted'
                  }
                >
                  {sim.state === 'Booted' ? '● Booted' : '○ ' + sim.state}
                </span>
                {booting === sim.udid && <span className="text-rl-fg-muted">Booting…</span>}
                <span className="truncate">{sim.udid}</span>
              </div>
            </button>
          </li>
        ))}

        {displayList.length === 0 && !loading && !error && (
          <li className="text-xs text-rl-fg-muted px-1">No simulators found.</li>
        )}
      </ul>

      <button
        onClick={() => setShowAll((v) => !v)}
        className="text-xs text-rl-accent hover:text-rl-accent-hover self-start"
      >
        {showAll ? '← Show running only' : 'Boot another…'}
      </button>
    </div>
  )
}
