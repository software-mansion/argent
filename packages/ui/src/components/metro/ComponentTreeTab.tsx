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
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  async function fetchTree() {
    setLoading(true)
    try {
      const result = await api.metroComponentTree(metroPort)
      if ('error' in result) {
        onError(result.error)
        return
      }
      setTree(result.components)
      setExpanded(new Set(result.components.map((c) => c.id)))
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
          {loading ? 'Loading...' : tree ? 'Refresh' : 'Load Tree'}
        </button>
        {tree && (
          <span className="text-[10px] text-rl-fg-muted ml-auto">
            {tree.length} components
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {visibleNodes.map((node) => {
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
        })}
      </div>
    </div>
  )
}
