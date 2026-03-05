import type { InspectItem } from '../../api/client'

interface InspectorTabProps {
  connected: boolean
  inspectResult: { x: number; y: number; items: InspectItem[] } | null
  inspecting: boolean
}

export default function InspectorTab({
  connected,
  inspectResult,
  inspecting,
}: InspectorTabProps) {
  if (!connected) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 text-xs text-rl-fg-muted">
        Connect to Metro first
      </div>
    )
  }

  if (inspecting) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 text-xs text-rl-fg-muted animate-pulse">
        Inspecting...
      </div>
    )
  }

  if (!inspectResult) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-4 gap-2">
        <CrosshairIcon />
        <p className="text-xs text-rl-fg-muted text-center">
          Enable inspect mode and click on the device screen to inspect an element
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-auto">
      <div className="px-3 py-1.5 border-b border-rl-border text-[10px] text-rl-fg-muted shrink-0">
        Tap at ({inspectResult.x}, {inspectResult.y}) — {inspectResult.items.length} component(s)
      </div>

      {inspectResult.items.map((item, i) => (
        <div key={i} className="border-b border-rl-border mt-7">
          <div className="flex items-center gap-2 px-3 py-1.5">
            <span className="text-xs font-medium text-rl-fg">&lt;{item.name} /&gt;</span>
            {item.source && (
              <span className="text-[10px] text-rl-accent ml-auto shrink-0">
                {item.source.file}:{item.source.line}
              </span>
            )}
          </div>
          {item.code && (
            <pre className="px-3 pb-2 text-[10px] leading-tight text-rl-fg-muted overflow-x-auto font-mono whitespace-pre">
              {item.code}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}

function CrosshairIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-rl-fg-muted">
      <circle cx="12" cy="12" r="10" />
      <line x1="22" y1="12" x2="18" y2="12" />
      <line x1="6" y1="12" x2="2" y2="12" />
      <line x1="12" y1="6" x2="12" y2="2" />
      <line x1="12" y1="22" x2="12" y2="18" />
    </svg>
  )
}
