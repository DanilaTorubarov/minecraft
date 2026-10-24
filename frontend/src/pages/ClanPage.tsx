import { useEffect, useState } from 'react'
import {
  acceptClanInvite,
  createClan,
  declineClanInvite,
  depositClanBank,
  disbandClan,
  getMyClan,
  getPublicClans,
  inviteClanMember,
  kickClanMember,
  leaveClan,
  promoteClanMember,
  setClanRelation,
  withdrawClanBank,
  type MyClanData,
  type PublicClan,
} from '../lib/api'
import { displayPlayerName } from '../lib/playerName'
import { playSound } from '../lib/sounds'
import coinIcon from '../assets/icons/coin.png'
import firewallOnIcon from '../assets/icons/vista-firewall-on.png'
import globeIcon from '../assets/icons/vista-search-globe.png'
import StatusBadge from '../components/StatusBadge'

interface Props {
  visible: boolean
  onOpenMap?: () => void
}

type InClanTab = 'roster' | 'treasury' | 'diplomacy' | 'territories' | 'settings'
type NoClanTab = 'create' | 'invites' | 'browse'

export default function ClanPage({ visible, onOpenMap }: Props) {
  const [clanData, setClanData] = useState<MyClanData | null>(null)
  const [publicClans, setPublicClans] = useState<PublicClan[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [successMsg, setSuccessMsg] = useState('')

  // Tabs
  const [activeTab, setActiveTab] = useState<InClanTab>('roster')
  const [noClanTab, setNoClanTab] = useState<NoClanTab>('create')

  // Modals & form states
  const [inviteModalOpen, setInviteModalOpen] = useState(false)
  const [inviteUsername, setInviteUsername] = useState('')
  const [submittingInvite, setSubmittingInvite] = useState(false)

  const [relationModalOpen, setRelationModalOpen] = useState(false)
  const [relationTag, setRelationTag] = useState('')
  const [relationStatus, setRelationStatus] = useState<'ally' | 'truce' | 'war' | 'neutral'>('ally')
  const [submittingRelation, setSubmittingRelation] = useState(false)

  const [bankModalOpen, setBankModalOpen] = useState(false)
  const [bankOp, setBankOp] = useState<'deposit' | 'withdraw'>('deposit')
  const [bankAmountInput, setBankAmountInput] = useState('')
  const [submittingBank, setSubmittingBank] = useState(false)

  // Create clan form
  const [createTag, setCreateTag] = useState('')
  const [createName, setCreateName] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [submittingCreate, setSubmittingCreate] = useState(false)

  // Search filter for public clans
  const [browseFilter, setBrowseFilter] = useState('')

  const refreshData = async () => {
    try {
      const [my, pub] = await Promise.all([getMyClan(), getPublicClans()])
      setClanData(my)
      setPublicClans(pub)
      setError('')
    } catch {
      setError('Could not load clan data. Make sure you are logged in.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!visible) return
    let active = true
    const load = async () => {
      try {
        const [my, pub] = await Promise.all([getMyClan(), getPublicClans()])
        if (active) {
          setClanData(my)
          setPublicClans(pub)
          setLoading(false)
        }
      } catch {
        if (active) {
          setError('Could not load clan data. Make sure you are logged in.')
          setLoading(false)
        }
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [visible])

  // Handlers
  const handleCreateClan = async (e: React.FormEvent) => {
    e.preventDefault()
    const tag = createTag.trim().toUpperCase()
    const name = createName.trim()
    if (tag.length < 2 || tag.length > 6) {
      setError('Clan tag must be 2 to 6 alphanumeric characters (e.g. TITAN).')
      return
    }
    if (name.length < 3 || name.length > 24) {
      setError('Clan name must be between 3 and 24 characters.')
      return
    }

    setSubmittingCreate(true)
    setError('')
    setSuccessMsg('')
    try {
      playSound('click')
      await createClan({ tag, name, description: createDesc.trim() || undefined })
      playSound('done')
      setSuccessMsg(`Clan [${tag}] ${name} created successfully!`)
      setCreateTag('')
      setCreateName('')
      setCreateDesc('')
      await refreshData()
    } catch {
      setError('Failed to create clan. The tag or name may already be taken, or you must link an account first.')
    } finally {
      setSubmittingCreate(false)
    }
  }

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!inviteUsername.trim()) return
    setSubmittingInvite(true)
    setError('')
    setSuccessMsg('')
    try {
      playSound('click')
      await inviteClanMember(inviteUsername.trim())
      playSound('done')
      setSuccessMsg(`Invitation sent to ${inviteUsername.trim()}!`)
      setInviteUsername('')
      setInviteModalOpen(false)
      await refreshData()
    } catch {
      setError(`Could not invite ${inviteUsername}. Player not found or already in a clan.`)
    } finally {
      setSubmittingInvite(false)
    }
  }

  const handleAcceptInvite = async (id: string, clanTag: string) => {
    playSound('click')
    try {
      await acceptClanInvite(id)
      playSound('done')
      setSuccessMsg(`Joined clan [${clanTag}]!`)
      await refreshData()
    } catch {
      setError('Failed to accept clan invite.')
    }
  }

  const handleDeclineInvite = async (id: string) => {
    playSound('click')
    try {
      await declineClanInvite(id)
      await refreshData()
    } catch {
      setError('Failed to decline invite.')
    }
  }

  const handleKick = async (uuid: string, username: string) => {
    if (!confirm(`Are you sure you want to kick ${username} from the clan?`)) return
    playSound('click')
    try {
      await kickClanMember(uuid)
      playSound('done')
      setSuccessMsg(`Kicked ${username} from clan.`)
      await refreshData()
    } catch {
      setError(`Failed to kick ${username}.`)
    }
  }

  const handlePromote = async (uuid: string, username: string, role: 'officer' | 'member' | 'leader') => {
    const actionDesc =
      role === 'leader'
        ? `transfer leadership to ${username}? You will become an Officer`
        : role === 'officer'
          ? `promote ${username} to Officer`
          : `demote ${username} to Member`

    if (!confirm(`Are you sure you want to ${actionDesc}?`)) return
    playSound('click')
    try {
      await promoteClanMember(uuid, role)
      playSound('done')
      setSuccessMsg(`Updated role for ${username}.`)
      await refreshData()
    } catch {
      setError(`Failed to update role for ${username}.`)
    }
  }

  const handleLeave = async () => {
    if (!confirm('Are you sure you want to leave your clan?')) return
    playSound('click')
    try {
      await leaveClan()
      playSound('done')
      setSuccessMsg('You have left the clan.')
      await refreshData()
    } catch {
      setError('Leaders must transfer leadership or disband the clan before leaving.')
    }
  }

  const handleDisband = async () => {
    if (!confirm('DANGER: Disband the clan entirely? This will remove all members, bank funds, and territories!')) return
    playSound('click')
    try {
      await disbandClan()
      playSound('done')
      setSuccessMsg('Clan has been disbanded.')
      await refreshData()
    } catch {
      setError('Failed to disband clan.')
    }
  }

  const handleBankSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const amount = parseInt(bankAmountInput.replace(/[^0-9]/g, ''), 10)
    if (isNaN(amount) || amount <= 0) {
      setError('Please enter a valid positive number of coins.')
      return
    }

    setSubmittingBank(true)
    setError('')
    setSuccessMsg('')
    try {
      playSound('click')
      if (bankOp === 'deposit') {
        await depositClanBank(amount)
        setSuccessMsg(`Deposited ${amount.toLocaleString()} coins into clan treasury!`)
      } else {
        await withdrawClanBank(amount)
        setSuccessMsg(`Withdrew ${amount.toLocaleString()} coins from clan treasury!`)
      }
      playSound('done')
      setBankAmountInput('')
      setBankModalOpen(false)
      await refreshData()
    } catch {
      setError(`Insufficient ${bankOp === 'deposit' ? 'player' : 'clan treasury'} balance.`)
    } finally {
      setSubmittingBank(false)
    }
  }

  const handleSetRelation = async (e: React.FormEvent) => {
    e.preventDefault()
    const tag = relationTag.trim().toUpperCase()
    if (!tag) return

    setSubmittingRelation(true)
    setError('')
    setSuccessMsg('')
    try {
      playSound('click')
      await setClanRelation(tag, relationStatus)
      playSound('done')
      setSuccessMsg(`Diplomatic relation with [${tag}] set to ${relationStatus}!`)
      setRelationTag('')
      setRelationModalOpen(false)
      await refreshData()
    } catch {
      setError(`Failed to set relation with [${tag}]. Verify clan tag exists.`)
    } finally {
      setSubmittingRelation(false)
    }
  }

  const clan = clanData?.clan
  const isLeader = clanData?.my_role === 'leader'
  const isOfficerOrLeader = clanData?.my_role === 'leader' || clanData?.my_role === 'officer'

  // Filtered public clans
  const filteredClans = publicClans.filter((c) => {
    if (!browseFilter.trim()) return true
    const q = browseFilter.toLowerCase()
    return c.tag.toLowerCase().includes(q) || c.name.toLowerCase().includes(q) || c.leader_username.toLowerCase().includes(q)
  })

  return (
    <div
      className="workspace clan-workspace"
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
          <img src={firewallOnIcon} alt="" style={{ width: 42, height: 42, flexShrink: 0 }} />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>
                {clan ? `[${clan.tag}] ${clan.name}` : 'Clans & Factions'}
              </h1>
              {clan && (
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 10,
                    background: 'rgba(56, 189, 248, 0.2)',
                    color: '#0284c7',
                    fontWeight: 700,
                  }}
                >
                  {clanData?.my_role?.toUpperCase()}
                </span>
              )}
            </div>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--muted)' }}>
              {clan
                ? clan.description || 'Shared clan base protection, treasury, diplomacy, and territory control.'
                : 'Form alliances, build joint protected bases, and conquer territories together.'}
            </p>
          </div>
        </div>

        {/* Home Location Badge */}
        {clan && clanData?.home && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '6px 14px',
              borderRadius: 6,
              background: 'var(--surface)',
              border: '1px solid var(--frame)',
            }}
          >
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Clan Home:</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
              {clanData.home.world} ({Math.round(clanData.home.x)}, {Math.round(clanData.home.y)}, {Math.round(clanData.home.z)})
            </span>
            {onOpenMap && (
              <button
                type="button"
                onClick={onOpenMap}
                style={{
                  padding: '2px 8px',
                  borderRadius: 4,
                  border: '1px solid var(--line)',
                  background: 'var(--surface-soft)',
                  color: 'var(--primary-bottom, #0284c7)',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Map
              </button>
            )}
          </div>
        )}
      </div>

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

      {successMsg && (
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
          ✓ {successMsg}
        </div>
      )}

      {loading ? (
        <p style={{ textAlign: 'center', color: 'var(--muted)', padding: 32 }}>Loading clan telemetry…</p>
      ) : clanData?.in_clan && clan ? (
        /* ================================================================== */
        /* IN-CLAN DASHBOARD VIEW                                             */
        /* ================================================================== */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
                { id: 'roster', label: `Roster (${clanData.members.length})`, icon: '👥' },
                { id: 'treasury', label: `Treasury (${clan.coins.toLocaleString()}c)`, icon: '💰' },
                { id: 'diplomacy', label: `Diplomacy (${clanData.allies.length + clanData.wars.length})`, icon: '⚔️' },
                { id: 'territories', label: `Territories (${clanData.bases.length})`, icon: '🏰' },
                { id: 'settings', label: 'Clan Settings', icon: '⚙️' },
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
                    setSuccessMsg('')
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
                </button>
              )
            })}
          </nav>

          {/* TAB: ROSTER */}
          {activeTab === 'roster' && (
            <section
              style={{
                padding: '18px 20px',
                background: 'var(--surface)',
                border: '1px solid var(--frame)',
                borderRadius: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                    Clan Members Roster
                  </h2>
                  <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                    All members share full access to each other’s private protection blocks.
                  </p>
                </div>

                {isOfficerOrLeader && (
                  <button
                    type="button"
                    onClick={() => {
                      playSound('click')
                      setInviteModalOpen(true)
                    }}
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
                    + Invite Player
                  </button>
                )}
              </div>

              {/* Roster Table */}
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--line)', textAlign: 'left', color: 'var(--muted)' }}>
                      <th style={{ padding: '8px 10px' }}>Member</th>
                      <th style={{ padding: '8px 10px' }}>Rank</th>
                      <th style={{ padding: '8px 10px' }}>Joined Date</th>
                      <th style={{ padding: '8px 10px' }}>Status</th>
                      {isOfficerOrLeader && <th style={{ padding: '8px 10px', textAlign: 'right' }}>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {clanData.members.map((m) => (
                      <tr key={m.uuid} style={{ borderBottom: '1px solid var(--line)' }}>
                        <td style={{ padding: '10px 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <img
                            src={`https://mc-heads.net/avatar/${m.username}/24`}
                            alt=""
                            style={{ width: 24, height: 24, borderRadius: 3 }}
                            onError={(e) => {
                              ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                            }}
                          />
                          <div>
                            <span style={{ fontWeight: 600, color: 'var(--text)' }}>{displayPlayerName(m.username)}</span>
                            {m.uuid === clanData.my_uuid && (
                              <span style={{ fontSize: 10, color: 'var(--primary-bottom, #0284c7)', marginLeft: 6, fontWeight: 700 }}>
                                (YOU)
                              </span>
                            )}
                          </div>
                        </td>
                        <td style={{ padding: '10px 10px' }}>
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              padding: '2px 8px',
                              borderRadius: 4,
                              background:
                                m.role === 'leader'
                                  ? 'rgba(234, 179, 8, 0.2)'
                                  : m.role === 'officer'
                                    ? 'rgba(56, 189, 248, 0.2)'
                                    : 'var(--surface-soft)',
                              color:
                                m.role === 'leader'
                                  ? '#eab308'
                                  : m.role === 'officer'
                                    ? '#0284c7'
                                    : 'var(--muted)',
                            }}
                          >
                            {m.role}
                          </span>
                        </td>
                        <td style={{ padding: '10px 10px', color: 'var(--muted)', fontSize: 12 }}>
                          {new Date(m.joined_at).toLocaleDateString()}
                        </td>
                        <td style={{ padding: '10px 10px' }}>
                          <StatusBadge
                            status={m.status || (m.is_online ? 'in_game' : 'offline')}
                            label={m.status_label}
                            compact
                          />
                        </td>
                        {isOfficerOrLeader && (
                          <td style={{ padding: '10px 10px', textAlign: 'right' }}>
                            {m.uuid !== clanData.my_uuid && (
                              <div style={{ display: 'inline-flex', gap: 6 }}>
                                {isLeader && m.role === 'member' && (
                                  <button
                                    type="button"
                                    onClick={() => handlePromote(m.uuid, displayPlayerName(m.username), 'officer')}
                                    style={{
                                      padding: '3px 8px',
                                      borderRadius: 4,
                                      border: '1px solid var(--line)',
                                      background: 'var(--surface-soft)',
                                      color: 'var(--text)',
                                      fontSize: 11,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    Promote
                                  </button>
                                )}
                                {isLeader && m.role === 'officer' && (
                                  <button
                                    type="button"
                                    onClick={() => handlePromote(m.uuid, displayPlayerName(m.username), 'member')}
                                    style={{
                                      padding: '3px 8px',
                                      borderRadius: 4,
                                      border: '1px solid var(--line)',
                                      background: 'var(--surface-soft)',
                                      color: 'var(--text)',
                                      fontSize: 11,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    Demote
                                  </button>
                                )}
                                {isLeader && (
                                  <button
                                    type="button"
                                    onClick={() => handlePromote(m.uuid, displayPlayerName(m.username), 'leader')}
                                    style={{
                                      padding: '3px 8px',
                                      borderRadius: 4,
                                      border: '1px solid rgba(234, 179, 8, 0.4)',
                                      background: 'rgba(234, 179, 8, 0.1)',
                                      color: '#ca8a04',
                                      fontSize: 11,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    Make Leader
                                  </button>
                                )}
                                {(isLeader || (clanData.my_role === 'officer' && m.role === 'member')) && (
                                  <button
                                    type="button"
                                    onClick={() => handleKick(m.uuid, displayPlayerName(m.username))}
                                    style={{
                                      padding: '3px 8px',
                                      borderRadius: 4,
                                      border: '1px solid rgba(239, 68, 68, 0.4)',
                                      background: 'rgba(239, 68, 68, 0.1)',
                                      color: '#ef4444',
                                      fontSize: 11,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    Kick
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* TAB: TREASURY */}
          {activeTab === 'treasury' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Treasury Balance Banner */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '20px 24px',
                  background: 'var(--surface)',
                  border: '1px solid var(--frame)',
                  borderRadius: 8,
                }}
              >
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase' }}>
                    Clan Treasury Balance
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                    <img src={coinIcon} alt="" style={{ width: 32, height: 32 }} />
                    <span style={{ fontSize: 28, fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                      {clan.coins.toLocaleString()}
                    </span>
                    <span style={{ fontSize: 14, color: 'var(--muted)', fontWeight: 600 }}>coins</span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => {
                      playSound('click')
                      setBankOp('deposit')
                      setBankModalOpen(true)
                    }}
                    style={{
                      padding: '8px 18px',
                      borderRadius: 6,
                      background: 'linear-gradient(var(--primary-top, #38bdf8), var(--primary-bottom, #0284c7))',
                      color: '#ffffff',
                      border: '1px solid var(--primary-edge, #0284c7)',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    + Deposit Coins
                  </button>
                  {isOfficerOrLeader && (
                    <button
                      type="button"
                      onClick={() => {
                        playSound('click')
                        setBankOp('withdraw')
                        setBankModalOpen(true)
                      }}
                      style={{
                        padding: '8px 18px',
                        borderRadius: 6,
                        background: 'var(--surface-soft)',
                        border: '1px solid var(--frame)',
                        color: 'var(--text)',
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Withdraw Coins
                    </button>
                  )}
                </div>
              </div>

              {/* Treasury Audit Log */}
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
                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
                  Recent Treasury Transactions
                </h3>
                {clanData.treasury_logs.length === 0 ? (
                  <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12 }}>No treasury activity recorded yet.</p>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--line)', textAlign: 'left', color: 'var(--muted)' }}>
                          <th style={{ padding: '6px 8px' }}>Date</th>
                          <th style={{ padding: '6px 8px' }}>Player</th>
                          <th style={{ padding: '6px 8px' }}>Action</th>
                          <th style={{ padding: '6px 8px' }}>Amount</th>
                          <th style={{ padding: '6px 8px', textAlign: 'right' }}>Treasury After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {clanData.treasury_logs.map((log) => (
                          <tr key={log.id} style={{ borderBottom: '1px solid var(--line)' }}>
                            <td style={{ padding: '8px', color: 'var(--muted)' }}>
                              {new Date(log.created_at).toLocaleString()}
                            </td>
                            <td style={{ padding: '8px', fontWeight: 600, color: 'var(--text)' }}>
                              {displayPlayerName(log.player_username)}
                            </td>
                            <td style={{ padding: '8px' }}>
                              <span
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  textTransform: 'uppercase',
                                  padding: '2px 6px',
                                  borderRadius: 4,
                                  background: log.action === 'deposit' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                                  color: log.action === 'deposit' ? '#16a34a' : '#ef4444',
                                }}
                              >
                                {log.action}
                              </span>
                            </td>
                            <td
                              style={{
                                padding: '8px',
                                fontWeight: 700,
                                color: log.action === 'deposit' ? '#16a34a' : '#ef4444',
                                fontVariantNumeric: 'tabular-nums',
                              }}
                            >
                              {log.action === 'deposit' ? '+' : '-'}
                              {log.amount.toLocaleString()} c
                            </td>
                            <td style={{ padding: '8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>
                              {log.balance_after.toLocaleString()} c
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

          {/* TAB: DIPLOMACY */}
          {activeTab === 'diplomacy' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                  Faction Diplomacy & Treaties
                </h2>
                {isOfficerOrLeader && (
                  <button
                    type="button"
                    onClick={() => {
                      playSound('click')
                      setRelationModalOpen(true)
                    }}
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
                    + Declare Relation
                  </button>
                )}
              </div>

              {/* Allies Row */}
              <section
                style={{
                  padding: '16px 20px',
                  background: 'var(--surface)',
                  border: '1px solid var(--frame)',
                  borderRadius: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#16a34a' }}>Allied Clans (Allies)</span>
                  <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 10, background: 'rgba(34, 197, 94, 0.15)', color: '#16a34a', fontWeight: 700 }}>
                    {clanData.allies.length}
                  </span>
                </div>
                {clanData.allies.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>No allied clans yet.</p>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {clanData.allies.map((a) => (
                      <div
                        key={a.other_clan_id}
                        style={{
                          padding: '6px 12px',
                          borderRadius: 6,
                          background: 'rgba(34, 197, 94, 0.1)',
                          border: '1px solid rgba(34, 197, 94, 0.3)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 13,
                          fontWeight: 600,
                          color: 'var(--text)',
                        }}
                      >
                        <span style={{ color: '#16a34a' }}>[{a.other_clan_tag}]</span>
                        <span>{a.other_clan_name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Truces Row */}
              <section
                style={{
                  padding: '16px 20px',
                  background: 'var(--surface)',
                  border: '1px solid var(--frame)',
                  borderRadius: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#0284c7' }}>Ceasefire & Truces</span>
                  <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 10, background: 'rgba(2, 132, 199, 0.15)', color: '#0284c7', fontWeight: 700 }}>
                    {clanData.truces.length}
                  </span>
                </div>
                {clanData.truces.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>No active truces.</p>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {clanData.truces.map((t) => (
                      <div
                        key={t.other_clan_id}
                        style={{
                          padding: '6px 12px',
                          borderRadius: 6,
                          background: 'rgba(2, 132, 199, 0.1)',
                          border: '1px solid rgba(2, 132, 199, 0.3)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 13,
                          fontWeight: 600,
                          color: 'var(--text)',
                        }}
                      >
                        <span style={{ color: '#0284c7' }}>[{t.other_clan_tag}]</span>
                        <span>{t.other_clan_name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Wars Row */}
              <section
                style={{
                  padding: '16px 20px',
                  background: 'var(--surface)',
                  border: '1px solid var(--frame)',
                  borderRadius: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#ef4444' }}>Declared Wars</span>
                  <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 10, background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444', fontWeight: 700 }}>
                    {clanData.wars.length}
                  </span>
                </div>
                {clanData.wars.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>No wars declared. Peace reigns.</p>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {clanData.wars.map((w) => (
                      <div
                        key={w.other_clan_id}
                        style={{
                          padding: '6px 12px',
                          borderRadius: 6,
                          background: 'rgba(239, 68, 68, 0.1)',
                          border: '1px solid rgba(239, 68, 68, 0.3)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 13,
                          fontWeight: 600,
                          color: 'var(--text)',
                        }}
                      >
                        <span style={{ color: '#ef4444' }}>[{w.other_clan_tag}]</span>
                        <span>{w.other_clan_name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* TAB: TERRITORIES */}
          {activeTab === 'territories' && (
            <section
              style={{
                padding: '18px 20px',
                background: 'var(--surface)',
                border: '1px solid var(--frame)',
                borderRadius: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                    Joint Clan Territories & Bases
                  </h2>
                  <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                    Protection cores placed by any clan member automatically grant building and container access to the entire clan.
                  </p>
                </div>
                {onOpenMap && (
                  <button
                    type="button"
                    onClick={onOpenMap}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 14px',
                      borderRadius: 6,
                      background: 'var(--surface-soft)',
                      border: '1px solid var(--line)',
                      color: 'var(--text)',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    <img src={globeIcon} alt="" style={{ width: 16, height: 16 }} />
                    View on World Map
                  </button>
                )}
              </div>

              {clanData.bases.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 24, background: 'var(--surface-soft)', borderRadius: 6 }}>
                  <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>
                    No private cores currently placed by clan members. Use /ps buy in game to acquire and place cores!
                  </p>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                  {clanData.bases.map((base) => {
                    const hoursLeft = Math.floor(base.fuel_seconds / 3600)
                    const minutesLeft = Math.floor((base.fuel_seconds % 3600) / 60)
                    const isFuelLow = base.fuel_seconds <= 7200 && base.fuel_seconds > 0
                    return (
                      <div
                        key={base.id}
                        style={{
                          padding: '14px 16px',
                          borderRadius: 8,
                          background: 'var(--surface-soft)',
                          border: isFuelLow ? '1px solid rgba(245, 158, 11, 0.6)' : '1px solid var(--line)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>
                            {displayPlayerName(base.owner_username)}’s Base #{base.block_index}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              padding: '2px 6px',
                              borderRadius: 4,
                              background: 'rgba(56, 189, 248, 0.15)',
                              color: '#0284c7',
                            }}
                          >
                            TIER {base.fuel_tier}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                          Location: <strong>{base.world}</strong> ({base.x}, {base.y}, {base.z})
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                          Protection: <strong>{base.radius * 2}×{base.radius * 2} blocks</strong> (Full Height)
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: base.fuel_seconds === 0 ? '#ef4444' : isFuelLow ? '#f59e0b' : '#16a34a',
                            }}
                          >
                            {base.fuel_seconds === 0
                              ? 'Dormant (No Fuel)'
                              : `Fuel remaining: ${hoursLeft}h ${minutesLeft}m`}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )}

          {/* TAB: SETTINGS */}
          {activeTab === 'settings' && (
            <section
              style={{
                padding: '18px 20px',
                background: 'var(--surface)',
                border: '1px solid var(--frame)',
                borderRadius: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 16,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                Clan Actions & Membership
              </h2>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: 'var(--surface-soft)', borderRadius: 6 }}>
                  <div>
                    <strong style={{ color: 'var(--text)', fontSize: 13 }}>Leave Clan</strong>
                    <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                      Renounce your clan membership and shared base permissions.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleLeave}
                    style={{
                      padding: '6px 14px',
                      borderRadius: 4,
                      border: '1px solid rgba(239, 68, 68, 0.4)',
                      background: 'rgba(239, 68, 68, 0.1)',
                      color: '#ef4444',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Leave Clan
                  </button>
                </div>

                {isLeader && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: 6 }}>
                    <div>
                      <strong style={{ color: '#ef4444', fontSize: 13 }}>Disband Clan</strong>
                      <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                        Permanently disband [{clan.tag}] {clan.name}. All relations and members will be dissolved.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleDisband}
                      style={{
                        padding: '6px 14px',
                        borderRadius: 4,
                        border: 'none',
                        background: '#ef4444',
                        color: '#ffffff',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Disband Clan
                    </button>
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      ) : (
        /* ================================================================== */
        /* NO-CLAN DASHBOARD VIEW (CREATE / INVITES / BROWSE)                 */
        /* ================================================================== */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Navigation for Clanless Players */}
          <nav
            role="tablist"
            style={{
              display: 'flex',
              gap: 6,
              background: 'var(--surface-soft)',
              padding: 4,
              borderRadius: 8,
              border: '1px solid var(--line)',
            }}
          >
            {(
              [
                { id: 'create', label: 'Create a Clan', icon: '⚔️' },
                { id: 'invites', label: `Pending Invites (${clanData?.pending_invites?.length ?? 0})`, icon: '✉️' },
                { id: 'browse', label: `Browse Clans (${publicClans.length})`, icon: '🌐' },
              ] as const
            ).map((tab) => {
              const isSelected = noClanTab === tab.id
              return (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={isSelected}
                  type="button"
                  onClick={() => {
                    playSound('click')
                    setNoClanTab(tab.id)
                    setError('')
                    setSuccessMsg('')
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
                  }}
                >
                  <span>{tab.icon}</span>
                  <span>{tab.label}</span>
                </button>
              )
            })}
          </nav>

          {/* TAB: CREATE CLAN */}
          {noClanTab === 'create' && (
            <section
              style={{
                padding: '24px',
                background: 'var(--surface)',
                border: '1px solid var(--frame)',
                borderRadius: 8,
                maxWidth: 520,
              }}
            >
              <h2 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>
                Found a New Clan
              </h2>
              <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--muted)' }}>
                Create your clan, invite trusted friends, deposit funds into the shared treasury, and secure joint private territories.
              </p>

              <form onSubmit={handleCreateClan} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
                    Clan Tag (2 to 6 characters, uppercase)
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={6}
                    placeholder="e.g. TITAN"
                    value={createTag}
                    onChange={(e) => setCreateTag(e.target.value.toUpperCase())}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: 6,
                      border: '1px solid var(--frame)',
                      background: 'var(--field, rgba(0,0,0,0.15))',
                      color: 'var(--text)',
                      fontSize: 14,
                      fontWeight: 700,
                      letterSpacing: 1,
                    }}
                  />
                </div>

                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
                    Clan Name (3 to 24 characters)
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={24}
                    placeholder="e.g. Titan Legion"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
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

                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
                    Motto / Description (Optional)
                  </label>
                  <textarea
                    rows={2}
                    maxLength={100}
                    placeholder="e.g. Unconquered rulers of the eastern peaks."
                    value={createDesc}
                    onChange={(e) => setCreateDesc(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: 6,
                      border: '1px solid var(--frame)',
                      background: 'var(--field, rgba(0,0,0,0.15))',
                      color: 'var(--text)',
                      fontSize: 13,
                      resize: 'none',
                    }}
                  />
                </div>

                <button
                  type="submit"
                  disabled={submittingCreate || !createTag.trim() || !createName.trim()}
                  className="btn"
                  style={{
                    marginTop: 6,
                    padding: '10px 20px',
                    borderRadius: 6,
                    background: 'linear-gradient(var(--primary-top, #38bdf8), var(--primary-bottom, #0284c7))',
                    color: '#ffffff',
                    border: '1px solid var(--primary-edge, #0284c7)',
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: submittingCreate ? 'not-allowed' : 'pointer',
                  }}
                >
                  {submittingCreate ? 'Creating…' : 'Establish Clan'}
                </button>
              </form>
            </section>
          )}

          {/* TAB: PENDING INVITES */}
          {noClanTab === 'invites' && (
            <section
              style={{
                padding: '20px',
                background: 'var(--surface)',
                border: '1px solid var(--frame)',
                borderRadius: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                Pending Clan Invitations
              </h2>
              {clanData?.pending_invites?.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 24, background: 'var(--surface-soft)', borderRadius: 6 }}>
                  <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>
                    You have no pending invitations. Ask a clan leader or officer in-game to type /clan invite your_name!
                  </p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {clanData?.pending_invites?.map((inv) => (
                    <div
                      key={inv.id}
                      style={{
                        padding: '12px 16px',
                        borderRadius: 6,
                        background: 'var(--surface-soft)',
                        border: '1px solid var(--line)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--primary-bottom, #0284c7)' }}>
                            [{inv.clan_tag}]
                          </span>
                          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
                            {inv.clan_name}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                          Invited for character: <strong>{displayPlayerName(inv.invited_username)}</strong>
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          type="button"
                          onClick={() => handleAcceptInvite(inv.id, inv.clan_tag)}
                          style={{
                            padding: '6px 14px',
                            borderRadius: 4,
                            border: '1px solid rgba(34, 197, 94, 0.4)',
                            background: 'rgba(34, 197, 94, 0.15)',
                            color: '#16a34a',
                            fontSize: 12,
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeclineInvite(inv.id)}
                          style={{
                            padding: '6px 14px',
                            borderRadius: 4,
                            border: '1px solid var(--frame)',
                            background: 'transparent',
                            color: 'var(--muted)',
                            fontSize: 12,
                            cursor: 'pointer',
                          }}
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* TAB: BROWSE CLANS */}
          {noClanTab === 'browse' && (
            <section
              style={{
                padding: '20px',
                background: 'var(--surface)',
                border: '1px solid var(--frame)',
                borderRadius: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                  Server Clans Directory
                </h2>
                <input
                  type="text"
                  placeholder="Filter clans by tag, name, or leader..."
                  value={browseFilter}
                  onChange={(e) => setBrowseFilter(e.target.value)}
                  style={{
                    minWidth: 220,
                    padding: '6px 12px',
                    borderRadius: 6,
                    border: '1px solid var(--frame)',
                    background: 'var(--field, rgba(0,0,0,0.15))',
                    color: 'var(--text)',
                    fontSize: 12,
                  }}
                />
              </div>

              {filteredClans.length === 0 ? (
                <p style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center', padding: 24 }}>
                  No clans match your filter.
                </p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--line)', textAlign: 'left', color: 'var(--muted)' }}>
                        <th style={{ padding: '8px 10px' }}>Clan</th>
                        <th style={{ padding: '8px 10px' }}>Leader</th>
                        <th style={{ padding: '8px 10px' }}>Members</th>
                        <th style={{ padding: '8px 10px', textAlign: 'right' }}>Treasury</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredClans.map((c) => (
                        <tr key={c.id} style={{ borderBottom: '1px solid var(--line)' }}>
                          <td style={{ padding: '10px 10px' }}>
                            <span style={{ fontWeight: 700, color: 'var(--primary-bottom, #0284c7)', marginRight: 6 }}>
                              [{c.tag}]
                            </span>
                            <span style={{ fontWeight: 600, color: 'var(--text)' }}>{c.name}</span>
                            {c.description && (
                              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{c.description}</div>
                            )}
                          </td>
                          <td style={{ padding: '10px 10px', color: 'var(--text)' }}>{displayPlayerName(c.leader_username)}</td>
                          <td style={{ padding: '10px 10px', color: 'var(--muted)' }}>{c.member_count}</td>
                          <td style={{ padding: '10px 10px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: '#eab308' }}>
                            {c.coins.toLocaleString()} c
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL: INVITE PLAYER                                                 */}
      {/* ==================================================================== */}
      {inviteModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
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
              maxWidth: 380,
              background: 'var(--surface)',
              border: '1px solid var(--frame)',
              borderRadius: 10,
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                Invite Player to Clan
              </h3>
              <button
                type="button"
                onClick={() => setInviteModalOpen(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleInvite} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <input
                type="text"
                required
                placeholder="Enter player's username..."
                value={inviteUsername}
                onChange={(e) => setInviteUsername(e.target.value)}
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
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setInviteModalOpen(false)}
                  style={{
                    flex: 1,
                    padding: '8px',
                    borderRadius: 6,
                    border: '1px solid var(--frame)',
                    background: 'var(--surface-soft)',
                    color: 'var(--text)',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingInvite || !inviteUsername.trim()}
                  className="btn"
                  style={{
                    flex: 1,
                    padding: '8px',
                    borderRadius: 6,
                    background: 'linear-gradient(var(--primary-top, #38bdf8), var(--primary-bottom, #0284c7))',
                    color: '#ffffff',
                    border: '1px solid var(--primary-edge, #0284c7)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: submittingInvite ? 'not-allowed' : 'pointer',
                  }}
                >
                  {submittingInvite ? 'Inviting…' : 'Send Invite'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL: BANK DEPOSIT / WITHDRAW                                       */}
      {/* ==================================================================== */}
      {bankModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
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
              maxWidth: 380,
              background: 'var(--surface)',
              border: '1px solid var(--frame)',
              borderRadius: 10,
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                {bankOp === 'deposit' ? 'Deposit into Clan Bank' : 'Withdraw from Clan Bank'}
              </h3>
              <button
                type="button"
                onClick={() => setBankModalOpen(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleBankSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <input
                type="text"
                inputMode="numeric"
                required
                placeholder="Amount in coins (e.g. 5,000)..."
                value={bankAmountInput}
                onChange={(e) => setBankAmountInput(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: 6,
                  border: '1px solid var(--frame)',
                  background: 'var(--field, rgba(0,0,0,0.15))',
                  color: 'var(--text)',
                  fontSize: 14,
                  fontVariantNumeric: 'tabular-nums',
                }}
              />

              {/* Quick Presets */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[1000, 5000, 25000, 100000].map((amt) => (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => setBankAmountInput(amt.toString())}
                    style={{
                      padding: '4px 8px',
                      borderRadius: 4,
                      border: '1px solid var(--line)',
                      background: 'var(--surface-soft)',
                      color: 'var(--text)',
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    +{amt.toLocaleString()}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  onClick={() => setBankModalOpen(false)}
                  style={{
                    flex: 1,
                    padding: '8px',
                    borderRadius: 6,
                    border: '1px solid var(--frame)',
                    background: 'var(--surface-soft)',
                    color: 'var(--text)',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingBank || !bankAmountInput.trim()}
                  className="btn"
                  style={{
                    flex: 1,
                    padding: '8px',
                    borderRadius: 6,
                    background: 'linear-gradient(var(--primary-top, #38bdf8), var(--primary-bottom, #0284c7))',
                    color: '#ffffff',
                    border: '1px solid var(--primary-edge, #0284c7)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: submittingBank ? 'not-allowed' : 'pointer',
                  }}
                >
                  {submittingBank ? 'Processing…' : bankOp === 'deposit' ? 'Confirm Deposit' : 'Confirm Withdraw'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL: SET DIPLOMATIC RELATION                                       */}
      {/* ==================================================================== */}
      {relationModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
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
              maxWidth: 380,
              background: 'var(--surface)',
              border: '1px solid var(--frame)',
              borderRadius: 10,
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                Set Diplomatic Relation
              </h3>
              <button
                type="button"
                onClick={() => setRelationModalOpen(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSetRelation} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
                  Target Clan Tag
                </label>
                <input
                  type="text"
                  required
                  maxLength={6}
                  placeholder="e.g. OMEGA"
                  value={relationTag}
                  onChange={(e) => setRelationTag(e.target.value.toUpperCase())}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: '1px solid var(--frame)',
                    background: 'var(--field, rgba(0,0,0,0.15))',
                    color: 'var(--text)',
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                />
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
                  Relation Status
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
                  {(['ally', 'truce', 'war', 'neutral'] as const).map((st) => {
                    const isSelected = relationStatus === st
                    return (
                      <button
                        key={st}
                        type="button"
                        onClick={() => {
                          playSound('click')
                          setRelationStatus(st)
                        }}
                        style={{
                          padding: '6px',
                          borderRadius: 6,
                          border: isSelected ? '1px solid var(--primary-edge, #0284c7)' : '1px solid var(--frame)',
                          background: isSelected
                            ? st === 'war'
                              ? '#ef4444'
                              : st === 'ally'
                                ? '#16a34a'
                                : 'linear-gradient(var(--primary-top, #38bdf8), var(--primary-bottom, #0284c7))'
                            : 'var(--surface-soft)',
                          color: isSelected ? '#ffffff' : 'var(--text)',
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: 'pointer',
                          textTransform: 'capitalize',
                        }}
                      >
                        {st}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  onClick={() => setRelationModalOpen(false)}
                  style={{
                    flex: 1,
                    padding: '8px',
                    borderRadius: 6,
                    border: '1px solid var(--frame)',
                    background: 'var(--surface-soft)',
                    color: 'var(--text)',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingRelation || !relationTag.trim()}
                  className="btn"
                  style={{
                    flex: 1,
                    padding: '8px',
                    borderRadius: 6,
                    background: 'linear-gradient(var(--primary-top, #38bdf8), var(--primary-bottom, #0284c7))',
                    color: '#ffffff',
                    border: '1px solid var(--primary-edge, #0284c7)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: submittingRelation ? 'not-allowed' : 'pointer',
                  }}
                >
                  {submittingRelation ? 'Setting…' : 'Save Relation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
