import { useRef, useState, ReactNode, WheelEvent, PointerEvent } from 'react'
import type { SessionClient } from '../api/client'

// Approximate logical screen dimensions for coordinate mapping (iPhone-ish)
const LOGICAL_WIDTH = 393
const LOGICAL_HEIGHT = 852

interface TouchSurfaceProps {
  sessionId: string
  api: SessionClient
  children: ReactNode
  inspectMode?: boolean
  onInspectClick?: (x: number, y: number) => void
}

function normalize(
  clientX: number,
  clientY: number,
  rect: DOMRect
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
  }
}

export default function TouchSurface({
  sessionId,
  api,
  children,
  inspectMode,
  onInspectClick,
}: TouchSurfaceProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pressing, setPressing] = useState(false)

  function getPoint(e: PointerEvent) {
    const rect = ref.current!.getBoundingClientRect()
    return normalize(e.clientX, e.clientY, rect)
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return

    if (inspectMode && onInspectClick) {
      const rect = ref.current!.getBoundingClientRect()
      const { x, y } = normalize(e.clientX, e.clientY, rect)
      onInspectClick(
        Math.round(x * LOGICAL_WIDTH),
        Math.round(y * LOGICAL_HEIGHT)
      )
      return
    }

    e.currentTarget.setPointerCapture(e.pointerId)
    setPressing(true)
    const pt = getPoint(e)
    api.touch(sessionId, 'Down', [pt]).catch(() => {})
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!pressing || inspectMode) return
    const pt = getPoint(e)
    api.touch(sessionId, 'Move', [pt]).catch(() => {})
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (!pressing || inspectMode) return
    setPressing(false)
    const pt = getPoint(e)
    api.touch(sessionId, 'Up', [pt]).catch(() => {})
  }

  function onWheel(e: WheelEvent<HTMLDivElement>) {
    if (inspectMode) return
    e.preventDefault()
    const rect = ref.current!.getBoundingClientRect()
    const { x, y } = normalize(e.clientX, e.clientY, rect)
    api
      .scroll(sessionId, { x, y, deltaX: e.deltaX, deltaY: e.deltaY })
      .catch(() => {})
  }

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      style={{
        cursor: inspectMode ? 'crosshair' : 'default',
        touchAction: 'none',
        userSelect: 'none',
      }}
    >
      {children}
    </div>
  )
}
