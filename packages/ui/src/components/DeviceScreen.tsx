import type { SessionClient } from '../api/client'
import MjpegCanvas from './MjpegCanvas'
import TouchSurface from './TouchSurface'

interface DeviceScreenProps {
  streamUrl: string
  sessionId: string
  serverUrl: string
  api: SessionClient
}

/**
 * Rounded-rect wrapper that composes MjpegCanvas + TouchSurface.
 * Fills available space while preserving 9:19.5 aspect ratio (iPhone-ish).
 */
export default function DeviceScreen({
  streamUrl,
  sessionId,
  api,
}: DeviceScreenProps) {
  return (
    <div
      className="relative overflow-hidden bg-black"
      style={{
        borderRadius: '2rem',
        border: '2px solid var(--rl-border)',
        maxHeight: '100%',
        maxWidth: '100%',
        aspectRatio: '9 / 19.5',
        boxShadow: '0 4px 32px rgba(0,0,0,0.5)',
      }}
    >
      <TouchSurface sessionId={sessionId} api={api}>
        <MjpegCanvas
          src={streamUrl}
          className="w-full h-full object-contain"
        />
      </TouchSurface>
    </div>
  )
}
