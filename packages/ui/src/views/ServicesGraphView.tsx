import { useState, useEffect, useMemo } from 'react'
import type { ToolsClient, RegistrySnapshot, RegistryServiceState } from '../api/client'

const NODE_WIDTH = 180
const NODE_HEIGHT = 56
const LAYER_GAP = 100
const NODE_GAP = 24

const STATE_COLORS: Record<RegistryServiceState, { bg: string; border: string; text: string }> = {
  IDLE: { bg: 'var(--rl-surface)', border: 'var(--rl-border)', text: 'var(--rl-fg-muted)' },
  STARTING: { bg: 'rgba(14, 99, 156, 0.2)', border: 'var(--rl-accent)', text: 'var(--rl-accent)' },
  RUNNING: { bg: 'rgba(34, 139, 34, 0.2)', border: '#228b22', text: '#7fdb7f' },
  TERMINATING: { bg: 'rgba(255, 165, 0, 0.15)', border: '#daa520', text: '#e6c04a' },
  ERROR: { bg: 'rgba(244, 71, 71, 0.15)', border: 'var(--rl-danger)', text: 'var(--rl-danger)' },
}

function stateStyle(state: RegistryServiceState) {
  return STATE_COLORS[state] ?? STATE_COLORS.IDLE
}

interface LayoutNode {
  urn: string
  state: RegistryServiceState
  x: number
  y: number
  dependents: string[]
}

function buildLayout(snapshot: RegistrySnapshot): LayoutNode[] {
  const { services } = snapshot
  const urns = Object.keys(services)
  if (urns.length === 0) return []

  const dependentsSet = new Set<string>()
  for (const data of Object.values(services)) {
    for (const d of data.dependents) dependentsSet.add(d)
  }

  const targetsOf = new Map<string, string[]>()
  for (const [urn, data] of Object.entries(services)) {
    for (const d of data.dependents) {
      if (!targetsOf.has(d)) targetsOf.set(d, [])
      targetsOf.get(d)!.push(urn)
    }
  }

  const layerOf = new Map<string, number>()
  function getLayer(urn: string): number {
    if (layerOf.has(urn)) return layerOf.get(urn)!
    const targets = targetsOf.get(urn) ?? []
    const l = targets.length === 0 ? 0 : 1 + Math.max(...targets.map(getLayer))
    layerOf.set(urn, l)
    return l
  }
  urns.forEach(getLayer)

  const layers = new Map<number, string[]>()
  for (const urn of urns) {
    const l = layerOf.get(urn)!
    if (!layers.has(l)) layers.set(l, [])
    layers.get(l)!.push(urn)
  }

  const sortedLayers = Array.from(layers.entries()).sort((a, b) => a[0] - b[0])
  const result: LayoutNode[] = []

  for (let ly = 0; ly < sortedLayers.length; ly++) {
    const nodesInLayer = sortedLayers[ly]![1]
    const y = ly * (NODE_HEIGHT + LAYER_GAP)
    const totalW = (nodesInLayer.length - 1) * (NODE_WIDTH + NODE_GAP) + NODE_WIDTH
    let x = -totalW / 2 + NODE_WIDTH / 2
    for (const urn of nodesInLayer) {
      const data = services[urn]!
      result.push({ urn, state: data.state, x, y, dependents: data.dependents })
      x += NODE_WIDTH + NODE_GAP
    }
  }

  return result
}

interface ServicesGraphViewProps {
  api: ToolsClient
  onBack: () => void
}

