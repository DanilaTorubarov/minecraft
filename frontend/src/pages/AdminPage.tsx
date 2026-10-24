import { useEffect, useRef, useState } from 'react'
import {
  adjustAdminBalance,
  adminBanPlayer,
  adminKickPlayer,
  adminMutePlayer,
  adminUnbanPlayer,
  adminUnmutePlayer,
  executeAdminConsoleCommand,
  getAdminAccounts,
  getAdminChatLogs,
  getAdminConsoleLogs,
  getAdminMetrics,
  getAdminModerationList,
  type AdminAccount,
  type AdminMetrics,
  type AdminModerationList,
  type ChatMessage,
  type ConsoleLogEntry,
} from '../lib/api'
import { displayPlayerName } from '../lib/playerName'
import { invalidateServerData } from '../lib/serverData'
import { playSound } from '../lib/sounds'
import firewallOnIcon from '../assets/icons/vista-firewall-on.png'
import perfCenterIcon from '../assets/icons/vista-perf-center.png'
import coinIcon from '../assets/icons/coin.png'

const LOG_LEVEL_PREFIX = /^\[[A-Z]+\]\s*/

// The server stream prefixes its lines with the level; a command's own echo does not.
function withoutLogLevel(text: string): string {
  return text.replace(LOG_LEVEL_PREFIX, '')
}

interface Props {
  visible: boolean
}

type AdminTab = 'metrics' | 'console' | 'moderation' | 'chat' | 'economy'
type Operation = 'set' | 'add' | 'subtract'
type ModerationAction = 'kick' | 'ban' | 'mute'

