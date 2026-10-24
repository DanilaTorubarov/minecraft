import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react'
import {
  ApiError,
  addConversationMembers,
  createChatConversation,
  getChatConversations,
  getChatMessages,
  getConversationMessages,
  leaveConversation,
  markConversationRead,
  searchChatUsers,
  sendChatMessage,
  sendConversationMessage,
  type ChatConversation,
  type ChatMessage,
  type ChatParticipant,
  type ChatUserSearchResult,
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { displayPlayerName } from '../lib/playerName'
import { playSound } from '../lib/sounds'
import globeIcon from '../assets/icons/vista-search-globe.png'

interface Props {
  visible: boolean
  onOpenAccount?: () => void
}

type Selection = 'realm' | string
type ComposerState = { kind: 'dm' | 'group'; conversationId?: string }

const surfacePanel: CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--frame)',
  borderRadius: 8,
}

const quietIconButton: CSSProperties = {
  minHeight: 26,
  padding: '2px 9px',
  borderRadius: 6,
  border: '1px solid var(--line)',
  background: 'var(--surface-soft)',
  color: 'var(--text)',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
}

function formatTime(isoString: string): string {
  try {
    const date = new Date(isoString)
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const value = parts.slice(0, 2).map((part) => part[0]).join('')
  return value.toUpperCase() || '?'
}

function dmPartner(conversation: ChatConversation, selfId?: number): ChatParticipant | null {
  return (
    conversation.participants.find((participant) => participant.user_id !== selfId) ??
    conversation.participants[0] ??
    null
  )
}

function ChatAvatar({ name, uuid, size = 28 }: { name: string; uuid: string | null; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'relative',
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: 4,
        overflow: 'hidden',
        display: 'grid',
        placeItems: 'center',
        background: 'linear-gradient(145deg, rgba(56, 189, 248, 0.35), rgba(14, 116, 144, 0.35))',
        border: '1px solid var(--line)',
        color: 'var(--text)',
        fontSize: Math.max(10, Math.round(size * 0.38)),
        fontWeight: 700,
        letterSpacing: '0.02em',
      }}
    >
      <span>{initials(name)}</span>
      {uuid && (
        <img
          src={`https://mc-heads.net/avatar/${uuid}/${size}`}
          alt=""
          width={size}
          height={size}
          referrerPolicy="no-referrer"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          onError={(event) => {
            event.currentTarget.style.display = 'none'
          }}
        />
      )}
    </span>
  )
}

function conversationPreview(conversation: ChatConversation): string {
  if (!conversation.last_message) return 'No messages yet'
  return `${displayPlayerName(conversation.last_message.sender_name)}: ${conversation.last_message.text}`
}

function composerMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'That conversation is no longer available.'
    if (error.status === 409) return 'This group is already full.'
    if (error.status === 400) return 'Check the name and the selected accounts.'
    if (error.status === 429) return 'Too many attempts. Wait a moment and try again.'
  }
  return 'Could not start the conversation. Please try again.'
}

