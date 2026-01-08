import { useEffect, useRef, useCallback } from 'react'

interface PixelatedImageProps {
  src: string
  /** 0 = no pixelation, 1 = maximum pixelation */
  pixelation: number
  className?: string
}

export default function PixelatedImage({ src, pixelation, className = '' }: PixelatedImageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const loadedSrcRef = useRef<string>('')

  const render = useCallback(() => {
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img || !img.complete) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Match canvas size to display size
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    canvas.width = rect.width
    canvas.height = rect.height

    if (pixelation <= 0) {
      drawImageCover(ctx, img, canvas.width, canvas.height)
      return
    }

    // Calculate pixel size (more pixelation = larger pixels)
    // At max pixelation, we want only ~4 pixels across for super chunky effect
    const minPixels = 4
    const maxSize = Math.min(canvas.width, canvas.height)
    const targetPixels = Math.max(minPixels, Math.round(maxSize * (1 - pixelation * 0.99)))

    // Create small canvas for pixelation
    const small = document.createElement('canvas')
    const smallCtx = small.getContext('2d')
    if (!smallCtx) return

    const ratio = canvas.width / canvas.height
    small.width = ratio > 1 ? targetPixels : Math.round(targetPixels * ratio)
    small.height = ratio > 1 ? Math.round(targetPixels / ratio) : targetPixels

    // Draw to small canvas
    drawImageCover(smallCtx, img, small.width, small.height)

    // Scale up with pixelation
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(small, 0, 0, canvas.width, canvas.height)
  }, [pixelation])

  // Load image
  useEffect(() => {
    if (loadedSrcRef.current === src && imageRef.current?.complete) {
      render()
      return
    }

    const img = new Image()
    img.crossOrigin = 'anonymous'

    const handleLoad = () => {
      imageRef.current = img
      loadedSrcRef.current = src
      render()
    }

    img.addEventListener('load', handleLoad)
    img.src = src

    return () => {
      img.removeEventListener('load', handleLoad)
    }
  }, [src, render])

  // Re-render on pixelation change
  useEffect(() => {
    render()
  }, [render])

  // Re-render on resize
  useEffect(() => {
    const handleResize = () => render()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [render])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ imageRendering: pixelation > 0 ? 'pixelated' : 'auto' }}
    />
  )
}

function drawImageCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  width: number,
  height: number
) {
  const imgRatio = img.width / img.height
  const canvasRatio = width / height

  let drawWidth: number, drawHeight: number, offsetX = 0, offsetY = 0

  if (canvasRatio > imgRatio) {
    drawWidth = width
    drawHeight = width / imgRatio
    offsetY = (height - drawHeight) / 2
  } else {
    drawHeight = height
    drawWidth = height * imgRatio
    offsetX = (width - drawWidth) / 2
  }

  ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight)
}