export default function AdminPage({ visible }: Props) {
  const [activeTab, setActiveTab] = useState<AdminTab>('metrics')
  const [error, setError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  // --- Metrics & Players State ---
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(false)
  const [playerSearch, setPlayerSearch] = useState('')

  // --- Console Terminal State ---
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLogEntry[]>([])
  const [commandInput, setCommandInput] = useState('')
  const [commandHistory, setCommandHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number>(-1)
  const [autoScroll, setAutoScroll] = useState(true)
  const [executingCommand, setExecutingCommand] = useState(false)
  const terminalEndRef = useRef<HTMLDivElement>(null)
  // The poll cursor is the newest id the *server* handed out. A command's locally
  // echoed output must never become the cursor, or the terminal would ask for lines
  // newer than any the panel can produce and then sit silent.
  const lastServerLogIdRef = useRef<number | undefined>(undefined)
  // A command prints once as an echo and again in the server stream a moment later;
  // remember the echoes so the same line is not shown twice.
  const recentEchoesRef = useRef<{ text: string; at: number }[]>([])

  // --- Moderation State ---
  const [modList, setModList] = useState<AdminModerationList>({ bans: [], mutes: [] })
  const [modLoading, setModLoading] = useState(false)
  const [modModalOpen, setModModalOpen] = useState(false)
  const [targetUsername, setTargetUsername] = useState('')
  const [targetUuid, setTargetUuid] = useState<string | undefined>(undefined)
  const [modAction, setModAction] = useState<ModerationAction>('kick')
  const [modReason, setModReason] = useState('')
  const [modDuration, setModDuration] = useState<number>(3600) // seconds, 0 = permanent
  const [modSubmitting, setModSubmitting] = useState(false)

  // --- Chat Logs State ---
  const [chatLogs, setChatLogs] = useState<ChatMessage[]>([])
  const [chatQuery, setChatQuery] = useState('')
  const [chatUserFilter, setChatUserFilter] = useState('')
  const [chatLoading, setChatLoading] = useState(false)

  // --- Economy State ---
  const [accounts, setAccounts] = useState<AdminAccount[]>([])
  const [selectedUuid, setSelectedUuid] = useState<string>('')
  const [economyLoading, setEconomyLoading] = useState(false)
  const [operation, setOperation] = useState<Operation>('set')
  const [amountInput, setAmountInput] = useState<string>('')
  const [submittingEconomy, setSubmittingEconomy] = useState(false)

  // Auto-scroll terminal when logs change
  useEffect(() => {
    if (autoScroll && activeTab === 'console') {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [consoleLogs, autoScroll, activeTab])

  // --- Polling: Metrics ---
  useEffect(() => {
    if (!visible) return
    let active = true

    const fetchMetrics = async () => {
      try {
        const data = await getAdminMetrics()
        if (active) {
          setMetrics(data)
          setMetricsLoading(false)
        }
      } catch {
        // Silently tolerate temporary network blip
      }
    }

    void fetchMetrics()
    const timer = setInterval(() => {
      if (visible && (activeTab === 'metrics' || activeTab === 'console')) {
        void fetchMetrics()
      }
    }, 2500)

    return () => {
      active = false
      clearInterval(timer)
    }
  }, [visible, activeTab])

  // --- Polling: Console Logs ---
  useEffect(() => {
    if (!visible || activeTab !== 'console') return
    let active = true

    const fetchLogs = async () => {
      try {
        const newLogs = await getAdminConsoleLogs(lastServerLogIdRef.current)
        if (!active || newLogs.length === 0) return
        lastServerLogIdRef.current = newLogs[newLogs.length - 1].id
        const now = Date.now()
        recentEchoesRef.current = recentEchoesRef.current.filter((echo) => now - echo.at < 10_000)
        setConsoleLogs((prev) => {
          const existingIds = new Set(prev.map((l) => l.id))
          const fresh = newLogs.filter((l) => !existingIds.has(l.id))
          const filtered = fresh.filter((log) => {
            const plain = withoutLogLevel(log.text)
            const echo = recentEchoesRef.current.findIndex((entry) => entry.text === plain)
            if (echo === -1) return true
            recentEchoesRef.current.splice(echo, 1)
            return false
          })
          if (filtered.length === 0) return prev
          return [...prev, ...filtered].slice(-500)
        })
      } catch {
        // Ignore
      }
    }

    void fetchLogs()
    const timer = setInterval(fetchLogs, 1500)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [visible, activeTab])

  // --- Moderation Tab Fetch ---
  const refreshModeration = async () => {
    setModLoading(true)
    try {
      const data = await getAdminModerationList()
      setModList(data)
    } catch {
      setError('Could not load moderation records.')
    } finally {
      setModLoading(false)
    }
  }

  useEffect(() => {
    if (!visible || activeTab !== 'moderation') return
    let active = true
    const load = async () => {
      try {
        const data = await getAdminModerationList()
        if (active) setModList(data)
      } catch {
        if (active) setError('Could not load moderation records.')
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [visible, activeTab])

  // --- Chat Logs Fetch ---
  const handleFilterChatLogs = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    setChatLoading(true)
    try {
      const data = await getAdminChatLogs({
        search: chatQuery,
        username: chatUserFilter,
        limit: 100,
      })
      setChatLogs(data)
    } catch {
      setError('Could not load chat logs.')
    } finally {
      setChatLoading(false)
    }
  }

  useEffect(() => {
    if (!visible || activeTab !== 'chat') return
    let active = true
    const load = async () => {
      try {
        const data = await getAdminChatLogs({ limit: 100 })
        if (active) setChatLogs(data)
      } catch {
        if (active) setError('Could not load chat logs.')
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [visible, activeTab])

  // --- Economy Accounts Fetch ---
  useEffect(() => {
    if (!visible || activeTab !== 'economy') return
    let active = true
    const load = async () => {
      setEconomyLoading(true)
      try {
        const data = await getAdminAccounts()
        if (active) {
          setAccounts(data)
          setSelectedUuid((current) => {
            if (current && data.some((a) => a.uuid === current)) return current
            const selfAcc = data.find((a) => a.is_self)
            return selfAcc ? selfAcc.uuid : (data[0]?.uuid ?? '')
          })
        }
      } catch {
        if (active) {
          setError('Could not load accounts. Ensure you have administrator privileges.')
        }
      } finally {
        if (active) setEconomyLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [visible, activeTab])

  // --- Handlers: Console Execution ---
  const handleExecuteCommand = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = commandInput.trim()
    if (!trimmed || executingCommand) return

    setExecutingCommand(true)
    playSound('click')
    setCommandHistory((prev) => [...prev, trimmed])
    setHistoryIndex(-1)
    setCommandInput('')

    try {
      const res = await executeAdminConsoleCommand(trimmed)
      playSound('done')
      // Echo the output immediately with ids outside the server's range: the panel
      // owns the positive id space, and these entries are display-only.
      const now = Date.now()
      const logLines: ConsoleLogEntry[] = res.output.map((out, idx) => ({
        id: -(now + idx),
        text: out,
        timestamp: now,
      }))
      recentEchoesRef.current.push(...res.output.map((text) => ({ text, at: now })))
      setConsoleLogs((prev) => [...prev, ...logLines].slice(-500))
    } catch {
      setError(`Failed to execute command: /${trimmed}`)
    } finally {
      setExecutingCommand(false)
    }
  }

  // --- Handlers: Moderation Action Execution ---
  const openModerationModal = (username: string, uuid?: string, defaultAction: ModerationAction = 'kick') => {
    playSound('click')
    setTargetUsername(username)
    setTargetUuid(uuid)
    setModAction(defaultAction)
    setModReason(
      defaultAction === 'kick'
        ? 'Kicked by administrator'
        : defaultAction === 'ban'
          ? 'Banned for rules violation'
          : 'Muted for chat violation'
    )
    setModDuration(defaultAction === 'kick' ? 0 : 3600)
    setModModalOpen(true)
    setError('')
    setSuccessMessage('')
  }

  const handleApplyModeration = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!targetUsername.trim()) return

    setModSubmitting(true)
    setError('')
    setSuccessMessage('')
    try {
      playSound('click')
      if (modAction === 'kick') {
        await adminKickPlayer({
          username: targetUsername.trim(),
          uuid: targetUuid,
          reason: modReason.trim() || undefined,
        })
        setSuccessMessage(`Player ${displayPlayerName(targetUsername)} has been kicked.`)
      } else if (modAction === 'ban') {
        await adminBanPlayer({
          username: targetUsername.trim(),
          uuid: targetUuid,
          reason: modReason.trim() || undefined,
          duration_seconds: modDuration > 0 ? modDuration : undefined,
        })
        setSuccessMessage(
          `Player ${displayPlayerName(targetUsername)} has been banned (${modDuration > 0 ? `${modDuration / 3600}h` : 'permanently'}).`
        )
      } else if (modAction === 'mute') {
        await adminMutePlayer({
          username: targetUsername.trim(),
          uuid: targetUuid,
          reason: modReason.trim() || undefined,
          duration_seconds: modDuration > 0 ? modDuration : undefined,
        })
        setSuccessMessage(
          `Player ${displayPlayerName(targetUsername)} has been muted (${modDuration > 0 ? `${modDuration / 60}m` : 'permanently'}).`
        )
      }
      playSound('done')
      setModModalOpen(false)
      // Refresh moderation records and metrics
      void refreshModeration()
      const data = await getAdminMetrics()
      setMetrics(data)
    } catch {
      setError(`Failed to apply ${modAction} on ${displayPlayerName(targetUsername)}.`)
    } finally {
      setModSubmitting(false)
    }
  }

  const handleUnban = async (username: string) => {
    if (!confirm(`Unban player ${displayPlayerName(username)}?`)) return
    playSound('click')
    try {
      await adminUnbanPlayer(username)
      playSound('done')
      setSuccessMessage(`Player ${displayPlayerName(username)} has been unbanned.`)
      void refreshModeration()
    } catch {
      setError(`Failed to unban ${displayPlayerName(username)}.`)
    }
  }

  const handleUnmute = async (username: string) => {
    if (!confirm(`Unmute player ${displayPlayerName(username)}?`)) return
    playSound('click')
    try {
      await adminUnmutePlayer(username)
      playSound('done')
      setSuccessMessage(`Player ${displayPlayerName(username)} has been unmuted.`)
      void refreshModeration()
      const data = await getAdminMetrics()
      setMetrics(data)
    } catch {
      setError(`Failed to unmute ${displayPlayerName(username)}.`)
    }
  }

  // --- Handlers: Economy ---
  const selectedAccount = accounts.find((a) => a.uuid === selectedUuid)
  const handleApplyEconomy = async (op: Operation, amount: number) => {
    if (!selectedAccount) return
    if (isNaN(amount) || amount < 0) {
      setError('Please enter a valid positive number.')
      return
    }

    setSubmittingEconomy(true)
    setError('')
    setSuccessMessage('')
    try {
      playSound('click')
      const res = await adjustAdminBalance({
        uuid: selectedAccount.uuid,
        operation: op,
        amount,
      })

      playSound('done')
      const delta = res.new_coins - res.previous_coins
      const deltaFormatted = delta >= 0 ? `+${delta.toLocaleString()}` : `${delta.toLocaleString()}`
      setSuccessMessage(
        `Balance for ${displayPlayerName(res.username)} successfully updated to ${res.new_coins.toLocaleString()} coins (${deltaFormatted} coins).`
      )
      setAmountInput('')
      invalidateServerData('stats')
      const freshAccounts = await getAdminAccounts()
      setAccounts(freshAccounts)
    } catch {
      setError('Failed to update balance. Please check server logs.')
    } finally {
      setSubmittingEconomy(false)
    }
  }

  const parsedAmount = parseInt(amountInput.replace(/[^0-9]/g, ''), 10)
  const validAmount = !isNaN(parsedAmount) && parsedAmount >= 0

  let previewNewBalance: number | null = null
  if (selectedAccount && validAmount) {
    if (operation === 'set') {
      previewNewBalance = parsedAmount
    } else if (operation === 'add') {
      previewNewBalance = selectedAccount.coins + parsedAmount
    } else if (operation === 'subtract') {
      previewNewBalance = Math.max(0, selectedAccount.coins - parsedAmount)
    }
  }

  const presets = [
    { label: '+1,000', amount: 1000 },
    { label: '+10,000', amount: 10000 },
    { label: '+50,000', amount: 50000 },
    { label: '+100,000', amount: 100000 },
    { label: '+1,000,000', amount: 1000000 },
  ]

  // Filtered online players
  const filteredPlayers = (metrics?.online_players ?? []).filter((p) => {
    if (!playerSearch.trim()) return true
    const q = playerSearch.toLowerCase()
    return p.username.toLowerCase().includes(q) || p.world.toLowerCase().includes(q)
  })

  // Format RAM progress
  const ramPercent =
    metrics && metrics.ram_max_mb > 0
      ? Math.round((metrics.ram_used_mb / metrics.ram_max_mb) * 100)
      : metrics && metrics.ram_total_mb > 0
        ? Math.round((metrics.ram_used_mb / metrics.ram_total_mb) * 100)
        : 0

  const tps1m = metrics?.tps?.[0] ?? 20.0
  const tpsColor = tps1m >= 19.5 ? '#16a34a' : tps1m >= 17.0 ? '#d97706' : '#dc2626'

  return (
    <div
      className="workspace admin-workspace"
      style={{
        padding: '20px 24px',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        position: 'relative',
        minHeight: '100%',
      }}
    >
      {/* Header Banner */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 16,
          padding: '16px 20px',
          background: 'var(--surface-soft)',
          border: '1px solid var(--line)',
          borderRadius: 8,
          backdropFilter: 'blur(16px)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <img src={firewallOnIcon} alt="Admin" style={{ width: 40, height: 40, flexShrink: 0 }} />
          <div>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>
              Extended Web Admin Panel
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--muted)' }}>
              Live server telemetry, in-game player moderation, direct terminal console, and server economy.
            </p>
          </div>
        </div>

        {/* Live Server Indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              borderRadius: 20,
              background: metrics?.is_live ? 'rgba(34, 197, 94, 0.15)' : 'rgba(156, 163, 175, 0.15)',
              border: metrics?.is_live
                ? '1px solid rgba(34, 197, 94, 0.4)'
                : '1px solid rgba(156, 163, 175, 0.3)',
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: metrics?.is_live ? '#16a34a' : '#9ca3af',
                boxShadow: metrics?.is_live ? '0 0 8px #16a34a' : 'none',
              }}
            />
            <span style={{ fontSize: 12, fontWeight: 600, color: metrics?.is_live ? '#16a34a' : 'var(--muted)' }}>
              {metrics?.is_live ? 'Server Live & Synced' : 'Server Disconnected'}
            </span>
          </div>
          {metrics?.server_version && (
            <span
              style={{
                fontSize: 11,
                color: 'var(--muted)',
                padding: '4px 8px',
                borderRadius: 4,
                background: 'var(--surface)',
                border: '1px solid var(--frame)',
              }}
            >
              {metrics.server_version}
            </span>
          )}
        </div>
      </div>

      {/* Tabs Navigation */}
      <nav
        role="tablist"
        style={{
          display: 'flex',
          gap: 6,
          background: 'var(--surface-soft)',
          padding: 4,
          borderRadius: 8,
          border: '1px solid var(--line)',
          flexWrap: 'wrap',
        }}
      >
        {(
          [
            { id: 'metrics', label: 'Server Metrics & Players', icon: '📊' },
            { id: 'console', label: 'Console Terminal', icon: '💻' },
            { id: 'moderation', label: 'Moderation & Bans', icon: '🛡️' },
            { id: 'chat', label: 'Player Chat Logs', icon: '💬' },
            { id: 'economy', label: 'Economy & Coins', icon: '💰' },
          ] as const
        ).map((tab) => {
          const isSelected = activeTab === tab.id
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isSelected}
              type="button"
              onClick={() => {
                playSound('click')
                setActiveTab(tab.id)
                setError('')
                setSuccessMessage('')
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 16px',
                borderRadius: 6,
                border: isSelected ? '1px solid var(--primary-edge, #0284c7)' : '1px solid transparent',
                background: isSelected
                  ? 'linear-gradient(var(--primary-top, #38bdf8), var(--primary-bottom, #0284c7))'
                  : 'transparent',
                color: isSelected ? '#ffffff' : 'var(--text)',
                fontSize: 13,
                fontWeight: isSelected ? 600 : 500,
                cursor: 'pointer',
                transition: 'all 120ms ease',
                textShadow: isSelected ? '0 1px 2px rgba(0,0,0,0.4)' : 'none',
              }}
            >
              <span>{tab.icon}</span>
              <span>{tab.label}</span>
              {tab.id === 'metrics' && metrics && (
                <span
                  style={{
                    fontSize: 10,
                    padding: '1px 6px',
                    borderRadius: 10,
                    background: isSelected ? 'rgba(255,255,255,0.25)' : 'var(--surface)',
                    color: isSelected ? '#ffffff' : 'var(--muted)',
                    marginLeft: 2,
                  }}
                >
                  {metrics.online_count}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      {/* Global Alerts */}
      {error && (
        <div
          role="alert"
          style={{
            padding: '10px 14px',
            borderRadius: 6,
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            color: '#ef4444',
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          {error}
        </div>
      )}

      {successMessage && (
        <div
          role="status"
          style={{
            padding: '10px 14px',
            borderRadius: 6,
            background: 'rgba(34, 197, 94, 0.15)',
            border: '1px solid rgba(34, 197, 94, 0.4)',
            color: '#16a34a',
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          ✓ {successMessage}
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 1: SERVER METRICS & PLAYERS                                      */}
      {/* ==================================================================== */}
      {activeTab === 'metrics' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Telemetry Cards Row */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 12,
            }}
          >
            {/* TPS Card */}
            <div
              style={{
                padding: '16px 18px',
                background: 'var(--surface)',
                border: '1px solid var(--frame)',
                borderRadius: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase' }}>
                  Server TPS
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: tpsColor,
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: `${tpsColor}20`,
                  }}
                >
                  {tps1m >= 19.5 ? 'Excellent' : tps1m >= 17 ? 'Normal' : 'Lagging'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span style={{ fontSize: 28, fontWeight: 800, color: tpsColor, fontVariantNumeric: 'tabular-nums' }}>
                  {tps1m.toFixed(1)}
                </span>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>/ 20.0 TPS</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', gap: 12 }}>
                <span>1m: {metrics?.tps?.[0]?.toFixed(2) ?? '20.0'}</span>
                <span>5m: {metrics?.tps?.[1]?.toFixed(2) ?? '20.0'}</span>
                <span>15m: {metrics?.tps?.[2]?.toFixed(2) ?? '20.0'}</span>
              </div>
            </div>

            {/* RAM Usage Card */}
            <div
              style={{
                padding: '16px 18px',
                background: 'var(--surface)',
                border: '1px solid var(--frame)',
                borderRadius: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase' }}>
                  Memory (RAM)
                </span>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>
                  {ramPercent}% used
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 24, fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                  {metrics?.ram_used_mb ?? 0} MB
                </span>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                  / {metrics?.ram_max_mb ?? metrics?.ram_total_mb ?? 0} MB
                </span>
              </div>
              {/* RAM Bar */}
              <div
                style={{
                  height: 8,
                  borderRadius: 4,
                  background: 'var(--surface-soft)',
                  border: '1px solid var(--line)',
                  overflow: 'hidden',
                  marginTop: 2,
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${Math.min(100, Math.max(0, ramPercent))}%`,
                    background:
                      ramPercent > 85 ? '#ef4444' : ramPercent > 70 ? '#f59e0b' : 'var(--primary-bottom, #0284c7)',
                    transition: 'width 300ms ease',
                  }}
                />
              </div>
            </div>

            {/* Online Players Count Card */}
            <div
              style={{
                padding: '16px 18px',
                background: 'var(--surface)',
                border: '1px solid var(--frame)',
                borderRadius: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase' }}>
                  Online Players
                </span>
                <img src={perfCenterIcon} alt="" style={{ width: 20, height: 20, opacity: 0.8 }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 28, fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                  {metrics?.online_count ?? 0}
                </span>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>players connected</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                {metrics?.online_players?.filter((p) => p.is_muted).length ?? 0} currently muted
              </div>
            </div>
          </div>

          {/* Online Players Table & Actions */}
          <section
            style={{
              padding: '16px 20px',
              background: 'var(--surface)',
              border: '1px solid var(--frame)',
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
                  Connected Players
                </h2>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 10,
                    background: 'var(--surface-soft)',
                    border: '1px solid var(--line)',
                    color: 'var(--muted)',
                  }}
                >
                  {filteredPlayers.length} of {metrics?.online_count ?? 0}
                </span>
              </div>

              {/* Player Search Input */}
              <input
                type="text"
                placeholder="Search online players by name or world..."
                value={playerSearch}
                onChange={(e) => setPlayerSearch(e.target.value)}
                style={{
                  minWidth: 240,
                  padding: '6px 12px',
                  borderRadius: 6,
                  border: '1px solid var(--frame)',
                  background: 'var(--field, rgba(0,0,0,0.15))',
                  color: 'var(--text)',
                  fontSize: 12,
                }}
              />
            </div>

            {metricsLoading && !metrics ? (
              <p style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>Loading live players…</p>
            ) : filteredPlayers.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '28px 16px', background: 'var(--surface-soft)', borderRadius: 6 }}>
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>
                  {metrics?.online_count === 0 ? 'No players currently online.' : 'No players match your search filter.'}
                </p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--line)', textAlign: 'left', color: 'var(--muted)' }}>
                      <th style={{ padding: '8px 10px' }}>Player</th>
                      <th style={{ padding: '8px 10px' }}>Location</th>
                      <th style={{ padding: '8px 10px' }}>Health</th>
                      <th style={{ padding: '8px 10px' }}>Ping</th>
                      <th style={{ padding: '8px 10px' }}>Status</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right' }}>Moderation Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPlayers.map((p) => (
                      <tr key={p.uuid} style={{ borderBottom: '1px solid var(--line)' }}>
                        <td style={{ padding: '10px 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <img
                            src={`https://mc-heads.net/avatar/${p.username}/24`}
                            alt=""
                            style={{ width: 24, height: 24, borderRadius: 3 }}
                            onError={(e) => {
                              ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                            }}
                          />
                          <div>
                            <div style={{ fontWeight: 600, color: 'var(--text)' }}>{displayPlayerName(p.username)}</div>
                            <code style={{ fontSize: 10, color: 'var(--muted)' }}>{p.uuid.slice(0, 8)}…</code>
                          </div>
                        </td>
                        <td style={{ padding: '10px 10px', color: 'var(--muted)', fontSize: 12 }}>
                          {p.world}: {p.x}, {p.y}, {p.z}
                        </td>
                        <td style={{ padding: '10px 10px', fontVariantNumeric: 'tabular-nums' }}>
                          ❤️ {p.health} / 20
                        </td>
                        <td style={{ padding: '10px 10px', fontVariantNumeric: 'tabular-nums', color: p.ping < 100 ? '#16a34a' : '#d97706' }}>
                          ⚡ {p.ping} ms
                        </td>
                        <td style={{ padding: '10px 10px' }}>
                          {p.is_muted ? (
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                color: '#ef4444',
                                background: 'rgba(239, 68, 68, 0.15)',
                                padding: '2px 6px',
                                borderRadius: 4,
                              }}
                            >
                              MUTED
                            </span>
                          ) : (
                            <span style={{ fontSize: 11, color: '#16a34a' }}>Active</span>
                          )}
                        </td>
                        <td style={{ padding: '10px 10px', textAlign: 'right' }}>
                          <div style={{ display: 'inline-flex', gap: 6 }}>
                            <button
                              type="button"
                              onClick={() => openModerationModal(p.username, p.uuid, 'kick')}
                              style={{
                                padding: '4px 10px',
                                borderRadius: 4,
                                border: '1px solid var(--frame)',
                                background: 'var(--surface-soft)',
                                color: 'var(--text)',
                                fontSize: 11,
                                fontWeight: 600,
                                cursor: 'pointer',
                              }}
                            >
                              Kick
                            </button>
                            {p.is_muted ? (
                              <button
                                type="button"
                                onClick={() => handleUnmute(p.username)}
                                style={{
                                  padding: '4px 10px',
                                  borderRadius: 4,
                                  border: '1px solid rgba(34, 197, 94, 0.4)',
                                  background: 'rgba(34, 197, 94, 0.1)',
                                  color: '#16a34a',
                                  fontSize: 11,
                                  fontWeight: 600,
                                  cursor: 'pointer',
                                }}
                              >
                                Unmute
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => openModerationModal(p.username, p.uuid, 'mute')}
                                style={{
                                  padding: '4px 10px',
                                  borderRadius: 4,
                                  border: '1px solid rgba(245, 158, 11, 0.4)',
                                  background: 'rgba(245, 158, 11, 0.1)',
                                  color: '#f59e0b',
                                  fontSize: 11,
                                  fontWeight: 600,
                                  cursor: 'pointer',
                                }}
                              >
                                Mute
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => openModerationModal(p.username, p.uuid, 'ban')}
                              style={{
                                padding: '4px 10px',
                                borderRadius: 4,
                                border: '1px solid rgba(239, 68, 68, 0.4)',
                                background: 'rgba(239, 68, 68, 0.1)',
                                color: '#ef4444',
                                fontSize: 11,
                                fontWeight: 600,
                                cursor: 'pointer',
                              }}
                            >
                              Ban
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 2: DIRECT CONSOLE TERMINAL                                       */}
      {/* ==================================================================== */}
      {activeTab === 'console' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              Direct Minecraft Server Console • Streams in real time
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}>
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                />
                Auto-scroll
              </label>
              <button
                type="button"
                onClick={() => {
                  playSound('click')
                  setConsoleLogs([])
                }}
                style={{
                  padding: '4px 10px',
                  borderRadius: 4,
                  border: '1px solid var(--frame)',
                  background: 'var(--surface-soft)',
                  color: 'var(--muted)',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                Clear Screen
              </button>
            </div>
          </div>

          {/* Terminal Screen */}
          <div
            style={{
              flex: 1,
              minHeight: 380,
              maxHeight: 460,
              padding: '14px 16px',
              borderRadius: 8,
              background: '#090d16',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              boxShadow: 'inset 0 2px 8px rgba(0, 0, 0, 0.6)',
              overflowY: 'auto',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: 12,
              lineHeight: 1.5,
              color: '#d1d5db',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {consoleLogs.length === 0 ? (
              <div style={{ color: '#6b7280', textAlign: 'center', padding: '60px 0' }}>
                Connecting to server terminal stream...
              </div>
            ) : (
              consoleLogs.map((log) => {
                const isCommand = log.text.startsWith('>')
                const isWarn = log.text.includes('[WARN]')
                const isError = log.text.includes('[ERROR]') || log.text.includes('[SEVERE]')
                const timeStr = new Date(log.timestamp).toLocaleTimeString()
                return (
                  <div
                    key={log.id}
                    style={{
                      display: 'flex',
                      gap: 8,
                      wordBreak: 'break-word',
                      color: isCommand ? '#38bdf8' : isError ? '#f87171' : isWarn ? '#fbbf24' : '#e5e7eb',
                    }}
                  >
                    <span style={{ color: '#4b5563', userSelect: 'none', flexShrink: 0 }}>
                      [{timeStr}]
                    </span>
                    <span>{log.text}</span>
                  </div>
                )
              })
            )}
            <div ref={terminalEndRef} />
          </div>

          {/* Command Prompt Input */}
          <form
            onSubmit={handleExecuteCommand}
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              background: 'var(--surface)',
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid var(--frame)',
            }}
          >
            <span
              style={{
                fontFamily: 'monospace',
                fontWeight: 700,
                color: 'var(--primary-bottom, #0284c7)',
                fontSize: 14,
              }}
            >
              &gt;
            </span>
            <input
              type="text"
              placeholder="Enter server command (e.g. say Hello, time set day, weather clear, op Steve)..."
              value={commandInput}
              onChange={(e) => setCommandInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  if (commandHistory.length === 0) return
                  const nextIdx = historyIndex < 0 ? commandHistory.length - 1 : Math.max(0, historyIndex - 1)
                  setHistoryIndex(nextIdx)
                  setCommandInput(commandHistory[nextIdx])
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  if (historyIndex >= 0 && historyIndex < commandHistory.length - 1) {
                    const nextIdx = historyIndex + 1
                    setHistoryIndex(nextIdx)
                    setCommandInput(commandHistory[nextIdx])
                  } else {
                    setHistoryIndex(-1)
                    setCommandInput('')
                  }
                }
              }}
              style={{
                flex: 1,
                border: 'none',
                background: 'transparent',
                color: 'var(--text)',
                fontFamily: 'monospace',
                fontSize: 13,
                outline: 'none',
              }}
            />
            <button
              type="submit"
              disabled={executingCommand || !commandInput.trim()}
              className="btn"
              style={{
                padding: '6px 16px',
                borderRadius: 6,
                background: 'linear-gradient(var(--primary-top, #38bdf8), var(--primary-bottom, #0284c7))',
                color: '#ffffff',
                border: '1px solid var(--primary-edge, #0284c7)',
                fontSize: 12,
                fontWeight: 600,
                cursor: executingCommand || !commandInput.trim() ? 'not-allowed' : 'pointer',
                opacity: executingCommand || !commandInput.trim() ? 0.6 : 1,
              }}
            >
              {executingCommand ? 'Executing…' : 'Execute'}
            </button>
          </form>
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 3: MODERATION & BANS                                             */}
      {/* ==================================================================== */}
      {activeTab === 'moderation' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
              Moderation & Punishments Management
            </h2>
            <button
              type="button"
              onClick={() => openModerationModal('', undefined, 'ban')}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                background: 'linear-gradient(var(--primary-top, #38bdf8), var(--primary-bottom, #0284c7))',
                color: '#ffffff',
                border: '1px solid var(--primary-edge, #0284c7)',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              + Issue Player Sanction
            </button>
          </div>

          {/* Active Bans Section */}
          <section
            style={{
              padding: '16px 20px',
              background: 'var(--surface)',
              border: '1px solid var(--frame)',
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#ef4444' }}>Active Player Bans</span>
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 10,
                  background: 'rgba(239, 68, 68, 0.15)',
                  color: '#ef4444',
                  fontWeight: 600,
                }}
              >
                {modList.bans.length}
              </span>
            </div>

            {modLoading && modList.bans.length === 0 ? (
              <p style={{ color: 'var(--muted)', textAlign: 'center', padding: 16 }}>Loading bans…</p>
            ) : modList.bans.length === 0 ? (
              <div style={{ padding: '16px', textAlign: 'center', background: 'var(--surface-soft)', borderRadius: 6 }}>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>No active bans on the server.</p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--line)', textAlign: 'left', color: 'var(--muted)' }}>
                      <th style={{ padding: '8px 10px' }}>Player</th>
                      <th style={{ padding: '8px 10px' }}>Reason</th>
                      <th style={{ padding: '8px 10px' }}>Banned By</th>
                      <th style={{ padding: '8px 10px' }}>Expires At</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modList.bans.map((b) => (
                      <tr key={b.id} style={{ borderBottom: '1px solid var(--line)' }}>
                        <td style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--text)' }}>
                          {displayPlayerName(b.username)}
                        </td>
                        <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>{b.reason}</td>
                        <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>{b.banned_by_or_muted_by}</td>
                        <td style={{ padding: '8px 10px', color: b.expires_at ? '#d97706' : '#ef4444' }}>
                          {b.expires_at ? new Date(b.expires_at).toLocaleString() : 'Permanent'}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                          <button
                            type="button"
                            onClick={() => handleUnban(b.username)}
                            style={{
                              padding: '3px 10px',
                              borderRadius: 4,
                              border: '1px solid rgba(34, 197, 94, 0.4)',
                              background: 'rgba(34, 197, 94, 0.1)',
                              color: '#16a34a',
                              fontSize: 11,
                              fontWeight: 600,
                              cursor: 'pointer',
                            }}
                          >
                            Unban
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Active Mutes Section */}
          <section
            style={{
              padding: '16px 20px',
              background: 'var(--surface)',
              border: '1px solid var(--frame)',
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#f59e0b' }}>Active Player Mutes</span>
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 10,
                  background: 'rgba(245, 158, 11, 0.15)',
                  color: '#f59e0b',
                  fontWeight: 600,
                }}
              >
                {modList.mutes.length}
              </span>
            </div>

            {modLoading && modList.mutes.length === 0 ? (
              <p style={{ color: 'var(--muted)', textAlign: 'center', padding: 16 }}>Loading mutes…</p>
            ) : modList.mutes.length === 0 ? (
              <div style={{ padding: '16px', textAlign: 'center', background: 'var(--surface-soft)', borderRadius: 6 }}>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>No active mutes on the server.</p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--line)', textAlign: 'left', color: 'var(--muted)' }}>
                      <th style={{ padding: '8px 10px' }}>Player</th>
                      <th style={{ padding: '8px 10px' }}>Reason</th>
                      <th style={{ padding: '8px 10px' }}>Muted By</th>
                      <th style={{ padding: '8px 10px' }}>Expires At</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modList.mutes.map((m) => (
                      <tr key={m.id} style={{ borderBottom: '1px solid var(--line)' }}>
                        <td style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--text)' }}>
                          {displayPlayerName(m.username)}
                        </td>
                        <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>{m.reason}</td>
                        <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>{m.banned_by_or_muted_by}</td>
                        <td style={{ padding: '8px 10px', color: m.expires_at ? '#d97706' : '#ef4444' }}>
                          {m.expires_at ? new Date(m.expires_at).toLocaleString() : 'Permanent'}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                          <button
                            type="button"
                            onClick={() => handleUnmute(m.username)}
                            style={{
                              padding: '3px 10px',
                              borderRadius: 4,
                              border: '1px solid rgba(34, 197, 94, 0.4)',
                              background: 'rgba(34, 197, 94, 0.1)',
                              color: '#16a34a',
                              fontSize: 11,
                              fontWeight: 600,
                              cursor: 'pointer',
                            }}
                          >
                            Unmute
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 4: CHAT LOGS                                                     */}
      {/* ==================================================================== */}
      {activeTab === 'chat' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Search bar */}
          <form
            onSubmit={(e) => {
              void handleFilterChatLogs(e)
            }}
            style={{
              display: 'flex',
              gap: 10,
              flexWrap: 'wrap',
              background: 'var(--surface-soft)',
              padding: '12px 16px',
              borderRadius: 8,
              border: '1px solid var(--line)',
            }}
          >
            <input
              type="text"
              placeholder="Filter by keyword / message text..."
              value={chatQuery}
              onChange={(e) => setChatQuery(e.target.value)}
              style={{
                flex: 1,
                minWidth: 200,
                padding: '6px 12px',
                borderRadius: 6,
                border: '1px solid var(--frame)',
                background: 'var(--field, rgba(0,0,0,0.15))',
                color: 'var(--text)',
                fontSize: 12,
              }}
            />
            <input
              type="text"
              placeholder="Filter by sender name..."
              value={chatUserFilter}
              onChange={(e) => setChatUserFilter(e.target.value)}
              style={{
                width: 180,
                padding: '6px 12px',
                borderRadius: 6,
                border: '1px solid var(--frame)',
                background: 'var(--field, rgba(0,0,0,0.15))',
                color: 'var(--text)',
                fontSize: 12,
              }}
            />
            <button
              type="submit"
              disabled={chatLoading}
              className="btn"
              style={{
                padding: '6px 16px',
                borderRadius: 6,
                background: 'linear-gradient(var(--primary-top, #38bdf8), var(--primary-bottom, #0284c7))',
                color: '#ffffff',
                border: '1px solid var(--primary-edge, #0284c7)',
                fontSize: 12,
                fontWeight: 600,
                cursor: chatLoading ? 'not-allowed' : 'pointer',
              }}
            >
              {chatLoading ? 'Filtering…' : 'Filter Logs'}
            </button>
          </form>

          {/* Chat List */}
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--frame)',
              borderRadius: 8,
              padding: '12px 16px',
              maxHeight: 460,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {chatLogs.length === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--muted)', padding: 32 }}>No chat messages found.</p>
            ) : (
              chatLogs.map((msg) => (
                <div
                  key={msg.id}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 10,
                    padding: '6px 8px',
                    borderRadius: 6,
                    background: 'var(--surface-soft)',
                    border: '1px solid var(--line)',
                    fontSize: 13,
                  }}
                >
                  <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>
                    {msg.created_at ? new Date(msg.created_at).toLocaleTimeString() : ''}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      padding: '1px 5px',
                      borderRadius: 4,
                      background: msg.source === 'game' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(56, 189, 248, 0.15)',
                      color: msg.source === 'game' ? '#16a34a' : '#0284c7',
                      fontWeight: 600,
                      flexShrink: 0,
                    }}
                  >
                    {msg.source}
                  </span>
                  <strong style={{ color: 'var(--text)', flexShrink: 0 }}>{displayPlayerName(msg.sender_name)}:</strong>
                  <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>{msg.text}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 5: ECONOMY & COINS                                               */}
      {/* ==================================================================== */}
      {activeTab === 'economy' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {economyLoading && accounts.length === 0 ? (
            <p style={{ color: 'var(--muted)', textAlign: 'center', padding: 32 }}>Loading accounts…</p>
          ) : accounts.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 32, background: 'var(--surface-soft)', borderRadius: 8 }}>
              <p style={{ margin: 0, color: 'var(--muted)' }}>
                No linked Minecraft accounts found yet. Link your Minecraft account first in Account Overview.
              </p>
            </div>
          ) : (
            <>
              {/* Target Account Selector */}
              <section
                style={{
                  padding: '16px 20px',
                  background: 'var(--surface)',
                  border: '1px solid var(--frame)',
                  borderRadius: 8,
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.15)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Target Minecraft Account</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'} available
                  </span>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  {accounts.map((acc) => {
                    const isSelected = acc.uuid === selectedUuid
                    return (
                      <button
                        key={acc.uuid}
                        type="button"
                        onClick={() => {
                          playSound('click')
                          setSelectedUuid(acc.uuid)
                          setSuccessMessage('')
                          setError('')
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '8px 14px',
                          borderRadius: 6,
                          border: isSelected
                            ? '1px solid var(--primary-edge, #0284c7)'
                            : '1px solid var(--line)',
                          background: isSelected
                            ? 'linear-gradient(rgba(14, 165, 233, 0.2), rgba(2, 132, 199, 0.3))'
                            : 'var(--surface-soft)',
                          color: 'var(--text)',
                          cursor: 'pointer',
                          fontWeight: isSelected ? 600 : 400,
                          transition: 'all 150ms ease',
                        }}
                      >
                        <img
                          src={`https://mc-heads.net/avatar/${acc.username}/24`}
                          alt=""
                          style={{ width: 22, height: 22, borderRadius: 3 }}
                          onError={(e) => {
                            ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                          }}
                        />
                        <span>{displayPlayerName(acc.username)}</span>
                        {acc.is_self && (
                          <span
                            style={{
                              fontSize: 10,
                              padding: '2px 6px',
                              borderRadius: 4,
                              background: 'rgba(14, 165, 233, 0.25)',
                              color: '#0284c7',
                              fontWeight: 700,
                              textTransform: 'uppercase',
                            }}
                          >
                            You
                          </span>
                        )}
                        <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 4 }}>
                          ({acc.coins.toLocaleString()}c)
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>

              {selectedAccount && (
                <>
                  {/* Current Balance Display Card */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '20px 24px',
                      background: 'var(--surface-soft)',
                      border: '1px solid var(--line)',
                      borderRadius: 8,
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: 'var(--muted)',
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                        }}
                      >
                        Current Coins Balance
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                        <img src={coinIcon} alt="" style={{ width: 28, height: 28 }} />
                        <span
                          style={{
                            fontSize: 26,
                            fontWeight: 800,
                            color: 'var(--text)',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {selectedAccount.coins.toLocaleString()}
                        </span>
                        <span style={{ fontSize: 14, color: 'var(--muted)', fontWeight: 600 }}>coins</span>
                      </div>
                    </div>

                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>Character UUID</div>
                      <code style={{ fontSize: 11, color: 'var(--text)', opacity: 0.8 }}>{selectedAccount.uuid}</code>
                    </div>
                  </div>

                  {/* Quick Add Presets */}
                  <section
                    style={{
                      padding: '16px 20px',
                      background: 'var(--surface)',
                      border: '1px solid var(--frame)',
                      borderRadius: 8,
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text)' }}>
                      Quick Coin Grants
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {presets.map((preset) => (
                        <button
                          key={preset.amount}
                          type="button"
                          disabled={submittingEconomy}
                          onClick={() => handleApplyEconomy('add', preset.amount)}
                          style={{
                            padding: '8px 14px',
                            borderRadius: 6,
                            border: '1px solid var(--frame)',
                            background: 'var(--surface-soft)',
                            color: 'var(--text)',
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: submittingEconomy ? 'not-allowed' : 'pointer',
                            transition: 'background 150ms ease',
                          }}
                        >
                          {preset.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        disabled={submittingEconomy}
                        onClick={() => handleApplyEconomy('set', 0)}
                        style={{
                          padding: '8px 14px',
                          borderRadius: 6,
                          border: '1px solid rgba(239, 68, 68, 0.4)',
                          background: 'rgba(239, 68, 68, 0.08)',
                          color: '#ef4444',
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: submittingEconomy ? 'not-allowed' : 'pointer',
                          marginLeft: 'auto',
                        }}
                      >
                        Reset to 0
                      </button>
                    </div>
                  </section>

                  {/* Custom Adjustment Form */}
                  <section
                    style={{
                      padding: '20px',
                      background: 'var(--surface)',
                      border: '1px solid var(--frame)',
                      borderRadius: 8,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 16,
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                      Custom Balance Adjustment
                    </div>

                    {/* Operation Picker */}
                    <div
                      style={{
                        display: 'flex',
                        gap: 6,
                        background: 'var(--surface-soft)',
                        padding: 4,
                        borderRadius: 6,
                        width: 'fit-content',
                      }}
                    >
                      {(['set', 'add', 'subtract'] as Operation[]).map((op) => {
                        const active = operation === op
                        const labels: Record<Operation, string> = {
                          set: 'Set Balance',
                          add: 'Add Coins',
                          subtract: 'Deduct Coins',
                        }
                        return (
                          <button
                            key={op}
                            type="button"
                            onClick={() => {
                              playSound('click')
                              setOperation(op)
                            }}
                            style={{
                              padding: '6px 14px',
                              borderRadius: 4,
                              border: active ? '1px solid var(--primary-edge, #0284c7)' : '1px solid transparent',
                              background: active ? 'var(--primary-bottom, #0284c7)' : 'transparent',
                              color: active ? '#ffffff' : 'var(--text)',
                              fontSize: 12,
                              fontWeight: active ? 600 : 500,
                              cursor: 'pointer',
                            }}
                          >
                            {labels[op]}
                          </button>
                        )
                      })}
                    </div>

                    {/* Input & Action */}
                    <form
                      onSubmit={(e) => {
                        e.preventDefault()
                        if (validAmount) {
                          handleApplyEconomy(operation, parsedAmount)
                        }
                      }}
                      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
                    >
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <div style={{ position: 'relative', flex: 1 }}>
                          <input
                            type="text"
                            inputMode="numeric"
                            placeholder="Enter amount (e.g. 500,000)"
                            value={amountInput}
                            onChange={(e) => setAmountInput(e.target.value)}
                            style={{
                              width: '100%',
                              minHeight: 40,
                              padding: '8px 12px',
                              borderRadius: 6,
                              border: '1px solid var(--frame)',
                              background: 'var(--field, rgba(0,0,0,0.15))',
                              color: 'var(--text)',
                              fontSize: 14,
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          />
                        </div>

                        <button
                          type="submit"
                          disabled={submittingEconomy || !validAmount}
                          className="btn"
                          style={{
                            minHeight: 40,
                            padding: '0 20px',
                            background: 'linear-gradient(var(--primary-top, #38bdf8), var(--primary-bottom, #0284c7))',
                            color: 'var(--primary-text, #ffffff)',
                            border: '1px solid var(--primary-edge, #0284c7)',
                            borderRadius: 6,
                            fontWeight: 600,
                            cursor: submittingEconomy || !validAmount ? 'not-allowed' : 'pointer',
                            opacity: submittingEconomy || !validAmount ? 0.6 : 1,
                          }}
                        >
                          {submittingEconomy ? 'Applying…' : 'Apply Balance'}
                        </button>
                      </div>

                      {previewNewBalance !== null && (
                        <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', gap: 6 }}>
                          <span>Resulting balance:</span>
                          <strong style={{ color: 'var(--text)' }}>
                            {previewNewBalance.toLocaleString()} coins
                          </strong>
                        </div>
                      )}
                    </form>
                  </section>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL: PLAYER MODERATION ACTION (Kick / Ban / Mute)                  */}
      {/* ==================================================================== */}
      {modModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.6)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: 20,
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 440,
              background: 'var(--surface)',
              border: '1px solid var(--frame)',
              borderRadius: 10,
              boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
              padding: 24,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>
                {modAction === 'kick' ? 'Kick Player' : modAction === 'ban' ? 'Ban Player' : 'Mute Player'}
              </h3>
              <button
                type="button"
                onClick={() => {
                  playSound('close')
                  setModModalOpen(false)
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: 18,
                  color: 'var(--muted)',
                  cursor: 'pointer',
                }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleApplyModeration} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Target Username */}
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
                  Target Player Username
                </label>
                <input
                  type="text"
                  required
                  value={targetUsername}
                  onChange={(e) => setTargetUsername(e.target.value)}
                  placeholder="Player username..."
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: '1px solid var(--frame)',
                    background: 'var(--field, rgba(0,0,0,0.15))',
                    color: 'var(--text)',
                    fontSize: 13,
                  }}
                />
              </div>

              {/* Action Picker */}
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
                  Action Type
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {(['kick', 'mute', 'ban'] as ModerationAction[]).map((act) => {
                    const isSelected = modAction === act
                    return (
                      <button
                        key={act}
                        type="button"
                        onClick={() => {
                          playSound('click')
                          setModAction(act)
                        }}
                        style={{
                          flex: 1,
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: isSelected
                            ? '1px solid var(--primary-edge, #0284c7)'
                            : '1px solid var(--frame)',
                          background: isSelected
                            ? 'linear-gradient(var(--primary-top, #38bdf8), var(--primary-bottom, #0284c7))'
                            : 'var(--surface-soft)',
                          color: isSelected ? '#ffffff' : 'var(--text)',
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: 'pointer',
                          textTransform: 'capitalize',
                        }}
                      >
                        {act}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Duration (only for Ban and Mute) */}
              {modAction !== 'kick' && (
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
                    Sanction Duration
                  </label>
                  <select
                    value={modDuration}
                    onChange={(e) => setModDuration(Number(e.target.value))}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: 6,
                      border: '1px solid var(--frame)',
                      background: 'var(--field, rgba(0,0,0,0.15))',
                      color: 'var(--text)',
                      fontSize: 13,
                    }}
                  >
                    <option value={900}>15 Minutes</option>
                    <option value={3600}>1 Hour</option>
                    <option value={86400}>1 Day (24 hours)</option>
                    <option value={604800}>7 Days</option>
                    <option value={2592000}>30 Days</option>
                    <option value={0}>Permanent</option>
                  </select>
                </div>
              )}

              {/* Reason */}
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
                  Reason
                </label>
                <input
                  type="text"
                  value={modReason}
                  onChange={(e) => setModReason(e.target.value)}
                  placeholder="Reason for punishment..."
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: '1px solid var(--frame)',
                    background: 'var(--field, rgba(0,0,0,0.15))',
                    color: 'var(--text)',
                    fontSize: 13,
                  }}
                />
              </div>

              {/* Dialog Buttons */}
              <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    playSound('close')
                    setModModalOpen(false)
                  }}
                  style={{
                    flex: 1,
                    padding: '8px 14px',
                    borderRadius: 6,
                    border: '1px solid var(--frame)',
                    background: 'var(--surface-soft)',
                    color: 'var(--text)',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={modSubmitting || !targetUsername.trim()}
                  className="btn"
                  style={{
                    flex: 1,
                    padding: '8px 14px',
                    borderRadius: 6,
                    background:
                      modAction === 'ban'
                        ? '#ef4444'
                        : modAction === 'mute'
                          ? '#f59e0b'
                          : 'linear-gradient(var(--primary-top, #38bdf8), var(--primary-bottom, #0284c7))',
                    color: '#ffffff',
                    border: 'none',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: modSubmitting || !targetUsername.trim() ? 'not-allowed' : 'pointer',
                  }}
                >
                  {modSubmitting ? 'Applying…' : `Confirm ${modAction.toUpperCase()}`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
