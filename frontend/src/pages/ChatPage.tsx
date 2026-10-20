import { useEffect, useRef, useState } from 'react'
import { getChatMessages, sendChatMessage, type ChatMessage } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { playSound } from '../lib/sounds'
import globeIcon from '../assets/icons/vista-search-globe.png'

interface Props {
  visible: boolean
  onOpenAccount?: () => void
}

function formatTime(isoString: string): string {
  try {
    const date = new Date(isoString)
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

export default function ChatPage({ visible, onOpenAccount }: Props) {
  const { user } = useAuth()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const lastIdRef = useRef<number>(0)
  const isScrolledToBottomRef = useRef(true)
  const containerRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior })
  }

  const handleScroll = () => {
    if (!containerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current
    isScrolledToBottomRef.current = scrollHeight - scrollTop - clientHeight < 50
  }

  useEffect(() => {
    if (!visible) return
    let active = true

    const fetchLatest = async () => {
      try {
        const sinceId = lastIdRef.current > 0 ? lastIdRef.current : undefined
        const fetched = await getChatMessages(sinceId, 50)
        if (!active) return

        if (fetched.length > 0) {
          setMessages((prev) => {
            const existingIds = new Set(prev.map((m) => m.id))
            const newOnes = fetched.filter((m) => !existingIds.has(m.id))
            if (newOnes.length === 0) return prev
            const combined = [...prev, ...newOnes]
            // Update last known ID
            lastIdRef.current = combined[combined.length - 1].id
            return combined
          })
          if (isScrolledToBottomRef.current) {
            setTimeout(() => scrollToBottom(), 50)
          }
        }
        setError('')
      } catch {
        if (active) setError('Chat connection paused. Retrying…')
      } finally {
        if (active) setLoading(false)
      }
    }

    void fetchLatest()
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchLatest()
      }
    }, 1500)

    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [visible])

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || sending) return

    setSending(true)
    setError('')
    try {
      playSound('click')
      const sent = await sendChatMessage(trimmed)
      playSound('done')
      setText('')
      setMessages((prev) => {
        if (prev.some((m) => m.id === sent.id)) return prev
        const updated = [...prev, sent]
        lastIdRef.current = sent.id
        return updated
      })
      setTimeout(() => scrollToBottom('smooth'), 50)
    } catch {
      setError('Could not send message. Please try again.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      className="workspace chat-workspace"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: '16px 20px',
        gap: 12,
        minHeight: 0,
        boxSizing: 'border-box',
      }}
    >
      {/* Header bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          background: 'var(--surface-soft)',
          border: '1px solid var(--line)',
          borderRadius: 8,
          backdropFilter: 'blur(12px)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src={globeIcon} alt="" style={{ width: 32, height: 32 }} />
          <div>
            <h1 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
              Minecraft Realm Chat
            </h1>
            <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--muted)' }}>
              Live server bridge. Messages broadcast directly to players in-game.
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: '#22c55e',
              boxShadow: '0 0 8px rgba(34, 197, 94, 0.6)',
            }}
          />
          <span style={{ fontSize: 12, fontWeight: 600, color: '#16a34a' }}>Live Bridge</span>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            padding: '8px 14px',
            borderRadius: 6,
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            color: '#ef4444',
            fontSize: 12,
            fontWeight: 500,
            flexShrink: 0,
          }}
        >
          {error}
        </div>
      )}

      {/* Message list container */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '12px 16px',
          background: 'var(--surface)',
          border: '1px solid var(--frame)',
          borderRadius: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {loading && messages.length === 0 ? (
          <p style={{ margin: 'auto', color: 'var(--muted)', fontSize: 13 }}>Loading server messages…</p>
        ) : messages.length === 0 ? (
          <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--muted)', padding: 20 }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>No chat messages yet.</p>
            <p style={{ margin: '4px 0 0', fontSize: 12 }}>
              Send a message below to broadcast to all players currently on the Minecraft server!
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            const isGame = msg.source === 'game'
            const avatarIdentifier = msg.sender_uuid || msg.sender_name
            return (
              <div
                key={msg.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '6px 8px',
                  borderRadius: 6,
                  background: 'var(--surface-soft)',
                  border: '1px solid rgba(255, 255, 255, 0.05)',
                }}
              >
                <img
                  src={`https://mc-heads.net/avatar/${avatarIdentifier}/28`}
                  alt=""
                  style={{ width: 28, height: 28, borderRadius: 4, flexShrink: 0, marginTop: 2 }}
                  onError={(e) => {
                    ;(e.currentTarget as HTMLImageElement).style.visibility = 'hidden'
                  }}
                />

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>
                      {msg.sender_name}
                    </span>

                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '1px 5px',
                        borderRadius: 4,
                        textTransform: 'uppercase',
                        background: isGame ? 'rgba(34, 197, 94, 0.15)' : 'rgba(14, 165, 233, 0.15)',
                        color: isGame ? '#16a34a' : '#0284c7',
                        border: isGame
                          ? '1px solid rgba(34, 197, 94, 0.3)'
                          : '1px solid rgba(14, 165, 233, 0.3)',
                      }}
                    >
                      {isGame ? 'Minecraft' : 'Web'}
                    </span>

                    <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>
                      {formatTime(msg.created_at)}
                    </span>
                  </div>

                  <div
                    style={{
                      margin: '4px 0 0',
                      fontSize: 13,
                      lineHeight: 1.45,
                      color: 'var(--text)',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {msg.text}
                  </div>
                </div>
              </div>
            )
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input toolbar */}
      {user ? (
        <form
          onSubmit={handleSend}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Type a message to Minecraft realm… (press Enter)"
              value={text}
              maxLength={256}
              onChange={(e) => setText(e.target.value)}
              disabled={sending}
              style={{
                flex: 1,
                minHeight: 40,
                padding: '8px 14px',
                borderRadius: 6,
                border: '1px solid var(--frame)',
                background: 'var(--field, rgba(0,0,0,0.15))',
                color: 'var(--text)',
                fontSize: 13,
              }}
            />

            <button
              type="submit"
              disabled={sending || !text.trim()}
              className="btn"
              style={{
                minHeight: 40,
                padding: '0 20px',
                background: 'linear-gradient(var(--primary-top, #38bdf8), var(--primary-bottom, #0284c7))',
                color: 'var(--primary-text, #ffffff)',
                border: '1px solid var(--primary-edge, #0284c7)',
                borderRadius: 6,
                fontWeight: 600,
                fontSize: 13,
                cursor: sending || !text.trim() ? 'not-allowed' : 'pointer',
                opacity: sending || !text.trim() ? 0.6 : 1,
              }}
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', padding: '0 4px' }}>
            <span>Broadcasting as <strong>{user.displayed_nickname || user.login_displayed}</strong></span>
            <span>{text.length} / 256</span>
          </div>
        </form>
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            background: 'var(--surface-soft)',
            border: '1px solid var(--line)',
            borderRadius: 6,
            fontSize: 13,
            color: 'var(--muted)',
            flexShrink: 0,
          }}
        >
          <span>Log in to your account to send messages to the Minecraft server.</span>
          {onOpenAccount && (
            <button
              type="button"
              className="btn btn-quiet"
              onClick={onOpenAccount}
              style={{ fontSize: 12, padding: '4px 10px' }}
            >
              Log In
            </button>
          )}
        </div>
      )}
    </div>
  )
}
