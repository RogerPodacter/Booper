import { useEffect, useRef } from 'react'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  color: string
  rotation: number
  rotationSpeed: number
  alpha: number
}

interface PixelExplosionProps {
  /** Image source to explode */
  imageSrc?: string
  /** Video element to capture and explode */
  videoElement?: HTMLVideoElement | null
  /** Trigger the explosion */
  trigger: boolean
  /** Callback when animation completes */
  onComplete?: () => void
  /** Pixel block size */
  pixelSize?: number
}

export default function PixelExplosion({
  imageSrc,
  videoElement,
  trigger,
  onComplete,
  pixelSize = 10
}: PixelExplosionProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animationRef = useRef<number>(0)
  const startedRef = useRef(false)

  useEffect(() => {
    if (!trigger || startedRef.current) return
    startedRef.current = true

    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Set canvas to container size with DPR scaling for sharp rendering
    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const cssWidth = Math.round(rect.width)
    const cssHeight = Math.round(rect.height)

    // Guard against 0×0 dimensions (can happen during layout changes)
    if (cssWidth === 0 || cssHeight === 0) return

    canvas.width = cssWidth * dpr
    canvas.height = cssHeight * dpr
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`
    ctx.scale(dpr, dpr)

    // Create capture canvas at CSS pixel size (for particle sampling)
    const capture = document.createElement('canvas')
    const captureCtx = capture.getContext('2d')
    if (!captureCtx) return

    capture.width = cssWidth
    capture.height = cssHeight

    // Draw source to capture canvas
    const drawSource = (): boolean => {
      if (videoElement) {
        try {
          drawMediaCover(captureCtx, videoElement, capture.width, capture.height)
          return true
        } catch {
          return false
        }
      }

      if (imageSrc) {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.src = imageSrc

        if (img.complete) {
          drawMediaCover(captureCtx, img, capture.width, capture.height)
          return true
        }

        // Wait for image load
        img.onload = () => {
          drawMediaCover(captureCtx, img, capture.width, capture.height)
          startAnimation()
        }
        return false
      }

      return false
    }

    const createParticles = (): Particle[] => {
      const imageData = captureCtx.getImageData(0, 0, capture.width, capture.height)
      const particles: Particle[] = []

      const centerX = capture.width / 2
      const centerY = capture.height / 2

      for (let y = 0; y < capture.height; y += pixelSize) {
        for (let x = 0; x < capture.width; x += pixelSize) {
          const i = (y * capture.width + x) * 4
          const r = imageData.data[i]
          const g = imageData.data[i + 1]
          const b = imageData.data[i + 2]
          const a = imageData.data[i + 3]

          if (a < 50) continue

          // Direction away from center
          const dx = x - centerX
          const dy = y - centerY

          const speed = 4 + Math.random() * 6
          const angle = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.8

          particles.push({
            x,
            y,
            vx: Math.cos(angle) * speed + (Math.random() - 0.5) * 2,
            vy: Math.sin(angle) * speed + (Math.random() - 0.5) * 2 - 1,
            size: pixelSize + Math.random() * 2,
            color: `rgb(${r},${g},${b})`,
            rotation: Math.random() * Math.PI * 2,
            rotationSpeed: (Math.random() - 0.5) * 0.2,
            alpha: 1
          })
        }
      }

      return particles
    }

    let particles: Particle[] = []
    let startTime = 0
    const duration = 1200
    const gravity = 0.12

    const animate = (time: number) => {
      if (!startTime) startTime = time
      const elapsed = time - startTime

      // Clear using CSS dimensions (ctx is scaled by DPR)
      ctx.clearRect(0, 0, cssWidth, cssHeight)

      let active = 0

      for (const p of particles) {
        // Physics
        p.vy += gravity
        p.x += p.vx
        p.y += p.vy
        p.rotation += p.rotationSpeed

        // Fade out
        const fadeStart = duration * 0.3
        if (elapsed > fadeStart) {
          p.alpha = Math.max(0, 1 - (elapsed - fadeStart) / (duration - fadeStart))
        }

        // Bounds check using CSS dimensions
        if (p.alpha <= 0 || p.y > cssHeight + 50) continue
        active++

        // Draw
        ctx.save()
        ctx.globalAlpha = p.alpha
        ctx.fillStyle = p.color
        ctx.translate(p.x + p.size / 2, p.y + p.size / 2)
        ctx.rotate(p.rotation)
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size)
        ctx.restore()
      }

      if (active > 0 && elapsed < duration + 300) {
        animationRef.current = requestAnimationFrame(animate)
      } else {
        onComplete?.()
      }
    }

    const startAnimation = () => {
      particles = createParticles()
      animationRef.current = requestAnimationFrame(animate)
    }

    if (drawSource()) {
      startAnimation()
    }

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [trigger, imageSrc, videoElement, onComplete, pixelSize])

  // Reset started flag when trigger changes to false
  useEffect(() => {
    if (!trigger) {
      startedRef.current = false
    }
  }, [trigger])

  if (!trigger) return null

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 z-50 pointer-events-none"
      style={{ width: '100%', height: '100%' }}
    />
  )
}

function drawMediaCover(
  ctx: CanvasRenderingContext2D,
  media: HTMLImageElement | HTMLVideoElement,
  width: number,
  height: number
) {
  const mediaWidth = media instanceof HTMLVideoElement ? media.videoWidth : media.width
  const mediaHeight = media instanceof HTMLVideoElement ? media.videoHeight : media.height

  const mediaRatio = mediaWidth / mediaHeight
  const canvasRatio = width / height

  let drawWidth: number, drawHeight: number, offsetX = 0, offsetY = 0

  // Use "cover" logic: fill canvas, may crop edges
  if (canvasRatio > mediaRatio) {
    // Canvas is wider than media - fit to width, crop top/bottom
    drawWidth = width
    drawHeight = width / mediaRatio
    offsetY = (height - drawHeight) / 2
  } else {
    // Canvas is taller than media - fit to height, crop left/right
    drawHeight = height
    drawWidth = height * mediaRatio
    offsetX = (width - drawWidth) / 2
  }

  ctx.drawImage(media, offsetX, offsetY, drawWidth, drawHeight)
}
