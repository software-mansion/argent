import { useState, useRef, useEffect, useCallback } from 'react'
import type { ToolsClient, ConsoleLogEntry, ConsoleLogStream } from '../../api/client'

type ConsoleMode = 'eval' | 'logs'

interface EvalEntry {
  kind: 'eval'
  id: number
  expression: string
  result?: string
  error?: string
  ts: number
}

interface LogEntry {
  kind: 'log'
  id: number
  level: string
  message: string
  ts: number
}

type TimelineEntry = EvalEntry | LogEntry

interface EvalConsoleTabProps {
  api: ToolsClient
  metroPort: number
  connected: boolean
  onError: (error: string) => void
}

let nextEntryId = 0

const LEVEL_STYLES: Record<string, string> = {
  error: 'text-rl-danger',
  warn: 'text-yellow-400',
  info: 'text-blue-400',
  debug: 'text-rl-fg-muted',
}

export default function EvalConsoleTab({
  api,
  metroPort,
  connected,
  onError,
}: EvalConsoleTabProps) {
  const [expression, setExpression] = useState('')
  const [timeline, setTimeline] = useState<TimelineEntry[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const [mode, setMode] = useState<ConsoleMode>('logs')
  const [listening, setListening] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const streamRef = useRef<ConsoleLogStream | null>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [timeline])

  const stopListening = useCallback(() => {
    streamRef.current?.close()
    streamRef.current = null
    setListening(false)
  }, [])

  const startListening = useCallback(() => {
    if (streamRef.current) return

    const stream = api.metroConsoleStream(metroPort)
    streamRef.current = stream
    setListening(true)

    stream.on('log', (entry: ConsoleLogEntry) => {
      const logEntry: LogEntry = {
        kind: 'log',
        id: entry.id,
        level: entry.level,
        message: entry.message,
        ts: entry.timestamp,
      }
      setTimeline((prev) => [...prev, logEntry])
    })

    stream.on('error', () => {
      stopListening()
    })

    stream.on('close', () => {
      streamRef.current = null
      setListening(false)
    })
  }, [api, metroPort, stopListening])

  useEffect(() => {
    if (connected && mode === 'logs') {
      startListening()
    }
    return () => stopListening()
  }, [connected, mode, startListening, stopListening])

  if (!connected) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 text-xs text-rl-fg-muted">
        Connect to Metro first
      </div>
    )
  }

  const evalEntries = timeline.filter((e): e is EvalEntry => e.kind === 'eval')

  async function handleSubmit() {
    const expr = expression.trim()
    if (!expr) return

    const entryId = nextEntryId++
    const entry: EvalEntry = { kind: 'eval', id: entryId, expression: expr, ts: Date.now() }
    setTimeline((prev) => [...prev, entry])
    setExpression('')
    setHistoryIdx(-1)

    try {
      const res = await api.metroEvaluate(expr, metroPort)
      setTimeline((prev) =>
        prev.map((e) =>
          e.kind === 'eval' && e.id === entryId ? { ...e, result: formatResult(res.result) } : e
        )
      )
    } catch (e) {
      const msg = String(e)
      onError(msg)
      setTimeline((prev) =>
        prev.map((e) =>
          e.kind === 'eval' && e.id === entryId ? { ...e, error: msg } : e
        )
      )
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'ArrowUp') {
      if (evalEntries.length === 0) return
      const nextIdx =
        historyIdx === -1 ? evalEntries.length - 1 : Math.max(0, historyIdx - 1)
      setHistoryIdx(nextIdx)
      setExpression(evalEntries[nextIdx]!.expression)
    }
    if (e.key === 'ArrowDown') {
      if (historyIdx === -1) return
      const nextIdx = historyIdx + 1
      if (nextIdx >= evalEntries.length) {
        setHistoryIdx(-1)
        setExpression('')
      } else {
        setHistoryIdx(nextIdx)
        setExpression(evalEntries[nextIdx]!.expression)
      }
    }
  }

  const filtered =
    mode === 'eval'
      ? timeline.filter((e) => e.kind === 'eval')
      : timeline

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Mode toggle */}
      <div className="flex items-center border-b border-rl-border shrink-0 px-2 py-1 gap-1">
        <button
          onClick={() => setMode('eval')}
          className={`px-2 py-0.5 text-[10px] rounded font-medium transition-colors ${
            mode === 'eval'
              ? 'bg-rl-accent text-white'
              : 'text-rl-fg-muted hover:text-rl-fg hover:bg-rl-surface'
          }`}
        >
          Eval
        </button>
        <button
          onClick={() => setMode('logs')}
          className={`px-2 py-0.5 text-[10px] rounded font-medium transition-colors ${
            mode === 'logs'
              ? 'bg-rl-accent text-white'
              : 'text-rl-fg-muted hover:text-rl-fg hover:bg-rl-surface'
          }`}
        >
          App Logs
        </button>
        <div className="flex-1" />
        {mode === 'logs' && (
          <span className={`text-[10px] flex items-center gap-1 ${listening ? 'text-green-400' : 'text-rl-fg-muted'}`}>
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${listening ? 'bg-green-400 animate-pulse' : 'bg-rl-fg-muted'}`} />
            {listening ? 'Live' : 'Disconnected'}
          </span>
        )}
        <button
          onClick={() => setTimeline([])}
          className="text-[10px] text-rl-fg-muted hover:text-rl-fg px-1"
          title="Clear console"
        >
          ✕
        </button>
      </div>

      {/* Output */}
      <div ref={scrollRef} className="flex-1 overflow-auto font-mono text-[11px]">
        {filtered.length === 0 && (
          <div className="flex items-center justify-center h-full text-rl-fg-muted text-[10px]">
            {mode === 'logs' ? 'Waiting for app logs...' : 'Run a JavaScript expression below'}
          </div>
        )}
        {filtered.map((entry, idx) => {
          if (entry.kind === 'eval') {
            return (
              <div key={`eval-${entry.id}`} className="border-b border-rl-border">
                <div className="px-3 py-1 text-rl-accent">
                  <span className="text-rl-fg-muted select-none mr-1">&gt;</span>
                  {entry.expression}
                </div>
                {entry.result !== undefined && (
                  <div className="px-3 pb-1 text-rl-fg whitespace-pre-wrap break-all">
                    {entry.result}
                  </div>
                )}
                {entry.error !== undefined && (
                  <div className="px-3 pb-1 text-rl-danger whitespace-pre-wrap break-all">
                    {entry.error}
                  </div>
                )}
                {entry.result === undefined && entry.error === undefined && (
                  <div className="px-3 pb-1 text-rl-fg-muted animate-pulse">evaluating...</div>
                )}
              </div>
            )
          }

          return (
            <div
              key={`log-${entry.id}-${idx}`}
              className={`px-3 py-0.5 border-b border-rl-border flex items-start gap-2 ${
                entry.level === 'error' ? 'bg-red-500/5' : entry.level === 'warn' ? 'bg-yellow-500/5' : ''
              }`}
            >
              <span className={`shrink-0 text-[9px] uppercase font-semibold mt-px ${LEVEL_STYLES[entry.level] ?? 'text-rl-fg-muted'}`}>
                {entry.level.slice(0, 3)}
              </span>
              <span className="text-rl-fg whitespace-pre-wrap break-all flex-1">
                {entry.message}
              </span>
            </div>
          )
        })}
      </div>

      {/* Input */}
      <div className="flex items-center border-t border-rl-border shrink-0">
        <span className="pl-3 text-xs text-rl-fg-muted select-none">&gt;</span>
        <input
          value={expression}
          onChange={(e) => setExpression(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="JavaScript expression..."
          className="flex-1 px-2 py-1.5 text-xs font-mono bg-transparent text-rl-fg placeholder:text-rl-fg-muted focus:outline-none"
          autoFocus
        />
      </div>
    </div>
  )
}

function formatResult(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
