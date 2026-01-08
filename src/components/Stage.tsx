import type { ReactNode } from 'react'

interface StageProps {
  children: ReactNode
  className?: string
}

/**
 * Stage component - a canonical 9:16 container that's consistent everywhere.
 * Sizes itself to fit the viewport while maintaining 9:16 aspect ratio.
 * All content (camera, edit, reveal) renders inside this frame identically.
 */
export default function Stage({ children, className = '' }: StageProps) {
  return (
    <div className="flex-1 flex items-center justify-center bg-black">
      <div
        className={`relative overflow-hidden ${className}`}
        style={{
          width: 'min(100vw, calc(100svh * 9 / 16))',
          height: 'min(100svh, calc(100vw * 16 / 9))',
          maxWidth: '100vw',
          maxHeight: '100svh',
        }}
      >
        {children}
      </div>
    </div>
  )
}
