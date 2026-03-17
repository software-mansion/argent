import { useState } from 'react'
import type { ToolsClient, ComponentEntry } from '../../api/client'

interface ComponentTreeTabProps {
  api: ToolsClient
  metroPort: number
  connected: boolean
  onError: (error: string) => void
}

export default function ComponentTreeTab({
  api,
  metroPort,
  connected,
  onError,
}: ComponentTreeTabProps) {
  const [tree, setTree] = useState<ComponentEntry[] | null>(null)
  const [textTree, setTextTree] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [includeSkipped, setIncludeSkipped] = useState(false)

  async function fetchTree() {
    setLoading(true)
    try {
      const result = await api.metroComponentTree(metroPort, includeSkipped)
      if (typeof result === 'string') {
        setTextTree(result)
        setTree(null)
      } else if ('error' in result) {
        onError(result.error)
      } else {
        setTree(result.components)
        setTextTree(null)
        setExpanded(new Set(result.components.map((c) => c.id)))
      }
    } catch (e) {
      onError(String(e))
    } finally {
      setLoading(false)
    }
  }

  if (!connected) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 text-xs text-rl-fg-muted">
        Connect to Metro first
      </div>
    )
  }

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const visibleNodes = tree
    ? tree.filter((node) => {
        if (node.parentIdx === -1) return true
        let parent = node.parentIdx
        while (parent !== -1) {
          if (!expanded.has(parent)) return false
          const parentNode = tree.find((n) => n.id === parent)
          parent = parentNode?.parentIdx ?? -1
        }
        return true
      })
    : []

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-rl-border shrink-0">
        <button
          onClick={fetchTree}
          disabled={loading}
          className="text-xs text-rl-accent hover:text-rl-accent-hover disabled:opacity-50"
        >
          {loading ? 'Loading...' : tree || textTree ? 'Refresh' : 'Load Tree'}
        </button>

        <label className="flex items-center gap-1.5 ml-auto cursor-pointer shrink-0 select-none">
          <input
            type="checkbox"
            checked={includeSkipped}
            onChange={() => setIncludeSkipped((v) => !v)}
            className="w-3 h-3 rounded border-rl-border accent-rl-accent cursor-pointer"
          />
          <span className="text-[10px] text-rl-fg-muted">Show skipped</span>
        </label>

        {tree && (
          <span className="text-[10px] text-rl-fg-muted">
            {tree.length} components
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {textTree ? (
          <TextTreeView text={textTree} />
        ) : (
          visibleNodes.map((node) => {
            const hasChildren = tree!.some((n) => n.parentIdx === node.id)
            const isExpanded = expanded.has(node.id)

            return (
              <div
                key={node.id}
                className="flex items-center gap-1 px-2 py-0.5 hover:bg-rl-surface cursor-default text-xs"
                style={{ paddingLeft: `${node.depth * 16 + 8}px` }}
              >
                {hasChildren ? (
                  <button
                    onClick={() => toggleExpand(node.id)}
                    className="w-3 text-rl-fg-muted hover:text-rl-fg shrink-0"
                  >
                    {isExpanded ? '▾' : '▸'}
                  </button>
                ) : (
                  <span className="w-3 shrink-0" />
                )}

                <span className={node.isHost ? 'text-rl-fg-muted' : 'text-rl-fg font-medium'}>
                  {node.isHost ? `<${node.name}>` : `<${node.name} />`}
                </span>

                {node.rect && (
                  <span className="text-[10px] text-rl-fg-muted ml-auto tabular-nums shrink-0">
                    {node.rect.w}×{node.rect.h}
                  </span>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function TextTreeView({ text }: { text: string }) {
  const filteredIdx = text.indexOf('--- Filtered ---')
  const treePart = filteredIdx >= 0 ? text.slice(0, filteredIdx) : text
  const summaryPart = filteredIdx >= 0 ? text.slice(filteredIdx) : null

  return (
    <div className="p-2">
      <pre className="text-[11px] leading-relaxed text-rl-fg font-mono whitespace-pre overflow-x-auto">
        {treePart}
      </pre>
      {summaryPart && (
        <pre className="text-[11px] leading-relaxed text-amber-400/80 font-mono whitespace-pre overflow-x-auto mt-2 pt-2 border-t border-rl-border">
          {summaryPart}
        </pre>
      )}
    </div>
  )
}
