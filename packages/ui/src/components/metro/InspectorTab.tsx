import type { InspectItem } from '../../api/client'

interface InspectorTabProps {
  connected: boolean
  inspectResult: { x: number; y: number; items: InspectItem[] } | null
  inspecting: boolean
  includeSkipped: boolean
  onToggleIncludeSkipped: () => void
}

export default function InspectorTab({
  connected,
  inspectResult,
  inspecting,
  includeSkipped,
  onToggleIncludeSkipped,
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
        <IncludeSkippedToggle checked={includeSkipped} onChange={onToggleIncludeSkipped} />
      </div>
    )
  }

  const keptCount = inspectResult.items.filter((i) => !i.skipped).length
  const skippedCount = inspectResult.items.filter((i) => i.skipped).length

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-auto">
      <div className="px-3 py-1.5 border-b border-rl-border shrink-0 flex items-center gap-2">
        <span className="text-[10px] text-rl-fg-muted">
          Tap at ({inspectResult.x}, {inspectResult.y}) — {keptCount} component{keptCount !== 1 ? 's' : ''}
          {skippedCount > 0 && (
            <span className="text-rl-fg-muted/60"> + {skippedCount} skipped</span>
          )}
        </span>
        <IncludeSkippedToggle checked={includeSkipped} onChange={onToggleIncludeSkipped} />
      </div>

      {inspectResult.items.map((item, i) => (
        <div
          key={i}
          className={`border-b border-rl-border ${i > 0 ? 'mt-7' : ''} ${
            item.skipped ? 'opacity-45' : ''
          }`}
        >
          <div className="flex items-center gap-2 px-3 py-1.5">
            <span className={`text-xs font-medium ${item.skipped ? 'text-rl-fg-muted line-through' : 'text-rl-fg'}`}>
              &lt;{item.name} /&gt;
            </span>

            {item.skipped && item.skipReason && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium shrink-0">
                {item.skipReason}
              </span>
            )}

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

function IncludeSkippedToggle({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: () => void
}) {
  return (
    <label className="flex items-center gap-1.5 ml-auto cursor-pointer shrink-0 select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="w-3 h-3 rounded border-rl-border accent-rl-accent cursor-pointer"
      />
      <span className="text-[10px] text-rl-fg-muted">Show skipped</span>
    </label>
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
