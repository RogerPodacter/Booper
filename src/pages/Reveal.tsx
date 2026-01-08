import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { importKey, decrypt } from '../crypto'
import PixelExplosion from '../components/PixelExplosion'
import PixelatedImage from '../components/PixelatedImage'
import Stage from '../components/Stage'

type Status = 'loading' | 'ready' | 'revealing' | 'viewing' | 'exploding' | 'expired' | 'already_opened' | 'not_found' | 'error'

interface SecretData {
  contentType: 'photo' | 'video'
  viewDuration: number
}

export default function Reveal() {
  const { id } = useParams<{ id: string }>()
  const [status, setStatus] = useState<Status>('loading')
  const [secretData, setSecretData] = useState<SecretData | null>(null)
  const [photoData, setPhotoData] = useState<{ image: string; text?: string; textPosition?: number } | null>(null)
  const [videoData, setVideoData] = useState<{ video: string; text?: string; textPosition?: number; mirrored?: boolean } | null>(null)
  const [videoMuted, setVideoMuted] = useState(false)
  const [timeLeft, setTimeLeft] = useState(0)
  const [error, setError] = useState('')
  const [notificationsEnabled, setNotificationsEnabled] = useState(false)
  const timerRef = useRef<number | null>(null)
  const startTimeRef = useRef<number>(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const videoEndTimeoutRef = useRef<number | null>(null)

  const keyString = window.location.hash.slice(1)

  useEffect(() => {
    checkStatus()
  }, [id])

  // Reset state when navigating to a new secret (SPA navigation)
  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    setTimeLeft(0)
    setVideoMuted(false)
  }, [id])

  async function checkStatus() {
    try {
      const response = await fetch(`/api/secrets/${id}/status`)
      const data = await response.json()

      if (data.status === 'not_found') {
        setStatus('not_found')
      } else if (data.status === 'revealed') {
        setStatus('already_opened')
      } else if (data.status === 'pending') {
        // Decrypt metadata to get type and duration
        if (!keyString) {
          setError('Invalid link - missing encryption key')
          setStatus('error')
          return
        }
        try {
          const key = await importKey(keyString)
          const decryptedMeta = await decrypt(data.encryptedMeta, key)
          const meta = JSON.parse(decryptedMeta)

          // Validate meta fields
          const contentType = meta.contentType
          const viewDuration = meta.viewDuration
          if (contentType !== 'photo' && contentType !== 'video') {
            throw new Error('Invalid content type')
          }
          if (typeof viewDuration !== 'number' || viewDuration < 1 || viewDuration > 10 || !Number.isFinite(viewDuration)) {
            throw new Error('Invalid view duration')
          }

          setSecretData({ contentType, viewDuration })
          setStatus('ready')

          // Check if notifications are enabled (for warning message)
          fetch('/api/vapid-public-key')
            .then(r => r.json())
            .then(c => setNotificationsEnabled(c.enabled))
            .catch(() => {})
        } catch {
          setError('Invalid link - decryption failed')
          setStatus('error')
        }
      }
    } catch {
      setStatus('error')
      setError('Failed to load secret')
    }
  }

  // Immediately clear content and expire (skips explosion)
  const expireNow = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (videoEndTimeoutRef.current) {
      clearTimeout(videoEndTimeoutRef.current)
      videoEndTimeoutRef.current = null
    }
    setPhotoData(null)
    setVideoData(null)
    setStatus('expired')
  }, [])

  const handleExpire = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    setStatus('exploding')
  }, [])

  const handleExplosionComplete = expireNow

  // Safety timeout for explosion - if it fails to complete, force expire
  useEffect(() => {
    if (status !== 'exploding') return
    const timeout = setTimeout(expireNow, 2000)
    return () => clearTimeout(timeout)
  }, [status, expireNow])

  useEffect(() => {
    if (status !== 'viewing' && status !== 'exploding') return

    function handleVisibilityChange() {
      if (document.hidden) expireNow()
    }

    function handleBlur() {
      expireNow()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('blur', handleBlur)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('blur', handleBlur)
    }
  }, [status, expireNow])

  async function handleReveal() {
    if (!keyString || !secretData) {
      setError('Invalid link - missing encryption key')
      setStatus('error')
      return
    }

    setStatus('revealing')

    try {
      const response = await fetch(`/api/secrets/${id}/reveal`, { method: 'POST' })

      if (!response.ok) {
        const data = await response.json()
        if (response.status === 410) {
          setStatus('already_opened')
          return
        }
        throw new Error(data.error || 'Failed to reveal secret')
      }

      const { encryptedContent } = await response.json()

      const key = await importKey(keyString)
      const decrypted = await decrypt(encryptedContent, key)

      // Use type/duration from secretData (already decrypted from meta)
      const isVideo = secretData.contentType === 'video'
      const viewDuration = secretData.viewDuration
      const content = JSON.parse(decrypted)

      // Validate payload - require data URLs to prevent remote URL tracking
      if (isVideo) {
        if (typeof content.video !== 'string' || !content.video.startsWith('data:video/')) {
          throw new Error('Invalid video format')
        }
        setVideoData(content)
      } else {
        if (typeof content.image !== 'string' || !content.image.startsWith('data:image/')) {
          throw new Error('Invalid image format')
        }
        setPhotoData(content)
      }

      setTimeLeft(viewDuration)
      setStatus('viewing')

      if (isVideo) {
        // Videos: hard 30s deadline prevents pause/stall abuse (max recording is 15s)
        videoEndTimeoutRef.current = window.setTimeout(handleExpire, 30000)
      } else {
        // Photos: countdown timer
        startTimeRef.current = Date.now()
        timerRef.current = window.setInterval(() => {
          const elapsed = (Date.now() - startTimeRef.current) / 1000
          const remaining = Math.max(0, viewDuration - elapsed)
          setTimeLeft(remaining)
          if (remaining <= 0) handleExpire()
        }, 50)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to decrypt')
      setStatus('error')
    }
  }

  const progress = secretData ? timeLeft / secretData.viewDuration : 0

  // Calculate pixelation intensity (starts at 1.5 seconds remaining)
  const effectThreshold = 1.5
  const effectIntensity = timeLeft < effectThreshold && timeLeft > 0
    ? Math.pow(1 - timeLeft / effectThreshold, 2)
    : 0

  // Timer ring component
  const TimerRing = ({ size = 120, strokeWidth = 8 }: { size?: number; strokeWidth?: number }) => {
    const radius = (size - strokeWidth) / 2
    const circumference = 2 * Math.PI * radius
    const offset = circumference * (1 - progress)

    return (
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="#333"
            strokeWidth={strokeWidth}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="#ff3b5c"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="transition-all duration-100"
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-2xl font-bold">
          {Math.ceil(timeLeft)}
        </span>
      </div>
    )
  }

  // Message screen component
  const MessageScreen = ({ icon, title, subtitle, showCreate = true }: { icon: string; title: string; subtitle: string; showCreate?: boolean }) => (
    <div className="flex-1 flex flex-col p-5 max-w-md mx-auto w-full">
      <header className="text-center py-10">
        <Link to="/" className="text-3xl font-bold tracking-tight hover:text-accent transition-colors">Booper</Link>
      </header>
      <div className="flex-1 flex flex-col items-center justify-center text-center gap-3">
        <div className="text-5xl mb-2">{icon}</div>
        <h2 className="text-2xl font-semibold">{title}</h2>
        <p className="text-zinc-500">{subtitle}</p>
        {showCreate && (
          <Link to="/" className="mt-6 btn btn-primary">
            Create your own
          </Link>
        )}
      </div>
    </div>
  )

  if (status === 'loading') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-10 h-10 border-[3px] border-zinc-700 border-t-accent rounded-full animate-spin-slow" />
      </div>
    )
  }

  if (status === 'not_found') {
    return <MessageScreen icon="🔍" title="Boop not found" subtitle="This boop doesn't exist." />
  }

  if (status === 'already_opened') {
    return <MessageScreen icon="👀" title="Already opened" subtitle="This boop has already been viewed." />
  }

  if (status === 'expired') {
    return <MessageScreen icon="💨" title="Poof!" subtitle="This boop has vanished." />
  }

  if (status === 'error') {
    return <MessageScreen icon="⚠️" title="Error" subtitle={error} />
  }

  if (status === 'ready') {
    return (
      <div className="flex-1 flex flex-col p-5 max-w-md mx-auto w-full">
        <header className="text-center py-10">
          <Link to="/" className="text-3xl font-bold tracking-tight hover:text-accent transition-colors">Booper</Link>
        </header>
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-3">
          <div className="text-5xl mb-2">{secretData?.contentType === 'video' ? '🎬' : '🤫'}</div>
          <h2 className="text-2xl font-semibold">
            Someone sent you a {secretData?.contentType === 'video' ? 'video boop' : 'boop'}
          </h2>
          <p className="text-zinc-500">
            {secretData?.contentType === 'video'
              ? "Watch once, then it's gone."
              : `You have ${secretData?.viewDuration} second${secretData?.viewDuration !== 1 ? 's' : ''} to view it.`}
          </p>
          {notificationsEnabled && (
            <p className="text-zinc-600 text-sm mt-2">
              The sender may be notified (incl. approx location).
            </p>
          )}
          <button
            className="mt-6 px-10 py-5 bg-accent text-white text-xl font-semibold rounded-2xl hover:brightness-110 active:scale-[0.98] transition-all"
            onClick={handleReveal}
          >
            Reveal
          </button>
        </div>
      </div>
    )
  }

  if (status === 'revealing') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <div className="w-10 h-10 border-[3px] border-zinc-700 border-t-accent rounded-full animate-spin-slow" />
        <p className="text-zinc-400">Decrypting...</p>
      </div>
    )
  }

  // Viewing video
  if (videoData) {
    const isExploding = status === 'exploding'

    return (
      <div className="flex-1 flex flex-col relative bg-black overflow-hidden select-none">
        {/* Video in Stage */}
        <Stage>
          {/* Pixel explosion - inside Stage for correct positioning */}
          <PixelExplosion
            videoElement={videoRef.current}
            trigger={isExploding}
            onComplete={handleExplosionComplete}
            pixelSize={100}
          />

          <div
            className="absolute inset-0"
            style={{ opacity: isExploding ? 0 : 1 }}
          >
            <video
              ref={videoRef}
              src={videoData.video}
              className={`absolute inset-0 w-full h-full object-cover ${videoData.mirrored ? 'scale-x-[-1]' : ''}`}
              autoPlay
              muted={videoMuted}
              playsInline
              onEnded={() => {
                // Clear hard deadline, set short delay before explosion
                if (videoEndTimeoutRef.current) clearTimeout(videoEndTimeoutRef.current)
                videoEndTimeoutRef.current = window.setTimeout(handleExpire, 500)
              }}
            />

            {videoData.text && (
              <div
                className="absolute left-0 right-0 text-center px-5 py-3 bg-black/50 text-white text-xl font-medium break-words z-10 pointer-events-none"
                style={{ top: `${videoData.textPosition ?? 50}%`, transform: 'translateY(-50%)' }}
              >
                {videoData.text}
              </div>
            )}
          </div>
        </Stage>

        {/* Mute/unmute button - fixed positioning with safe area */}
        {!isExploding && (
          <div className="fixed top-0 left-0 right-0 p-4 pt-safe z-20">
            <button
              className="w-11 h-11 rounded-full bg-black/60 flex items-center justify-center"
              onClick={() => setVideoMuted(!videoMuted)}
              aria-label={videoMuted ? 'Unmute' : 'Mute'}
            >
              {videoMuted ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              )}
            </button>
          </div>
        )}
      </div>
    )
  }

  // Viewing photo
  if (photoData) {
    const isExploding = status === 'exploding'

    return (
      <div className="flex-1 flex flex-col relative bg-black overflow-hidden select-none">
        {/* Photo in Stage */}
        <Stage>
          {/* Pixel explosion - inside Stage for correct positioning */}
          <PixelExplosion
            imageSrc={photoData.image}
            trigger={isExploding}
            onComplete={handleExplosionComplete}
            pixelSize={100}
          />

          <div
            className="absolute inset-0"
            style={{ opacity: isExploding ? 0 : 1 }}
          >
            {effectIntensity > 0 ? (
              <PixelatedImage
                src={photoData.image}
                pixelation={effectIntensity}
                className="absolute inset-0 w-full h-full"
              />
            ) : (
              <img
                src={photoData.image}
                alt="Boop"
                className="absolute inset-0 w-full h-full object-cover"
                draggable={false}
              />
            )}

            
            {/* Text overlay */}
            {photoData.text && (
              <div
                className="absolute left-0 right-0 text-center px-5 py-3 bg-black/50 text-white text-xl font-medium break-words z-10 pointer-events-none"
                style={{
                  top: `${photoData.textPosition ?? 50}%`,
                  transform: 'translateY(-50%)'
                }}
              >
                {photoData.text}
              </div>
            )}
          </div>
        </Stage>

        {/* Timer - fixed positioning with safe area */}
        {!isExploding && (
          <div className="fixed top-0 left-0 right-0 p-4 pt-safe flex justify-end z-20">
            <div className="bg-black/60 rounded-full p-1">
              <TimerRing size={60} strokeWidth={4} />
            </div>
          </div>
        )}
      </div>
    )
  }

  return null
}