export default function ServicesGraphView({ api, onBack }: ServicesGraphViewProps) {
  const [snapshot, setSnapshot] = useState<RegistrySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [polling, setPolling] = useState(true)

  useEffect(() => {
    if (!polling) return
    let cancelled = false
    const fetchSnapshot = () => {
      api
        .getRegistrySnapshot()
        .then((s) => {
          if (!cancelled) setSnapshot(s)
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(String(e))
        })
    }
    fetchSnapshot()
    const id = setInterval(fetchSnapshot, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [api, polling])

  const layout = useMemo(() => (snapshot ? buildLayout(snapshot) : []), [snapshot])
  const bounds = useMemo(() => {
    if (layout.length === 0) return { width: 400, height: 300 }
    const xs = layout.map((n) => n.x)
    const ys = layout.map((n) => n.y)
    const padding = 80
    return {
      width: Math.max(400, Math.max(...xs) - Math.min(...xs) + NODE_WIDTH + padding * 2),
      height: Math.max(300, Math.max(...ys) - Math.min(...ys) + NODE_HEIGHT + padding * 2),
    }
  }, [layout])

  const edges = useMemo(() => {
    const out: { from: LayoutNode; to: LayoutNode }[] = []
    const byUrn = new Map(layout.map((n) => [n.urn, n]))
    for (const node of layout) {
      for (const depUrn of node.dependents) {
        const target = byUrn.get(depUrn)
        if (target) out.push({ from: target, to: node })
      }
    }
    return out
  }, [layout])

  const transform = useMemo(() => {
    if (layout.length === 0) return ''
    const minX = Math.min(...layout.map((n) => n.x)) - NODE_WIDTH / 2
    const minY = Math.min(...layout.map((n) => n.y)) - NODE_HEIGHT / 2
    return `translate(${-minX + 40},${-minY + 40})`
  }, [layout])

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-rl-bg">
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-rl-border shrink-0">
        <h2 className="text-sm font-semibold text-rl-fg uppercase tracking-wide">
          Registry — services & dependencies
        </h2>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-rl-fg-muted">
            <input
              type="checkbox"
              checked={polling}
              onChange={(e) => setPolling(e.target.checked)}
              className="rounded border-rl-border"
            />
            Auto-refresh
          </label>
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-rl-accent hover:text-rl-accent-hover"
          >
            ← Back
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-2 text-xs text-rl-danger bg-rl-surface border border-rl-border rounded px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto p-4">
        {snapshot && layout.length === 0 && (
          <div className="text-sm text-rl-fg-muted">No services in registry yet.</div>
        )}
        {snapshot && layout.length > 0 && (
          <div
            className="inline-block rounded border border-rl-border overflow-hidden"
            style={{ minWidth: bounds.width, minHeight: bounds.height }}
          >
            <svg
              width={bounds.width}
              height={bounds.height}
              className="bg-rl-surface"
            >
              <g transform={transform}>
                {edges.map(({ from, to }, i) => {
                  const sx = from.x
                  const sy = from.y + NODE_HEIGHT / 2
                  const tx = to.x
                  const ty = to.y - NODE_HEIGHT / 2
                  const midY = (sy + ty) / 2
                  return (
                    <g key={`${from.urn}-${to.urn}-${i}`}>
                      <path
                        d={`M ${sx} ${sy} C ${sx} ${midY} ${tx} ${midY} ${tx} ${ty}`}
                        fill="none"
                        stroke="var(--rl-border)"
                        strokeWidth="1.5"
                        markerEnd="url(#arrow)"
                      />
                    </g>
                  )
                })}
                <defs>
                  <marker
                    id="arrow"
                    markerWidth="8"
                    markerHeight="8"
                    refX="6"
                    refY="4"
                    orient="auto"
                  >
                    <path d="M0,0 L8,4 L0,8 Z" fill="var(--rl-border)" />
                  </marker>
                </defs>
                {layout.map((node) => {
                  const style = stateStyle(node.state)
                  const shortLabel = node.urn.includes(':')
                    ? node.urn.split(':').slice(1).join(':') || node.urn
                    : node.urn
                  return (
                    <g
                      key={node.urn}
                      transform={`translate(${node.x - NODE_WIDTH / 2},${node.y - NODE_HEIGHT / 2})`}
                    >
                      <rect
                        width={NODE_WIDTH}
                        height={NODE_HEIGHT}
                        rx={8}
                        ry={8}
                        fill={style.bg}
                        stroke={style.border}
                        strokeWidth="2"
                      />
                      <text
                        x={NODE_WIDTH / 2}
                        y={20}
                        textAnchor="middle"
                        className="text-xs font-medium"
                        fill="var(--rl-fg)"
                      >
                        {shortLabel.length > 22 ? shortLabel.slice(0, 19) + '…' : shortLabel}
                      </text>
                      <text
                        x={NODE_WIDTH / 2}
                        y={36}
                        textAnchor="middle"
                        className="text-[10px]"
                        fill={style.text}
                      >
                        {node.state}
                      </text>
                      <title>{node.urn}</title>
                    </g>
                  )
                })}
              </g>
            </svg>
          </div>
        )}
      </div>

      {snapshot && (
        <div className="shrink-0 px-4 py-2 border-t border-rl-border flex flex-wrap gap-4 text-[10px] text-rl-fg-muted">
          <span>Namespaces: {snapshot.namespaces.join(', ') || '—'}</span>
          <span>Tools: {snapshot.tools.join(', ') || '—'}</span>
        </div>
      )}
    </div>
  )
}
