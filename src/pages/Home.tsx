import { useState, useRef, useEffect, useCallback } from 'react'
import { PiPaperPlaneRightFill, PiDownloadSimpleBold } from 'react-icons/pi'
import { generateKey, exportKey, encrypt, compressImage } from '../crypto'
import Stage from '../components/Stage'

type Step = 'camera' | 'edit' | 'sending'
type NotificationStatus = 'loading' | 'unsupported' | 'denied' | 'prompt' | 'subscribed'
type CameraFacing = 'user' | 'environment'

interface HistoryEntry {
  id: string
  createdAt: number
  status: 'pending' | 'opened' | 'expired'
}

const HISTORY_KEY = 'booper_history'
const ONBOARDING_KEY = 'booper_onboarded'
const MAX_HISTORY = 50
const MAX_VIDEO_DURATION = 15 // seconds
const MAX_CONTENT_SIZE = 15 * 1024 * 1024 // 15MB - must match server limit in functions/api/secrets.ts
const MAX_RAW_FILE_SIZE = Math.floor(MAX_CONTENT_SIZE * 0.75) // ~75% to leave room for base64 (~33%) + encryption overhead

export default function Home() {
  const [photo, setPhoto] = useState<string | null>(null)
  const [video, setVideo] = useState<string | null>(null)
  const [videoFromGallery, setVideoFromGallery] = useState(false)
  const [overlayText, setOverlayText] = useState('')
  const [textPosition, setTextPosition] = useState(50) // percentage from top
  const [isEditingText, setIsEditingText] = useState(false)
  const [showTimerPicker, setShowTimerPicker] = useState(false)
  const [duration, setDuration] = useState(5)
  const [step, setStep] = useState<Step>('camera')
  const [error, setError] = useState('')
  const [notifStatus, setNotifStatus] = useState<NotificationStatus>('loading')
  const [toast, setToast] = useState<{ message: string; visible: boolean; isError?: boolean }>({ message: '', visible: false })
  const [showInfo, setShowInfo] = useState(false)
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem(ONBOARDING_KEY))

  // History state
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)

  // Camera state
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [facingMode, setFacingMode] = useState<CameraFacing>('user')
  const [flashEnabled, setFlashEnabled] = useState(false)
  const [hasFlash, setHasFlash] = useState(false)
  const [screenFlash, setScreenFlash] = useState(false)

  // Video recording state
  const [isRecording, setIsRecording] = useState(false)
  const [recordingProgress, setRecordingProgress] = useState(0)

  const [previewMuted, setPreviewMuted] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const libraryInputRef = useRef<HTMLInputElement>(null)
  const subscribingRef = useRef(false)

  // Video recording refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const recordingTimerRef = useRef<number | null>(null)
  const recordingStartTimeRef = useRef<number>(0)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const recordingStartingRef = useRef(false) // Guards against race during async mic permission
  const recordingCancelledRef = useRef(false) // True if user released before recording started

  // Camera lifecycle - keep running in background for instant return
  useEffect(() => {
    if (showWelcome) return

    let cancelled = false

    async function initCamera() {
      setCameraError(null)
      setCameraReady(false)

      try {
        // Stop any existing stream
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop())
          streamRef.current = null
        }

        // Counterintuitive: on landscape screens we request portrait ratio (9/16)
        // because the camera sensor orientation differs from screen orientation
        const isLandscapeNow = window.screen?.orientation?.type?.startsWith('landscape')
        ?? (window.innerWidth > window.innerHeight)
        const requestedAspectRatio = isLandscapeNow ? 9/16 : 16/9
        
        const constraints: MediaStreamConstraints = {
          video: {
            facingMode,
            aspectRatio: { ideal: requestedAspectRatio },
          },
          audio: false
        }

        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        
        if (cancelled) {
          stream.getTracks().forEach(track => track.stop())
          return
        }

        streamRef.current = stream

        if (videoRef.current) {
          videoRef.current.srcObject = stream

          // iOS PWA can fail on cold start - retry once after brief delay
          try {
            await videoRef.current.play()
          } catch {
            await new Promise(r => setTimeout(r, 150))
            if (!cancelled && videoRef.current) {
              await videoRef.current.play().catch(() => {})
            }
          }

          // Show viewfinder once stream attached (even if autoplay blocked)
          setCameraReady(true)

          // Check for flash/torch support
          const track = stream.getVideoTracks()[0]
          const capabilities = track.getCapabilities?.() as MediaTrackCapabilities & { torch?: boolean }
          setHasFlash(!!capabilities?.torch)
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Camera error:', err)
          if (err instanceof DOMException) {
            if (err.name === 'NotAllowedError') {
              setCameraError('Camera access denied. Use the gallery instead.')
            } else if (err.name === 'NotFoundError') {
              setCameraError('No camera found. Use the gallery instead.')
            } else {
              setCameraError('Could not start camera. Try refreshing.')
            }
          } else {
            setCameraError('Could not start camera. Try refreshing.')
          }
        }
      }
    }

    initCamera()

    return () => {
      cancelled = true
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop())
        streamRef.current = null
      }
    }
  }, [facingMode, showWelcome])

  // iOS PWA fix: re-attach video stream when returning from background or entering camera step
  useEffect(() => {
    if (step !== 'camera') return

    function reattachStream() {
      if (videoRef.current && streamRef.current) {
        videoRef.current.srcObject = streamRef.current
        videoRef.current.play().catch(() => {})
      }
    }

    // Reattach immediately when entering camera step (handles resume from edit)
    reattachStream()

    function handleVisibility() {
      if (document.visibilityState === 'visible') reattachStream()
    }

    function handlePageShow(e: PageTransitionEvent) {
      if (e.persisted) reattachStream()
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('pageshow', handlePageShow)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('pageshow', handlePageShow)
    }
  }, [step])

  // Check notification status on mount
  useEffect(() => {
    checkNotificationStatus()
  }, [])

  // Load history from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(HISTORY_KEY)
      if (stored) {
        setHistory(JSON.parse(stored))
      }
    } catch {
      // Invalid data, ignore
    }
  }, [])

  function addToHistory(id: string) {
    setHistory(prev => {
      const entry: HistoryEntry = {
        id,
        createdAt: Date.now(),
        status: 'pending'
      }
      const updated = [entry, ...prev].slice(0, MAX_HISTORY)
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(updated))
      } catch {
        // localStorage full or private mode
      }
      return updated
    })
  }

  async function refreshHistoryStatuses() {
    if (history.length === 0) return
    setHistoryLoading(true)

    try {
      // Fetch statuses for pending entries
      const statusMap = new Map<string, { status: 'opened' | 'expired' }>()

      await Promise.all(
        history.map(async (entry) => {
          if (entry.status !== 'pending') return

          try {
            const res = await fetch(`/api/secrets/${entry.id}/status`)
            const data = await res.json()

            if (data.status === 'revealed') {
              statusMap.set(entry.id, { status: 'opened' })
            } else if (data.status === 'not_found') {
              const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
              if (entry.createdAt < sevenDaysAgo) {
                // Older than 7 days - naturally expired (TTL)
                statusMap.set(entry.id, { status: 'expired' })
              } else {
                // Younger than 7 days but gone - tombstone expired, was opened
                statusMap.set(entry.id, { status: 'opened' })
              }
            }
          } catch {
            // Network error, keep as pending
          }
        })
      )

      // Merge with current state (preserves entries added during fetch)
      setHistory(current => {
        if (current.length === 0) return current
        const updated = current.map(entry => {
          const newStatus = statusMap.get(entry.id)
          return newStatus ? { ...entry, ...newStatus } : entry
        })
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(updated))
        } catch {
          // localStorage error
        }
        return updated
      })
    } finally {
      setHistoryLoading(false)
    }
  }

  function openHistory() {
    setShowHistory(true)
    refreshHistoryStatuses()
  }

  function clearHistory() {
    try {
      localStorage.removeItem(HISTORY_KEY)
    } catch {
      // localStorage error
    }
    setHistory([])
  }

  function completeOnboarding() {
    try { localStorage.setItem(ONBOARDING_KEY, '1') } catch {}
    setShowWelcome(false)
  }

  function toggleFlash() {
    setFlashEnabled(prev => !prev)
  }

  async function fireFlash(on: boolean) {
    if (!streamRef.current || !hasFlash) return
    const track = streamRef.current.getVideoTracks()[0]
    try {
      await track.applyConstraints({
        advanced: [{ torch: on } as MediaTrackConstraintSet]
      })
    } catch {
      // Flash not supported
    }
  }

  function flipCamera() {
    setFacingMode(prev => prev === 'user' ? 'environment' : 'user')
  }

  const capturePhoto = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) return

    const useScreenFlash = facingMode === 'user' && flashEnabled
    const useTorchFlash = facingMode === 'environment' && flashEnabled && hasFlash

    // Activate flash before capture
    if (useScreenFlash) {
      setScreenFlash(true)
      await new Promise(r => setTimeout(r, 1000))
    } else if (useTorchFlash) {
      await fireFlash(true)
      await new Promise(r => setTimeout(r, 250))
    }

    const video = videoRef.current
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')!

    // Fixed 9:16 output - always capture to this aspect ratio
    const targetW = 1080
    const targetH = 1920
    const targetRatio = 9 / 16

    const srcW = video.videoWidth
    const srcH = video.videoHeight
    const srcRatio = srcW / srcH

    // Center-cover crop to 9:16
    let cropX: number, cropY: number, cropW: number, cropH: number
    if (srcRatio > targetRatio) {
      // Source wider than 9:16 - crop sides
      cropH = srcH
      cropW = srcH * targetRatio
      cropX = (srcW - cropW) / 2
      cropY = 0
    } else {
      // Source taller than 9:16 - crop top/bottom
      cropW = srcW
      cropH = srcW / targetRatio
      cropX = 0
      cropY = (srcH - cropH) / 2
    }

    // Scale output to not exceed source resolution
    const scale = Math.min(1, cropW / targetW, cropH / targetH)
    canvas.width = Math.round(targetW * scale)
    canvas.height = Math.round(targetH * scale)

    // Mirror style: capture what the user saw (selfies stay mirrored)
    if (facingMode === 'user') {
      ctx.translate(canvas.width, 0)
      ctx.scale(-1, 1)
    }
    ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height)

    // Turn off flash
    if (useScreenFlash) {
      setScreenFlash(false)
    } else if (useTorchFlash) {
      await fireFlash(false)
    }

    const dataUrl = canvas.toDataURL('image/jpeg', 0.9)

    try {
      const blob = await fetch(dataUrl).then(r => r.blob())
      const file = new File([blob], 'photo.jpg', { type: 'image/jpeg' })
      const compressed = await compressImage(file)
      setPhoto(compressed)
      setStep('edit')
    } catch {
      setPhoto(dataUrl)
      setStep('edit')
    }
  }, [facingMode, flashEnabled, hasFlash])

  // Start video recording
  const startRecording = useCallback(async () => {
    if (!streamRef.current || isRecording || recordingStartingRef.current) return
    if (typeof MediaRecorder === 'undefined') {
      setError('Video recording not supported')
      return
    }

    // Set flags immediately to prevent race conditions
    recordingStartingRef.current = true
    recordingCancelledRef.current = false

    // Clear any existing photo
    if (photo) {
      setPhoto(null)
    }

    try {
      // Request audio stream
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (recordingCancelledRef.current) {
        audioStream.getTracks().forEach(track => track.stop())
        recordingStartingRef.current = false
        return
      }
      audioStreamRef.current = audioStream

      // Combine video and audio tracks
      const videoTrack = streamRef.current.getVideoTracks()[0]
      if (!videoTrack) {
        throw new Error('No video track available')
      }
      const audioTrack = audioStream.getAudioTracks()[0]
      const combinedStream = new MediaStream([videoTrack, audioTrack])

      // Prefer MP4 for cross-platform compatibility (iOS Safari can't play WebM)
      // Check each format for support, fall back to no mimeType if none supported
      let mimeType: string | undefined
      if (MediaRecorder.isTypeSupported('video/mp4')) {
        mimeType = 'video/mp4'
      } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) {
        mimeType = 'video/webm;codecs=vp9'
      } else if (MediaRecorder.isTypeSupported('video/webm')) {
        mimeType = 'video/webm'
      }
      // If no mimeType, let browser pick default

      const mediaRecorder = new MediaRecorder(combinedStream, {
        ...(mimeType && { mimeType }),
        videoBitsPerSecond: 600000, // 0.6 Mbps - keeps 15s ~1.2MB, safe under 3MB limit
        audioBitsPerSecond: 64000,
      })

      const actualMimeType = mediaRecorder.mimeType // Get what browser actually chose

      recordingChunksRef.current = []

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          recordingChunksRef.current.push(e.data)
        }
      }

      mediaRecorder.onstop = () => {
        // Clean up refs
        mediaRecorderRef.current = null
        recordingStartingRef.current = false

        // Clean up audio stream
        if (audioStreamRef.current) {
          audioStreamRef.current.getTracks().forEach(track => track.stop())
          audioStreamRef.current = null
        }

        // Only create video if we have chunks (not cancelled early)
        if (recordingChunksRef.current.length > 0) {
          const blob = new Blob(recordingChunksRef.current, { type: actualMimeType })
          const videoUrl = URL.createObjectURL(blob)
          setVideo(videoUrl)
          setStep('edit')
        }

        setIsRecording(false)
        setRecordingProgress(0)
      }

      mediaRecorderRef.current = mediaRecorder
      mediaRecorder.start(100) // Collect data every 100ms

      recordingStartTimeRef.current = Date.now()
      setIsRecording(true)
      setVideoFromGallery(false)
      if ('vibrate' in navigator) navigator.vibrate(50)

      // Update progress with requestAnimationFrame
      const updateProgress = () => {
        const elapsed = (Date.now() - recordingStartTimeRef.current) / 1000
        const progress = Math.min(elapsed / MAX_VIDEO_DURATION, 1)
        setRecordingProgress(progress)

        if (progress >= 1) {
          stopRecording()
        } else if (mediaRecorderRef.current?.state === 'recording') {
          recordingTimerRef.current = requestAnimationFrame(updateProgress)
        }
      }
      recordingTimerRef.current = requestAnimationFrame(updateProgress)
    } catch (err) {
      console.error('Failed to start recording:', err)
      // Clean up audio stream if acquired
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach(track => track.stop())
        audioStreamRef.current = null
      }
      recordingStartingRef.current = false
      setError('Could not start recording')
    }
  }, [isRecording, photo])

  // Stop video recording
  const stopRecording = useCallback(() => {
    if (recordingTimerRef.current) {
      cancelAnimationFrame(recordingTimerRef.current)
      recordingTimerRef.current = null
    }

    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
  }, [])

  // Cleanup recording resources on unmount only
  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) {
        cancelAnimationFrame(recordingTimerRef.current)
      }
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach(track => track.stop())
      }
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
      }
    }
  }, [])

  // Revoke previous video blob URL when video changes
  const prevVideoRef = useRef<string | null>(null)
  useEffect(() => {
    if (prevVideoRef.current && prevVideoRef.current !== video) {
      URL.revokeObjectURL(prevVideoRef.current)
    }
    prevVideoRef.current = video
  }, [video])

  // Shutter button handlers
  const handleShutterDown = useCallback(() => {
    if (!cameraReady && !cameraError) return

    // Start long press timer - 80ms to trigger video (audio acquisition adds natural delay)
    longPressTimerRef.current = window.setTimeout(() => {
      startRecording()
    }, 150)
  }, [cameraReady, cameraError, startRecording])

  const handleShutterUp = useCallback(() => {
    // Clear long press timer if still pending
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }

    // If recording is starting (async mic permission), mark as cancelled
    if (recordingStartingRef.current && mediaRecorderRef.current?.state !== 'recording') {
      recordingCancelledRef.current = true
    }

    // Check actual recorder state, not React state (could be stale in closure)
    if (mediaRecorderRef.current?.state === 'recording') {
      stopRecording()
    }
  }, [stopRecording])

  const handleShutterTap = useCallback(() => {
    // Only capture photo if not recording/starting and long press didn't trigger
    if (!isRecording && !recordingStartingRef.current && !mediaRecorderRef.current) {
      // Clear any existing video before taking photo
      if (video) {
        URL.revokeObjectURL(video)
        setVideo(null)
      }
      capturePhoto()
    }
  }, [isRecording, capturePhoto, video])

  async function checkNotificationStatus() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setNotifStatus('unsupported')
      return
    }

    // Check if notifications are enabled server-side
    const configRes = await fetch('/api/vapid-public-key')
    const config = await configRes.json()
    if (!config.enabled) {
      setNotifStatus('unsupported')
      return
    }

    if (Notification.permission === 'denied') {
      setNotifStatus('denied')
      return
    }

    try {
      const registration = await navigator.serviceWorker.ready
      const existingSub = await registration.pushManager.getSubscription()

      if (existingSub) {
        // Verify subscription matches current VAPID key
        const response = await fetch('/api/vapid-public-key')
        const { publicKey } = await response.json()
        const expectedKey = urlBase64ToUint8Array(publicKey)
        const existingKey = existingSub.options?.applicationServerKey

        if (existingKey) {
          const existingKeyArray = new Uint8Array(existingKey as ArrayBuffer)
          const keysMatch = expectedKey.length === existingKeyArray.length &&
            expectedKey.every((b, i) => b === existingKeyArray[i])

          if (!keysMatch) {
            await existingSub.unsubscribe()
            await subscribeToPush()
            return
          }
        }
        setNotifStatus('subscribed')
      } else if (Notification.permission === 'granted') {
        // Permission granted but not subscribed - subscribe now
        await subscribeToPush()
      } else {
        setNotifStatus('prompt')
      }
    } catch {
      setNotifStatus('unsupported')
    }
  }

  async function subscribeToPush() {
    // Prevent concurrent subscription attempts (React Strict Mode)
    if (subscribingRef.current) return
    subscribingRef.current = true

    try {
      const registration = await navigator.serviceWorker.ready

      const existing = await registration.pushManager.getSubscription()
      if (existing) {
        setNotifStatus('subscribed')
        return
      }

      const response = await fetch('/api/vapid-public-key')
      const config = await response.json()
      if (!config.enabled) {
        setNotifStatus('unsupported')
        return
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey) as BufferSource
      })

      if (subscription) {
        setNotifStatus('subscribed')
      }
    } catch {
      setNotifStatus('denied')
    } finally {
      subscribingRef.current = false
    }
  }

  async function handleEnableNotifications() {
    try {
      const permission = await Notification.requestPermission()
      if (permission === 'granted') {
        await subscribeToPush()
      } else {
        setNotifStatus('denied')
      }
    } catch {
      setNotifStatus('denied')
    }
  }

  async function handleMediaSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    // Reset input so re-selecting the same file triggers onChange
    e.target.value = ''

    // Check file size
    if (file.size > MAX_RAW_FILE_SIZE) {
      showToast(`File too large. Max ${Math.floor(MAX_RAW_FILE_SIZE / 1024 / 1024)}MB.`, true)
      return
    }

    // Handle video files
    if (file.type.startsWith('video/')) {
      const videoUrl = URL.createObjectURL(file)
      try {
        const duration = await getVideoDuration(videoUrl)
        if (Math.floor(duration) > MAX_VIDEO_DURATION) {
          URL.revokeObjectURL(videoUrl)
          showToast(`Video too long (${Math.floor(duration)}s). Max ${MAX_VIDEO_DURATION}s.`, true)
          return
        }
        setPhoto(null)
        setVideo(videoUrl)
        setVideoFromGallery(true)
        setStep('edit')
        setError('')
      } catch {
        URL.revokeObjectURL(videoUrl)
        showToast('Failed to process video.', true)
      }
      return
    }

    // Handle image files
    if (file.type.startsWith('image/')) {
      try {
        const compressed = await compressImage(file)
        setVideo(null) // useEffect handles URL revocation
        setVideoFromGallery(false)
        setPhoto(compressed)
        setStep('edit')
        setError('')
      } catch {
        showToast('Failed to process image.', true)
      }
      return
    }
  }

  function showToast(message: string, isError = false) {
    setToast({ message, visible: true, isError })
    setTimeout(() => setToast({ message: '', visible: false }), 3000)
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const input = document.createElement('input')
      input.value = text
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      document.body.removeChild(input)
    }
  }

  function generateId(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    const bytes = new Uint8Array(8)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, b => chars[b % chars.length]).join('')
  }

  async function handleSend() {
    if (!photo && !video) return

    setError('')

    try {
      // Generate ID and key client-side (instant)
      const id = generateId()
      const key = await generateKey()
      const keyString = await exportKey(key)
      const url = `${window.location.origin}/s/${id}#${keyString}`

      // Build content based on media type
      let contentObj: Record<string, unknown>
      if (video) {
        // Convert video blob URL to base64
        const response = await fetch(video)
        const blob = await response.blob()
        const videoDataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(reader.result as string)
          reader.readAsDataURL(blob)
        })
        contentObj = {
          video: videoDataUrl,
          text: overlayText || undefined,
          textPosition: overlayText ? textPosition : undefined,
          mirrored: (facingMode === 'user' && !videoFromGallery) || undefined
        }
      } else {
        contentObj = {
          image: photo,
          text: overlayText || undefined,
          textPosition: overlayText ? textPosition : undefined
        }
      }

      // Encrypt metadata (type + duration) and content separately
      // Server only sees opaque blobs - doesn't know type or duration
      const contentType = video ? 'video' : 'photo'
      const metaObj = { contentType, viewDuration: duration }
      const encryptedMeta = await encrypt(JSON.stringify(metaObj), key)
      const encryptedContent = await encrypt(JSON.stringify(contentObj), key)

      // Check size before upload (fail fast)
      if (encryptedContent.length > MAX_CONTENT_SIZE) {
        setError('Content too large. Try a shorter video or smaller image.')
        setStep('edit')
        return
      }

      // Get push subscription if available
      let pushSubscription = null
      if ('serviceWorker' in navigator && 'PushManager' in window) {
        try {
          const registration = await navigator.serviceWorker.ready
          const subscription = await registration.pushManager.getSubscription()
          if (subscription) {
            pushSubscription = subscription.toJSON()
          }
        } catch {
          // Subscription not available
        }
      }

      // Start upload in background
      const uploadPromise = fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          encryptedMeta,
          encryptedContent,
          pushSubscription
        })
      }).then(async (res) => {
        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error || 'Failed to create secret')
        }
        return res.json()
      })

      // Show share sheet immediately
      let usedNativeShare = false
      if (navigator.share) {
        try {
          await navigator.share({ url })
          usedNativeShare = true
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            // User canceled: stay on edit screen
            return
          }
          // Other error: fallback to copy
          await copyToClipboard(url)
        }
      } else {
        // Desktop: copy to clipboard
        await copyToClipboard(url)
      }

      // Wait for upload to complete, then show confirmation
      setStep('sending')
      try {
        await uploadPromise
        addToHistory(id)
        showToast(usedNativeShare ? 'Boop sent!' : 'Link copied!')
        handleNew()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed')
        setStep('edit')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setStep('edit')
    }
  }

  function handleNew() {
    // Revoke video blob URL to free memory
    if (video) URL.revokeObjectURL(video)
    setPhoto(null)
    setVideo(null)
    setVideoFromGallery(false)
    setOverlayText('')
    setTextPosition(50)
    setIsEditingText(false)
    setShowTimerPicker(false)
    setDuration(5)
    setPreviewMuted(true)
    setStep('camera')
    setError('')
  }

  function handleBack() {
    // Revoke video blob URL to free memory
    if (video) URL.revokeObjectURL(video)
    setPhoto(null)
    setVideo(null)
    setVideoFromGallery(false)
    setOverlayText('')
    setTextPosition(50)
    setIsEditingText(false)
    setShowTimerPicker(false)
    setPreviewMuted(true)
    setStep('camera')
  }

  // Save video to device
  async function handleSaveVideo() {
    if (isSaving || !video) return
    setIsSaving(true)

    try {
      const response = await fetch(video)
      const blob = await response.blob()
      const ext = getVideoExtension(blob.type)
      const saved = await saveBlob(blob, `boop-${getTimestamp()}.${ext}`)
      if (saved) showToast('Saved!')
    } catch (err) {
      console.error('Save failed:', err)
      const message = (err as Error).message === 'Sharing not supported'
        ? 'Saving not supported on this browser'
        : 'Save failed'
      showToast(message, true)
    } finally {
      setIsSaving(false)
    }
  }

  // Save photo (with text overlay baked in) to device
  async function handleSavePhoto() {
    if (isSaving || !photo) return
    setIsSaving(true)

    try {
      const img = new Image()
      img.src = photo
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('Failed to load image'))
      })

      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')!

      ctx.drawImage(img, 0, 0)

      // Draw text overlay if present
      if (overlayText) {
        const fontSize = Math.round(canvas.height * 0.035)
        ctx.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'

        const textX = canvas.width / 2
        const textY = canvas.height * (textPosition / 100)

        // Measure text for background
        const metrics = ctx.measureText(overlayText)
        const padX = fontSize * 0.5
        const padY = fontSize * 0.35
        const bgHeight = fontSize + padY * 2
        const bgWidth = metrics.width + padX * 2

        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
        ctx.fillRect(textX - bgWidth / 2, textY - bgHeight / 2, bgWidth, bgHeight)

        ctx.fillStyle = 'white'
        ctx.fillText(overlayText, textX, textY)
      }

      canvas.toBlob(async (blob: Blob | null) => {
        if (!blob) {
          showToast('Save failed', true)
          setIsSaving(false)
          return
        }
        try {
          const saved = await saveBlob(blob, `boop-${getTimestamp()}.jpg`)
          if (saved) showToast('Saved!')
        } catch (err) {
          console.error('Save failed:', err)
          const message = (err as Error).message === 'Sharing not supported'
            ? 'Saving not supported on this browser'
            : 'Save failed'
          showToast(message, true)
        } finally {
          setIsSaving(false)
        }
      }, 'image/jpeg', 0.9)
    } catch (err) {
      console.error('Save failed:', err)
      showToast('Save failed', true)
      setIsSaving(false)
    }
  }

  function getTimestamp(): string {
    const now = new Date()
    const month = now.toLocaleString('en', { month: 'short' }).toLowerCase()
    const day = now.getDate()
    const hour = now.getHours()
    const min = now.getMinutes().toString().padStart(2, '0')
    const ampm = hour >= 12 ? 'pm' : 'am'
    const hour12 = hour % 12 || 12
    return `${month}${day}-${hour12}${min}${ampm}`
  }

  function getVideoExtension(mimeType: string): string {
    if (mimeType.includes('webm')) return 'webm'
    if (mimeType.includes('quicktime')) return 'mov'
    if (mimeType.includes('ogg')) return 'ogv'
    if (mimeType.includes('3gpp')) return '3gp'
    return 'mp4'
  }

  async function saveBlob(blob: Blob, filename: string): Promise<boolean> {
    const file = new File([blob], filename, { type: blob.type })

    if (!navigator.share || !navigator.canShare?.({ files: [file] })) {
      throw new Error('Sharing not supported')
    }

    try {
      await navigator.share({ files: [file] })
      return true
    } catch (err) {
      if ((err as Error).name === 'AbortError') return false // User cancelled
      throw err
    }
  }

  // Single render with all layers - video always mounted
  return (
    <div className="flex-1 flex flex-col bg-black relative overflow-hidden select-none">
      {/* Hidden canvas for capture */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Screen flash overlay - always playing, z-index toggles visibility */}
      <video
        autoPlay
        loop
        muted
        playsInline
        aria-hidden="true"
        className={`fixed inset-0 w-full h-full object-cover pointer-events-none user-select-none ${!screenFlash ? 'hidden' : ''}`}
        style={{ zIndex: 100 }}
        src="/flash-hdr.mp4"
      />

      {/* Stage - 9:16 centered container for all media content */}
      <Stage>
        {/* Video viewfinder - always mounted, hidden during edit/send */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`pointer-events-none user-select-none absolute inset-0 w-full h-full object-cover ${facingMode === 'user' ? 'scale-x-[-1]' : ''} ${step === 'sending' || !cameraReady ? 'invisible' : ''}`}
        />

        {/* Edit content - visible only in edit step */}
        {step === 'edit' && video && (
          <video
            src={video}
            className={`absolute inset-0 w-full h-full object-cover ${facingMode === 'user' && !videoFromGallery ? 'scale-x-[-1]' : ''}`}
            autoPlay
            loop
            muted={previewMuted}
            playsInline
          />
        )}
        {step === 'edit' && photo && !video && (
          <img
            src={photo}
            alt="Your photo"
            className="absolute inset-0 w-full h-full object-cover"
            draggable={false}
          />
        )}

        {/* Text overlay - inside Stage */}
        {step === 'edit' && (overlayText || isEditingText) && (
          <div
            className="absolute left-0 right-0 z-10 touch-none"
            style={{ top: `${textPosition}%`, transform: 'translateY(-50%)' }}
            onTouchStart={(e) => {
              if (isEditingText) return
              const startY = e.touches[0].clientY
              const startPos = textPosition
              const container = e.currentTarget.parentElement
              if (!container) return

              const handleMove = (ev: TouchEvent) => {
                const deltaY = ev.touches[0].clientY - startY
                const containerHeight = container.clientHeight
                const newPos = startPos + (deltaY / containerHeight) * 100
                setTextPosition(Math.max(15, Math.min(85, newPos)))
              }
              const handleEnd = () => {
                document.removeEventListener('touchmove', handleMove)
                document.removeEventListener('touchend', handleEnd)
              }
              document.addEventListener('touchmove', handleMove)
              document.addEventListener('touchend', handleEnd)
            }}
          >
            {isEditingText ? (
              <input
                type="text"
                autoFocus
                className="w-full px-5 py-3 bg-black/50 text-white text-xl font-medium text-center focus:outline-none"
                placeholder="Add text..."
                value={overlayText}
                onChange={(e) => setOverlayText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setIsEditingText(false)
                }}
                onBlur={() => setIsEditingText(false)}
              />
            ) : (
              <button
                className="w-full px-5 py-3 bg-black/50 text-white text-xl font-medium text-center break-words"
                onClick={() => setIsEditingText(true)}
              >
                {overlayText || 'Tap to add text'}
              </button>
            )}
          </div>
        )}

        {/* === CAMERA CONTROLS (inside Stage) === */}
        {step === 'camera' && (
          <>
            {/* Top controls */}
            <div className="absolute top-0 left-0 right-0 p-4 flex justify-between items-center z-20">
              {/* Flash button */}
              {(facingMode === 'user' || hasFlash) ? (
                <button
                  className={`w-11 h-11 rounded-full flex items-center justify-center ${flashEnabled ? 'bg-yellow-500' : 'bg-zinc-700/80'} ${isRecording || recordingStartingRef.current ? 'opacity-50' : ''}`}
                  onClick={toggleFlash}
                  disabled={isRecording || recordingStartingRef.current}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                    {!flashEnabled && <line x1="2" y1="2" x2="22" y2="22" />}
                  </svg>
                </button>
              ) : (
                <div className="w-11" />
              )}

              <div className="flex items-center gap-2">
                {notifStatus === 'prompt' && (
                  <button
                    className="w-11 h-11 rounded-full bg-zinc-700/80 flex items-center justify-center"
                    onClick={handleEnableNotifications}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                    </svg>
                  </button>
                )}
                <button
                  className="w-11 h-11 rounded-full bg-zinc-700/80 flex items-center justify-center"
                  onClick={openHistory}
                  aria-label="History"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </button>
                <button
                  className="w-11 h-11 rounded-full bg-zinc-700/80 flex items-center justify-center"
                  onClick={() => setShowInfo(true)}
                  aria-label="About Booper"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Bottom controls */}
            <div className="absolute bottom-0 left-0 right-0 px-5 pb-10 pt-5 z-20">
              <div className="flex items-center justify-center gap-6 max-w-sm mx-auto">
                <button
                  className="w-11 h-11 rounded-full bg-zinc-700/80 flex items-center justify-center"
                  onClick={() => libraryInputRef.current?.click()}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                </button>

                <button
                  className="relative w-[88px] h-[88px] flex items-center justify-center disabled:opacity-50"
                  onPointerDown={handleShutterDown}
                  onPointerUp={() => {
                    handleShutterUp()
                    if (!isRecording && !recordingStartingRef.current && !mediaRecorderRef.current) {
                      handleShutterTap()
                    }
                  }}
                  onPointerLeave={handleShutterUp}
                  onPointerCancel={handleShutterUp}
                  disabled={!cameraReady && !cameraError}
                >
                  {/* Shutter button */}
                  <div className={`w-full h-full rounded-full transition-all ${
                    isRecording
                      ? 'bg-accent'
                      : 'bg-transparent border-[6px] border-white active:scale-95'
                  }`} />

                  {/* Progress ring - dark stroke that grows clockwise from 12 o'clock */}
                  {isRecording && (
                    <svg className="absolute inset-0 w-full h-full -rotate-90 pointer-events-none" viewBox="0 0 88 88">
                      <circle
                        cx="44" cy="44" r="39"
                        fill="none"
                        stroke="rgba(0,0,0,0.4)"
                        strokeWidth="10"
                        strokeLinecap="round"
                        strokeDasharray={2 * Math.PI * 39}
                        strokeDashoffset={2 * Math.PI * 39 * (1 - recordingProgress)}
                      />
                    </svg>
                  )}
                </button>

                <button
                  className={`w-11 h-11 rounded-full bg-zinc-700/80 flex items-center justify-center ${isRecording || recordingStartingRef.current ? 'opacity-50' : ''}`}
                  onClick={flipCamera}
                  disabled={isRecording || recordingStartingRef.current}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                    <path d="M21 2v6h-6" />
                    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                    <path d="M3 22v-6h6" />
                    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                  </svg>
                </button>
              </div>
            </div>
          </>
        )}

        {/* === EDIT CONTROLS (inside Stage) === */}
        {step === 'edit' && (photo || video) && (
          <>
            {/* Top controls */}
            <div className="absolute top-0 left-0 right-0 p-4 flex justify-between items-center z-20">
              {/* Back button */}
              <button
                className="w-11 h-11 rounded-full bg-zinc-700/80 flex items-center justify-center"
                onClick={handleBack}
                aria-label="Back"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>

              {/* Mute/unmute button for video */}
              {video ? (
                <button
                  className="w-11 h-11 rounded-full bg-black/60 flex items-center justify-center"
                  onClick={() => setPreviewMuted(!previewMuted)}
                  aria-label={previewMuted ? 'Unmute' : 'Mute'}
                >
                  {previewMuted ? (
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
              ) : (
                <div className="w-11" />
              )}
            </div>

            {/* Timer picker popup */}
            {showTimerPicker && (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50" onClick={() => setShowTimerPicker(false)}>
                <div className="bg-zinc-800 rounded-2xl p-2 flex gap-1" onClick={(e) => e.stopPropagation()}>
                  {[1, 2, 3, 5, 7, 10].map((t) => (
                    <button
                      key={t}
                      className={`w-12 h-12 rounded-xl font-medium transition-all ${
                        duration === t ? 'bg-white text-black' : 'text-white hover:bg-zinc-700'
                      }`}
                      onClick={() => {
                        setDuration(t)
                        setShowTimerPicker(false)
                      }}
                    >
                      {t}s
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Bottom controls */}
            <div className="absolute bottom-0 left-0 right-0 px-5 pb-10 pt-5 z-20">
              <div className="flex items-center justify-center gap-6 max-w-sm mx-auto">
                {/* Left: Text button */}
                <button
                  className="w-11 h-11 rounded-full bg-zinc-700/60 flex items-center justify-center"
                  onClick={() => setIsEditingText(true)}
                >
                  <span className="text-white font-medium text-lg">Aa</span>
                </button>

                <div className="h-[88px] flex items-center justify-center">
                  <button
                    className="px-10 py-4 rounded-full bg-white flex items-center justify-center gap-2 active:scale-95 transition-transform"
                    onClick={handleSend}
                  >
                    <span className="text-black font-semibold text-lg">Send</span>
                    <PiPaperPlaneRightFill className="text-black" size={22} />
                  </button>
                </div>

                {/* Right: Timer for photos, Download for videos */}
                {video ? (
                  <button
                    className={`w-11 h-11 rounded-full bg-zinc-700/60 flex items-center justify-center ${isSaving ? 'opacity-50' : ''}`}
                    onClick={handleSaveVideo}
                    disabled={isSaving}
                    aria-label="Save to device"
                  >
                    {isSaving ? (
                      <div className="w-5 h-5 border-2 border-zinc-500 border-t-white rounded-full animate-spin" />
                    ) : (
                      <PiDownloadSimpleBold className="text-white" size={20} />
                    )}
                  </button>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <button
                      className="w-11 h-11 rounded-full bg-zinc-700/60 flex items-center justify-center"
                      onClick={() => setShowTimerPicker(true)}
                    >
                      <span className="text-white font-medium text-sm">{duration}s</span>
                    </button>
                    {overlayText && (
                      <button
                        className={`w-11 h-11 rounded-full bg-zinc-700/60 flex items-center justify-center ${isSaving ? 'opacity-50' : ''}`}
                        onClick={handleSavePhoto}
                        disabled={isSaving}
                        aria-label="Save to device"
                      >
                        {isSaving ? (
                          <div className="w-5 h-5 border-2 border-zinc-500 border-t-white rounded-full animate-spin" />
                        ) : (
                          <PiDownloadSimpleBold className="text-white" size={20} />
                        )}
                      </button>
                    )}
                  </div>
                )}
              </div>

            {error && (
              <p className="text-accent text-sm text-center mt-3">{error}</p>
            )}
          </div>
        </>
      )}

        {/* === SENDING UI (inside Stage) === */}
        {step === 'sending' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black z-30">
            <div className="w-10 h-10 border-[3px] border-zinc-700 border-t-accent rounded-full animate-spin-slow" />
            <p className="mt-4 text-zinc-400">Finishing up...</p>
          </div>
        )}

        {/* Camera error fallback (inside Stage) */}
        {step === 'camera' && cameraError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black z-10 p-5">
            <p className="text-zinc-400 text-center mb-4">{cameraError}</p>
            <button
              className="btn btn-primary max-w-xs"
              onClick={() => libraryInputRef.current?.click()}
            >
              Choose from Library
            </button>
          </div>
        )}
      </Stage>

      {/* Hidden file input for gallery */}
      <input
        ref={libraryInputRef}
        type="file"
        accept="image/*,video/*"
        onChange={handleMediaSelect}
        className="hidden"
      />

      {/* Toast notification */}
      {toast.visible && (
        <div className={`fixed top-0 left-0 right-0 text-white text-center py-4 font-medium shadow-lg z-50 animate-slide-down ${toast.isError ? 'bg-red-500' : 'bg-emerald-500'}`}>
          {toast.message}
        </div>
      )}

      {/* History Modal */}
      {showHistory && (
        <div className="fixed inset-0 z-50 bg-black/95 flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-5">
            <h2 className="text-xl font-semibold text-white">Boop History</h2>
            <button
              className="w-11 h-11 rounded-full bg-zinc-800 flex items-center justify-center"
              onClick={() => setShowHistory(false)}
              aria-label="Close"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Loading indicator */}
          {historyLoading && (
            <div className="flex justify-center py-3">
              <div className="w-5 h-5 border-2 border-zinc-600 border-t-white rounded-full animate-spin" />
            </div>
          )}

          {/* History list */}
          <div className="flex-1 overflow-y-auto">
            {history.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-zinc-500 px-8">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mb-4 opacity-50">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <p className="text-center">No boops sent yet</p>
              </div>
            ) : (
              <div className="divide-y divide-zinc-800/50">
                {history.map((entry) => (
                  <div key={entry.id} className="px-5 py-4 flex items-center gap-4">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                      entry.status === 'opened' ? 'bg-emerald-500/20' :
                      entry.status === 'expired' ? 'bg-zinc-700/50' :
                      'bg-blue-500/20'
                    }`}>
                      {entry.status === 'opened' ? (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      ) : entry.status === 'expired' ? (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500">
                          <circle cx="12" cy="12" r="10" />
                          <line x1="15" y1="9" x2="9" y2="15" />
                          <line x1="9" y1="9" x2="15" y2="15" />
                        </svg>
                      ) : (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400">
                          <line x1="22" y1="2" x2="11" y2="13" />
                          <polygon points="22 2 15 22 11 13 2 9 22 2" />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white font-medium">
                        {entry.status === 'opened' ? 'Opened' :
                         entry.status === 'expired' ? 'Expired' :
                         'Sent'}
                      </p>
                      <p className="text-zinc-500 text-sm">
                        Sent {formatRelativeTime(entry.createdAt)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Clear button */}
          {history.length > 0 && (
            <div className="p-5 border-t border-zinc-800/50">
              <button
                className="w-full py-3 rounded-xl bg-zinc-800 text-zinc-400 font-medium active:bg-zinc-700 transition-colors"
                onClick={clearHistory}
              >
                Clear History
              </button>
            </div>
          )}
        </div>
      )}

      {/* Info Modal */}
      {showInfo && (
        <div
          className="fixed inset-0 z-50 bg-black/95 flex flex-col overflow-y-auto"
          onClick={() => setShowInfo(false)}
        >
          <div className="flex-1 flex flex-col justify-center px-8 py-16 max-w-md mx-auto" onClick={(e) => e.stopPropagation()}>
            {/* Close button */}
            <button
              className="absolute top-5 right-5 w-11 h-11 rounded-full bg-zinc-800 flex items-center justify-center"
              onClick={() => setShowInfo(false)}
              aria-label="Close"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>

            {/* Logo / Title */}
            <h1 className="text-5xl font-bold text-white tracking-tight mb-2">Booper</h1>
            <p className="text-xl text-zinc-400 mb-10">Disappearing photos & videos</p>

            {/* How it works */}
            <div className="space-y-8">
              <div>
                <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider mb-3">How it works</h2>
                <p className="text-zinc-300 leading-relaxed">
                  <span className="text-white font-medium">Tap</span> to take a photo, <span className="text-white font-medium">hold</span> to record a video (up to 15s). Send a link. Your recipient opens it once, sees it briefly, then it's gone forever. We can't see your content—only you and your recipient can. Unopened boops self-destruct after 7 days.
                </p>
              </div>

              <div>
                <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider mb-3">Under the hood</h2>
                <div className="space-y-4 text-zinc-300 leading-relaxed">
                  <p>
                    Your content is encrypted <span className="text-white font-medium">before</span> it leaves your device using <span className="text-white font-mono text-sm">AES-GCM 256-bit</span> encryption.
                  </p>
                  <p>
                    The decryption key lives only in the URL fragment (the part after the <span className="text-white font-mono text-sm">#</span>). Browsers never send fragments to servers, so we can't decrypt your boops even if we wanted to.
                  </p>
                  <p>
                    When someone views your boop, the encrypted blob is deleted from our servers.
                  </p>
                </div>
              </div>

              <div className="pt-4 border-t border-zinc-800">
                <p className="text-zinc-500 text-sm">
                  Booper is open source.{' '}
                  <a href="https://github.com/RogerPodacter/booper" target="_blank" rel="noopener noreferrer" className="text-zinc-400 underline hover:text-white">
                    View on GitHub
                  </a>
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Welcome Screen */}
      {showWelcome && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col">
          <div className="flex-1 flex flex-col justify-center px-8 max-w-md mx-auto w-full">
            <h1 className="text-5xl font-bold text-white tracking-tight mb-2">Booper</h1>
            <p className="text-xl text-zinc-400 mb-10">Disappearing photos & videos</p>
            <p className="text-zinc-300 leading-relaxed mb-8">
              Send photos and videos that disappear after being viewed once. End-to-end encrypted—we can't see them, only you and your recipient can.
            </p>
            <div className="flex items-start gap-3 bg-zinc-900 rounded-xl p-4">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 shrink-0 mt-0.5">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
              <p className="text-zinc-400 text-sm leading-relaxed">
                We'll ask for camera access next. <span className="text-zinc-300">Tap</span> the shutter for a photo, <span className="text-zinc-300">hold</span> for video. You can also choose from your library.
              </p>
            </div>
          </div>
          <div className="px-8 pb-safe">
            <button
              className="w-full py-4 rounded-full bg-white text-black font-semibold text-lg active:scale-[0.98] transition-transform flex items-center justify-center gap-2"
              onClick={completeOnboarding}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
              Get started
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Helper to format relative time
function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

// Helper to get video duration (does not revoke URL - caller handles cleanup)
function getVideoDuration(videoUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      const d = video.duration
      Number.isFinite(d) ? resolve(d) : reject(new Error('Invalid duration'))
    }
    video.onerror = () => reject(new Error('Failed to load video'))
    video.src = videoUrl
    video.load()
  })
}

// Helper to convert VAPID key
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}
