import { useEffect, useRef } from 'react'

interface MjpegCanvasProps {
  src: string
  className?: string
}

/**
 * Renders an MJPEG stream onto a canvas via requestAnimationFrame.
 * A watchdog reconnects the stream if the image decode stalls.
 */
export default function MjpegCanvas({ src, className }: MjpegCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Hidden image element receives the MJPEG stream
    const img = new Image()
    img.crossOrigin = 'anonymous'
    imgRef.current = img

    function connect() {
      img.src = ''
      img.src = src
    }

    connect()

    // rAF draw loop
    let rafId: number
    function draw() {
      if (img.naturalWidth > 0) {
        if (
          canvas!.width !== img.naturalWidth ||
          canvas!.height !== img.naturalHeight
        ) {
          canvas!.width = img.naturalWidth
          canvas!.height = img.naturalHeight
        }
        ctx!.drawImage(img, 0, 0)
      }
      rafId = requestAnimationFrame(draw)
    }
    rafId = requestAnimationFrame(draw)

    // Watchdog: every 2 s try to decode; if it fails, reconnect
    const watchdog = setInterval(async () => {
      try {
        await img.decode()
      } catch {
        connect()
      }
    }, 2000)

    return () => {
      cancelAnimationFrame(rafId)
      clearInterval(watchdog)
      img.src = ''
    }
  }, [src])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: 'block', maxWidth: '100%', maxHeight: '100%' }}
    />
  )
}
