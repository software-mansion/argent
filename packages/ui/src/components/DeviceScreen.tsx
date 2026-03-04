import type { SessionClient } from '../api/client'
import MjpegCanvas from './MjpegCanvas'
import TouchSurface from './TouchSurface'

interface DeviceScreenProps {
  streamUrl: string
  sessionId: string
  serverUrl: string
  api: SessionClient
  inspectMode?: boolean
  onInspectClick?: (x: number, y: number) => void
}

/**
 * Rounded-rect wrapper that composes MjpegCanvas + TouchSurface.
 * Fills available space while preserving 9:19.5 aspect ratio (iPhone-ish).
 *
 * When inspectMode is active, clicks are sent to onInspectClick as logical
 * device coordinates instead of being forwarded as touch events.
 */
export default function DeviceScreen({
  streamUrl,
  sessionId,
  api,
  inspectMode,
  onInspectClick,
}: DeviceScreenProps) {
  return (
    <div
      className="relative overflow-hidden bg-black"
      style={{
        borderRadius: '2rem',
        border: inspectMode ? '2px solid var(--rl-accent)' : '2px solid var(--rl-border)',
        maxHeight: '100%',
        maxWidth: '100%',
        aspectRatio: '9 / 19.5',
        boxShadow: inspectMode
          ? '0 0 0 2px var(--rl-accent), 0 4px 32px rgba(0,0,0,0.5)'
          : '0 4px 32px rgba(0,0,0,0.5)',
        transition: 'border-color 0.2s, box-shadow 0.2s',
      }}
    >
      <TouchSurface
        sessionId={sessionId}
        api={api}
        inspectMode={inspectMode}
        onInspectClick={onInspectClick}
      >
        <MjpegCanvas
          src={streamUrl}
          className="w-full h-full object-contain"
        />
      </TouchSurface>
    </div>
  )
}