/** One live thread: the realm bridge (selection === 'realm') or one conversation. */
function ChatThread({
  selection,
  conversation,
  visible,
  userId,
  senderName,
  onRefreshList,
  onUnavailable,
  onOpenAccount,
}: {
  selection: Selection
  conversation: ChatConversation | null
  visible: boolean
  userId: number | null
  senderName: string
  onRefreshList: () => void
  onUnavailable: () => void
  onOpenAccount?: () => void
}) {
  const isRealm = selection === 'realm'
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const isScrolledToBottomRef = useRef(true)
  const containerRef = useRef<HTMLDivElement>(null)
  const lastIdRef = useRef(0)

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
        const fetched = isRealm
          ? await getChatMessages(sinceId, 50)
          : await getConversationMessages(selection, sinceId, 50)
        if (!active) return

        if (fetched.length > 0) {
          setMessages((prev) => {
            const existingIds = new Set(prev.map((message) => message.id))
            const newOnes = fetched.filter((message) => !existingIds.has(message.id))
            if (newOnes.length === 0) return prev
            const combined = [...prev, ...newOnes]
            lastIdRef.current = combined[combined.length - 1].id
            return combined
          })
          if (isScrolledToBottomRef.current) {
            setTimeout(() => scrollToBottom(), 50)
          }
          if (!isRealm && userId !== null && document.visibilityState === 'visible') {
            try {
              await markConversationRead(selection, fetched[fetched.length - 1].id)
              onRefreshList()
            } catch {
              // A failed read receipt must not break the conversation.
            }
          }
        }
        setError('')
      } catch (caught) {
        if (!active) return
        if (caught instanceof ApiError && caught.status === 404 && !isRealm) {
          onUnavailable()
          setError('That conversation is no longer available.')
        } else {
          setError('Chat connection paused. Retrying…')
        }
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
  }, [isRealm, selection, visible, userId, onRefreshList, onUnavailable])

  const handleSend = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || sending || userId === null) return

    setSending(true)
    setError('')
    try {
      playSound('click')
      const sent = isRealm
        ? await sendChatMessage(trimmed)
        : await sendConversationMessage(selection, trimmed)
      playSound('done')
      setText('')
      setMessages((prev) => {
        if (prev.some((message) => message.id === sent.id)) return prev
        lastIdRef.current = sent.id
        return [...prev, sent]
      })
      if (!isRealm) {
        try {
          await markConversationRead(selection, sent.id)
        } catch {
          // Unread state repairs on the next list refresh.
        }
        onRefreshList()
      }
      setTimeout(() => scrollToBottom('smooth'), 50)
    } catch {
      setError('Could not send message. Please try again.')
    } finally {
      setSending(false)
    }
  }

  const title = conversation?.title ?? 'Minecraft Realm'
  const placeholder = isRealm
    ? 'Type a message to the Minecraft realm… (press Enter)'
    : conversation?.kind === 'group'
      ? `Message ${title}…`
      : `Message ${title} privately…`

  return (
    <>
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

      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          ...surfacePanel,
        }}
      >
        {loading && messages.length === 0 ? (
          <p style={{ margin: 'auto', color: 'var(--muted)', fontSize: 13 }}>
            {isRealm ? 'Loading server messages…' : 'Loading conversation…'}
          </p>
        ) : messages.length === 0 ? (
          <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--muted)', padding: 20 }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
              {isRealm ? 'No chat messages yet.' : 'No messages in this conversation yet.'}
            </p>
            <p style={{ margin: '4px 0 0', fontSize: 12 }}>
              {isRealm
                ? 'Send a message below to broadcast to all players currently on the Minecraft server!'
                : conversation?.kind === 'group'
                  ? 'Start the conversation for everyone in this group.'
                  : 'Say hello — this chat stays between the two of you.'}
            </p>
          </div>
        ) : (
          messages.map((message) => {
            const isGame = message.source === 'game'
            return (
              <div
                key={message.id}
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
                <ChatAvatar name={displayPlayerName(message.sender_name)} uuid={message.sender_uuid} size={28} />

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>
                      {displayPlayerName(message.sender_name)}
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
                      {isGame ? 'Minecraft' : isRealm ? 'Web' : 'Private'}
                    </span>

                    <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>
                      {formatTime(message.created_at)}
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
                    {message.text}
                  </div>
                </div>
              </div>
            )
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {userId !== null ? (
        <form onSubmit={handleSend} style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              type="text"
              placeholder={placeholder}
              aria-label={placeholder}
              value={text}
              maxLength={256}
              onChange={(event) => setText(event.target.value)}
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

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 11,
              color: 'var(--muted)',
              padding: '0 4px',
            }}
          >
            <span>
              {isRealm ? 'Broadcasting in-game as ' : 'Sending privately as '}
              <strong>{senderName}</strong>
            </span>
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
          <span>Log in to your account to send messages, DMs and group chat.</span>
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
    </>
  )
}

export default function ChatPage({ visible, onOpenAccount }: Props) {
  const { user } = useAuth()
  const [selection, setSelection] = useState<Selection>('realm')
  const [conversations, setConversations] = useState<ChatConversation[]>([])
  const [refreshTick, setRefreshTick] = useState(0)
  const [sidebarError, setSidebarError] = useState('')

  const [composer, setComposer] = useState<ComposerState | null>(null)
  const [composerQuery, setComposerQuery] = useState('')
  const [composerResults, setComposerResults] = useState<ChatUserSearchResult[]>([])
  const [composerSelected, setComposerSelected] = useState<ChatUserSearchResult[]>([])
  const [groupName, setGroupName] = useState('')
  const [composerBusy, setComposerBusy] = useState(false)
  const [composerError, setComposerError] = useState('')

  const activeSelection: Selection = user ? selection : 'realm'
  const isRealm = activeSelection === 'realm'
  const activeConversation = isRealm
    ? null
    : conversations.find((conversation) => conversation.id === activeSelection) ?? null
  const directMessages = conversations.filter((conversation) => conversation.kind === 'dm')
  const groupChats = conversations.filter((conversation) => conversation.kind === 'group')

  const refreshList = useCallback(() => {
    setRefreshTick((value) => value + 1)
  }, [])

  const handleUnavailable = useCallback(() => {
    setSelection('realm')
    setRefreshTick((value) => value + 1)
  }, [])

  useEffect(() => {
    if (!visible || !user) return
    let active = true

    const load = async () => {
      try {
        const list = await getChatConversations()
        if (active) setConversations(list)
      } catch {
        // Keep the previous snapshot; the next poll retries.
      }
    }

    void load()
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void load()
      }
    }, 5000)

    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [visible, user, refreshTick])

  useEffect(() => {
    if (!composer) return
    const term = composerQuery.trim()
    if (term.length < 2) return
    let active = true
    const timer = window.setTimeout(async () => {
      try {
        const results = await searchChatUsers(term)
        if (active) setComposerResults(results)
      } catch {
        if (active) setComposerResults([])
      }
    }, 250)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [composer, composerQuery])

  useEffect(() => {
    if (!composer) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setComposer(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [composer])

  const openComposer = (kind: 'dm' | 'group', conversationId?: string) => {
    playSound('open')
    setComposer({ kind, conversationId })
    setComposerQuery('')
    setComposerResults([])
    setComposerSelected([])
    setGroupName('')
    setComposerError('')
  }

  const closeComposer = () => {
    if (composerBusy) return
    setComposer(null)
    setComposerError('')
  }

  const startDirectMessage = async (candidate: ChatUserSearchResult) => {
    if (!composer || composerBusy) return
    setComposerBusy(true)
    setComposerError('')
    try {
      const conversation = await createChatConversation('dm', null, [candidate.user_id])
      playSound('done')
      setComposer(null)
      setConversations((previous) => [
        conversation,
        ...previous.filter((item) => item.id !== conversation.id),
      ])
      setSelection(conversation.id)
      refreshList()
    } catch (caught) {
      setComposerError(composerMessage(caught))
    } finally {
      setComposerBusy(false)
    }
  }

  const pickComposerUser = (candidate: ChatUserSearchResult) => {
    if (!composer) return
    if (composer.kind === 'dm' && !composer.conversationId) {
      void startDirectMessage(candidate)
      return
    }
    const alreadySelected = composerSelected.some((selected) => selected.user_id === candidate.user_id)
    if (!alreadySelected && composerSelected.length >= 19) {
      setComposerError('A group can hold up to 20 members.')
      return
    }
    setComposerError('')
    setComposerSelected((previous) =>
      previous.some((selected) => selected.user_id === candidate.user_id)
        ? previous.filter((selected) => selected.user_id !== candidate.user_id)
        : [...previous, candidate],
    )
  }

  const submitComposer = async (event: FormEvent) => {
    event.preventDefault()
    if (!composer || composerBusy) return
    if (composer.kind === 'dm' && !composer.conversationId) return
    if (composerSelected.length === 0) {
      setComposerError('Pick at least one account.')
      return
    }
    const name = groupName.trim()
    if (!composer.conversationId && name.length === 0) {
      setComposerError('Give the group a name.')
      return
    }

    setComposerBusy(true)
    setComposerError('')
    try {
      const userIds = composerSelected.map((selected) => selected.user_id)
      if (composer.conversationId) {
        const updated = await addConversationMembers(composer.conversationId, userIds)
        setConversations((previous) =>
          previous.map((item) => (item.id === updated.id ? updated : item)),
        )
        playSound('done')
        setComposer(null)
      } else {
        const conversation = await createChatConversation('group', name, userIds)
        playSound('done')
        setComposer(null)
        setConversations((previous) => [
          conversation,
          ...previous.filter((item) => item.id !== conversation.id),
        ])
        setSelection(conversation.id)
      }
      refreshList()
    } catch (caught) {
      setComposerError(composerMessage(caught))
    } finally {
      setComposerBusy(false)
    }
  }

  const leaveGroup = async () => {
    if (!activeConversation) return
    if (!window.confirm(`Leave "${activeConversation.title}"? The conversation stays for its other members.`)) {
      return
    }
    setSidebarError('')
    try {
      await leaveConversation(activeConversation.id)
      playSound('close')
      setSelection('realm')
      refreshList()
    } catch {
      setSidebarError('Could not leave the conversation. Please try again.')
    }
  }

  const composerTitle = composer?.conversationId
    ? `Add members to ${activeConversation?.title ?? 'group'}`
    : composer?.kind === 'group'
      ? 'New group chat'
      : 'New direct message'

  // Do not offer accounts that are already in the group being extended.
  const composerResultsVisible = composer?.conversationId
    ? composerResults.filter(
        (candidate) =>
          !activeConversation?.participants.some(
            (participant) => participant.user_id === candidate.user_id,
          ),
      )
    : composerResults

  return (
    <div
      className="workspace chat-workspace"
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: '16px 20px',
        gap: 12,
        minHeight: 0,
        boxSizing: 'border-box',
      }}
    >
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <img src={globeIcon} alt="" style={{ width: 32, height: 32, flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <h1
              style={{
                margin: 0,
                fontSize: 15,
                fontWeight: 700,
                color: 'var(--text)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {activeConversation ? activeConversation.title : 'Minecraft Realm Chat'}
            </h1>
            <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--muted)' }}>
              {isRealm
                ? 'Live server bridge. Messages broadcast directly to players in-game.'
                : activeConversation?.kind === 'group'
                  ? `${activeConversation.participants.length} members · private, website only`
                  : 'Direct message · private, website only'}
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          {activeConversation?.kind === 'group' && (
            <>
              <button
                type="button"
                style={quietIconButton}
                onClick={() => openComposer('group', activeConversation.id)}
              >
                Add members
              </button>
              <button type="button" style={quietIconButton} onClick={() => void leaveGroup()}>
                Leave
              </button>
            </>
          )}
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: isRealm ? '#22c55e' : '#38bdf8',
              boxShadow: isRealm
                ? '0 0 8px rgba(34, 197, 94, 0.6)'
                : '0 0 8px rgba(56, 189, 248, 0.6)',
            }}
          />
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: isRealm ? '#16a34a' : '#0284c7',
            }}
          >
            {isRealm ? 'Live Bridge' : 'Private'}
          </span>
        </div>
      </div>

      {sidebarError && (
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
          {sidebarError}
        </div>
      )}

      <div className="chat-body">
        <aside className="chat-sidebar">
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              style={{ ...quietIconButton, flex: 1 }}
              onClick={() => openComposer('dm')}
              disabled={!user}
            >
              + Direct
            </button>
            <button
              type="button"
              style={{ ...quietIconButton, flex: 1 }}
              onClick={() => openComposer('group')}
              disabled={!user}
            >
              + Group
            </button>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button
              type="button"
              onClick={() => setSelection('realm')}
              aria-current={isRealm ? 'page' : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '7px 8px',
                borderRadius: 7,
                border: isRealm ? '1px solid var(--primary-edge, #0284c7)' : '1px solid var(--line)',
                background: isRealm ? 'rgba(56, 189, 248, 0.16)' : 'var(--surface-soft)',
                color: 'var(--text)',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <img src={globeIcon} alt="" style={{ width: 26, height: 26, flexShrink: 0 }} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: 'block', fontSize: 12, fontWeight: 700 }}>Minecraft Realm</span>
                <span
                  style={{
                    display: 'block',
                    fontSize: 10,
                    color: 'var(--muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Global · bridged in-game
                </span>
              </span>
            </button>

            {user && directMessages.length > 0 && (
              <p style={{ margin: '6px 4px 0', fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>
                Direct messages
              </p>
            )}
            {user &&
              directMessages.map((conversation) => {
                const partner = dmPartner(conversation, user.id)
                return (
                  <ConversationButton
                    key={conversation.id}
                    active={activeSelection === conversation.id}
                    title={conversation.title}
                    preview={conversationPreview(conversation)}
                    unread={conversation.unread_count}
                    avatar={<ChatAvatar name={partner?.name ?? conversation.title} uuid={partner?.uuid ?? null} size={26} />}
                    onClick={() => setSelection(conversation.id)}
                  />
                )
              })}

            {user && groupChats.length > 0 && (
              <p style={{ margin: '6px 4px 0', fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>
                Groups
              </p>
            )}
            {user &&
              groupChats.map((conversation) => (
                <ConversationButton
                  key={conversation.id}
                  active={activeSelection === conversation.id}
                  title={conversation.title}
                  preview={conversationPreview(conversation)}
                  unread={conversation.unread_count}
                  avatar={<ChatAvatar name={conversation.title} uuid={null} size={26} />}
                  onClick={() => setSelection(conversation.id)}
                />
              ))}

            {user && conversations.length === 0 && (
              <p style={{ margin: '10px 4px', fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                No direct messages or groups yet. Start one with the buttons above.
              </p>
            )}

            {!user && (
              <p style={{ margin: '10px 4px', fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                Log in to use direct messages and group chats.
              </p>
            )}
          </div>
        </aside>

        <div className="chat-thread">
          <ChatThread
            key={activeSelection}
            selection={activeSelection}
            conversation={activeConversation}
            visible={visible}
            userId={user?.id ?? null}
            senderName={user?.displayed_nickname ?? user?.login_displayed ?? 'your account'}
            onRefreshList={refreshList}
            onUnavailable={handleUnavailable}
            onOpenAccount={onOpenAccount}
          />
        </div>
      </div>

      {composer && (
        <div
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeComposer()
          }}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            display: 'grid',
            placeItems: 'center',
            padding: 16,
            background: 'rgba(6, 24, 36, 0.45)',
            backdropFilter: 'blur(4px)',
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={composerTitle}
            style={{
              width: 'min(430px, 100%)',
              maxHeight: '100%',
              overflowY: 'auto',
              padding: 16,
              borderRadius: 10,
              border: '1px solid var(--frame)',
              background: 'var(--surface)',
              boxShadow: '0 18px 48px rgba(0, 0, 0, 0.35)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{composerTitle}</h2>
              <button type="button" style={quietIconButton} onClick={closeComposer} disabled={composerBusy}>
                Close
              </button>
            </div>

            <form onSubmit={submitComposer} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
              {composer.kind === 'group' && !composer.conversationId && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>
                  Group name
                  <input
                    type="text"
                    value={groupName}
                    maxLength={48}
                    onChange={(event) => setGroupName(event.target.value)}
                    placeholder="Weekend explorers"
                    style={{
                      minHeight: 36,
                      padding: '8px 12px',
                      borderRadius: 6,
                      border: '1px solid var(--frame)',
                      background: 'var(--field, rgba(0,0,0,0.15))',
                      color: 'var(--text)',
                      fontSize: 13,
                    }}
                  />
                </label>
              )}

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>
                Find accounts
                <input
                  type="search"
                  value={composerQuery}
                  onChange={(event) => {
                    setComposerQuery(event.target.value)
                    if (event.target.value.trim().length < 2) setComposerResults([])
                  }}
                  placeholder="Type a login, name or Minecraft username…"
                  autoFocus
                  style={{
                    minHeight: 36,
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: '1px solid var(--frame)',
                    background: 'var(--field, rgba(0,0,0,0.15))',
                    color: 'var(--text)',
                    fontSize: 13,
                  }}
                />
              </label>

              {composerSelected.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {composerSelected.map((selected) => (
                    <button
                      key={selected.user_id}
                      type="button"
                      onClick={() => pickComposerUser(selected)}
                      title={`Remove ${selected.name}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 8px',
                        borderRadius: 999,
                        border: '1px solid var(--line)',
                        background: 'rgba(56, 189, 248, 0.14)',
                        color: 'var(--text)',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {selected.name}
                      <span aria-hidden="true">×</span>
                    </button>
                  ))}
                </div>
              )}

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  maxHeight: 210,
                  overflowY: 'auto',
                  padding: 4,
                  borderRadius: 7,
                  border: '1px solid var(--line)',
                  background: 'var(--surface-soft)',
                }}
              >
                {composerResultsVisible.length === 0 ? (
                  <p style={{ margin: 6, fontSize: 11, color: 'var(--muted)' }}>
                    {composerQuery.trim().length < 2
                      ? 'Type at least two characters to search.'
                      : 'No matching accounts.'}
                  </p>
                ) : (
                  composerResultsVisible.map((candidate) => {
                    const isSelected = composerSelected.some((selected) => selected.user_id === candidate.user_id)
                    return (
                      <button
                        key={candidate.user_id}
                        type="button"
                        onClick={() => pickComposerUser(candidate)}
                        disabled={composerBusy}
                        aria-pressed={composer.kind === 'dm' ? undefined : isSelected}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '6px 8px',
                          borderRadius: 6,
                          border: isSelected ? '1px solid var(--primary-edge, #0284c7)' : '1px solid transparent',
                          background: isSelected ? 'rgba(56, 189, 248, 0.16)' : 'transparent',
                          color: 'var(--text)',
                          textAlign: 'left',
                          cursor: composerBusy ? 'wait' : 'pointer',
                        }}
                      >
                        <ChatAvatar name={candidate.name} uuid={candidate.uuid} size={26} />
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span style={{ display: 'block', fontSize: 12, fontWeight: 700 }}>{candidate.name}</span>
                          <span style={{ display: 'block', fontSize: 10, color: 'var(--muted)' }}>
                            {candidate.uuid ? 'Linked Minecraft account' : 'Website account'}
                          </span>
                        </span>
                        {isSelected && <span aria-hidden="true">✓</span>}
                      </button>
                    )
                  })
                )}
              </div>

              {composerError && (
                <p role="alert" style={{ margin: 0, fontSize: 11, color: '#ef4444', fontWeight: 600 }}>
                  {composerError}
                </p>
              )}

              {composer.kind !== 'dm' && (
                <button
                  type="submit"
                  className="btn"
                  disabled={
                    composerBusy ||
                    composerSelected.length === 0 ||
                    (!composer.conversationId && groupName.trim().length === 0)
                  }
                  style={{
                    minHeight: 38,
                    padding: '0 18px',
                    background: 'linear-gradient(var(--primary-top, #38bdf8), var(--primary-bottom, #0284c7))',
                    color: 'var(--primary-text, #ffffff)',
                    border: '1px solid var(--primary-edge, #0284c7)',
                    borderRadius: 6,
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: composerBusy ? 'wait' : 'pointer',
                    opacity:
                      composerBusy ||
                      composerSelected.length === 0 ||
                      (!composer.conversationId && groupName.trim().length === 0)
                        ? 0.6
                        : 1,
                  }}
                >
                  {composerBusy
                    ? 'Working…'
                    : composer.conversationId
                      ? 'Add members'
                      : 'Create group'}
                </button>
              )}
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

function ConversationButton({
  active,
  title,
  preview,
  unread,
  avatar,
  onClick,
}: {
  active: boolean
  title: string
  preview: string
  unread: number
  avatar: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '7px 8px',
        borderRadius: 7,
        border: active ? '1px solid var(--primary-edge, #0284c7)' : '1px solid var(--line)',
        background: active ? 'rgba(56, 189, 248, 0.16)' : 'var(--surface-soft)',
        color: 'var(--text)',
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      {avatar}
      <span style={{ minWidth: 0, flex: 1 }}>
        <span
          style={{
            display: 'block',
            fontSize: 12,
            fontWeight: 700,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </span>
        <span
          style={{
            display: 'block',
            fontSize: 10,
            color: 'var(--muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {preview}
        </span>
      </span>
      {unread > 0 && (
        <span
          aria-label={`${unread} unread`}
          style={{
            minWidth: 18,
            padding: '1px 5px',
            borderRadius: 999,
            background: '#0ea5e9',
            color: '#ffffff',
            fontSize: 10,
            fontWeight: 700,
            textAlign: 'center',
          }}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  )
}
