import { useState, useRef, useEffect } from 'react'
import type { ToolsClient } from '../../api/client'

interface ConsoleEntry {
  id: number
  expression: string
  result?: string
  error?: string
}

interface EvalConsoleTabProps {
  api: ToolsClient
  metroPort: number
  connected: boolean
  onError: (error: string) => void
}

let nextEntryId = 0

export default function EvalConsoleTab({
  api,
  metroPort,
  connected,
  onError,
}: EvalConsoleTabProps) {
  const [expression, setExpression] = useState('')
  const [history, setHistory] = useState<ConsoleEntry[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [history])

  if (!connected) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 text-xs text-rl-fg-muted">
        Connect to Metro first
      </div>
    )
  }

  async function handleSubmit() {
    const expr = expression.trim()
    if (!expr) return

    const entryId = nextEntryId++
    const entry: ConsoleEntry = { id: entryId, expression: expr }
    setHistory((prev) => [...prev, entry])
    setExpression('')
    setHistoryIdx(-1)

    try {
      const res = await api.metroEvaluate(expr, metroPort)
      setHistory((prev) =>
        prev.map((e) =>
          e.id === entryId ? { ...e, result: formatResult(res.result) } : e
        )
      )
    } catch (e) {
      const msg = String(e)
      onError(msg)
      setHistory((prev) =>
        prev.map((e) => (e.id === entryId ? { ...e, error: msg } : e))
      )
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'ArrowUp') {
      const expressions = history.map((h) => h.expression)
      if (expressions.length === 0) return
      const nextIdx = historyIdx === -1 ? expressions.length - 1 : Math.max(0, historyIdx - 1)
      setHistoryIdx(nextIdx)
      setExpression(expressions[nextIdx]!)
    }
    if (e.key === 'ArrowDown') {
      const expressions = history.map((h) => h.expression)
      if (historyIdx === -1) return
      const nextIdx = historyIdx + 1
      if (nextIdx >= expressions.length) {
        setHistoryIdx(-1)
        setExpression('')
      } else {
        setHistoryIdx(nextIdx)
        setExpression(expressions[nextIdx]!)
      }
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Output */}
      <div ref={scrollRef} className="flex-1 overflow-auto font-mono text-[11px]">
        {history.map((entry) => (
          <div key={entry.id} className="border-b border-rl-border">
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
        ))}
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
