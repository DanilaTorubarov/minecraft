import { useCallback, useEffect, useRef, useState } from 'react'
import { formatTime, readPlayerSettings, TRACKS, writePlayerSettings, type PlayerSettings } from '../lib/player'
import { TRACK_SOURCES } from '../lib/playerSources'

interface MusicPlayerProps {
  mobileOpen?: boolean
  onToggleMobile?: () => void
  showDefaultToggle?: boolean
}

// Desktop transport; mobile keeps the controls behind a compact toggle.
export default function MusicPlayer({
  mobileOpen: controlledMobileOpen,
  onToggleMobile,
  showDefaultToggle = true,
}: MusicPlayerProps = {}) {
  const [settings, setSettings] = useState<PlayerSettings>(readPlayerSettings)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(true)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [creditsOpen, setCreditsOpen] = useState(false)
  const [internalMobileOpen, setInternalMobileOpen] = useState(false)
  const isControlled = controlledMobileOpen !== undefined
  const mobileOpen = isControlled ? controlledMobileOpen : internalMobileOpen
  const toggleMobile = useCallback(() => {
    if (onToggleMobile) onToggleMobile()
    else setInternalMobileOpen((v) => !v)
    setCreditsOpen(false)
  }, [onToggleMobile])
  const [pageVisible, setPageVisible] = useState(() => !document.hidden)
  const audioRef = useRef<HTMLAudioElement>(null)
  const playerRef = useRef<HTMLElement>(null)
  const creditsRef = useRef<HTMLButtonElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const wantsPlayback = useRef(false)

  const track = TRACKS[settings.track]
  const trackSrc = TRACK_SOURCES[track.id]

  useEffect(() => { writePlayerSettings(settings) }, [settings])

  useEffect(() => {
    const audio = audioRef.current
    if (audio !== null) {
      audio.volume = settings.volume
      audio.muted = settings.muted
    }
  }, [settings.volume, settings.muted])

  // Retain playback intent across source changes; paused tracks stay paused.
  useEffect(() => {
    const audio = audioRef.current
    if (audio !== null && wantsPlayback.current) {
      void audio.play().catch(() => { /* Autoplay or a superseded source change. */ })
    }
  }, [settings.track])

  useEffect(() => {
    const sync = () => setPageVisible(!document.hidden)
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])

  useEffect(() => {
    if (!mobileOpen) return
    const keyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !creditsOpen && window.matchMedia('(max-width: 760px)').matches) {
        toggleMobile()
        toggleRef.current?.focus()
      }
    }
    document.addEventListener('keydown', keyboard)
    return () => document.removeEventListener('keydown', keyboard)
  }, [mobileOpen, creditsOpen, toggleMobile])

  useEffect(() => {
    if (!creditsOpen) return
    const dismiss = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !playerRef.current?.contains(event.target)) setCreditsOpen(false)
    }
    const keyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCreditsOpen(false)
        creditsRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', keyboard)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', keyboard)
    }
  }, [creditsOpen])

  function togglePlay() {
    const audio = audioRef.current
    if (audio === null) return
    if (audio.paused) {
      wantsPlayback.current = true
      void audio.play().catch(() => { /* Button stays on Play if refused. */ })
    } else {
      wantsPlayback.current = false
      audio.pause()
    }
  }

  function stop() {
    wantsPlayback.current = false
    const audio = audioRef.current
    if (audio !== null) {
      audio.pause()
      audio.currentTime = 0
    }
    setTime(0)
    setPlaying(false)
  }

  function step(delta: number) {
    setSettings((current) => ({
      ...current,
      track: (current.track + delta + TRACKS.length) % TRACKS.length,
    }))
  }

  return (
    <>
    {showDefaultToggle && (
      <button ref={toggleRef} type="button" className="btn music-mobile-toggle"
        aria-controls="music-player" aria-expanded={mobileOpen}
        onClick={toggleMobile}>
        {mobileOpen ? 'Hide music' : 'Music'}
      </button>
    )}
    <aside id="music-player" ref={playerRef} className="music-player" data-mobile-open={mobileOpen} data-playing={playing} data-visible={pageVisible} aria-label="Music player">
      <audio
        ref={audioRef}
        src={trackSrc}
        loop={loop}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onEmptied={() => { setTime(0); setDuration(0) }}
        onLoadedMetadata={(event) => {
          const length = event.currentTarget.duration
          setDuration(Number.isFinite(length) ? length : 0)
        }}
        onEnded={() => { wantsPlayback.current = true; step(1) }}
        onError={() => { wantsPlayback.current = false; setPlaying(false) }}
      />
      <div className="music-header">
        <span className="music-visualizer" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        <label className="music-track-select">
          <span className="visually-hidden">Choose a track</span>
          <select value={settings.track} title={track.title + ' — ' + track.artist}
            onChange={(event) => setSettings((current) => ({ ...current, track: Number(event.target.value) }))}>
            {TRACKS.map((entry, index) => (
              <option key={entry.id} value={index}>{entry.title} — {entry.artist}</option>
            ))}
          </select>
        </label>
        <button ref={creditsRef} type="button" className="music-credits-toggle"
          aria-expanded={creditsOpen} aria-controls="music-credits"
          onClick={() => setCreditsOpen((value) => !value)}>Credits</button>
      </div>
      <div className="music-controls">
        <button type="button" className="music-btn" onClick={() => step(-1)} aria-label="Previous track" title="Previous track">
          <span className="music-glyph glyph-prev" aria-hidden="true" />
        </button>
        <button type="button" className="music-btn music-play" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play'}>
          <span className={'music-glyph ' + (playing ? 'glyph-pause' : 'glyph-play')} aria-hidden="true" />
        </button>
        <button type="button" className="music-btn" onClick={stop} aria-label="Stop" title="Stop and rewind">
          <span className="music-glyph glyph-stop" aria-hidden="true" />
        </button>
        <button type="button" className="music-btn" onClick={() => step(1)} aria-label="Next track" title="Next track">
          <span className="music-glyph glyph-next" aria-hidden="true" />
        </button>
        <button type="button" className="music-btn music-mute" onClick={() => setSettings((current) => ({ ...current, muted: !current.muted }))}
          aria-pressed={settings.muted} aria-label={settings.muted ? 'Unmute' : 'Mute'} title={settings.muted ? 'Unmute' : 'Mute'}>
          <span className="music-glyph glyph-note" aria-hidden="true">♪</span>
        </button>
        <label className="music-volume-control">
          <span className="visually-hidden">Volume</span>
          <input className="music-volume" type="range" min={0} max={1} step={0.05} value={settings.volume}
            onChange={(event) => setSettings((current) => ({ ...current, volume: Number(event.target.value), muted: false }))} />
        </label>
        <button type="button" className="music-btn music-loop" onClick={() => setLoop((value) => !value)}
          aria-pressed={loop} aria-label={loop ? 'Looping on — turn looping off' : 'Looping off — turn looping on'} title="Toggle looping">
          <span className="music-glyph glyph-loop" aria-hidden="true">↻</span>
        </button>
      </div>
      <div className="music-progress-row">
        <input className="music-progress" type="range" min={0} max={Math.max(1, Math.floor(duration))} step={1}
          value={Math.min(time, Math.floor(duration))} disabled={duration === 0} aria-label="Seek"
          onChange={(event) => {
            if (audioRef.current !== null && duration > 0) {
              const next = Number(event.target.value)
              audioRef.current.currentTime = next
              setTime(next)
            }
          }} />
        <span className="music-time">{formatTime(time)} / {formatTime(duration)}</span>
      </div>
      {creditsOpen && (
        <div id="music-credits" className="music-credits-panel">
          <p><strong>{track.title}</strong></p>
          <p>{track.artist}</p>
          <p className="music-credit">{track.credit}</p>
        </div>
      )}
    </aside>
    </>
  )
}
