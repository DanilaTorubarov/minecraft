interface Props {
  status: 'in_game' | 'sleeping' | 'online_web' | 'offline' | string
  label?: string
  ping?: number | null
  world?: string | null
  compact?: boolean
}

export default function StatusBadge({ status, label, ping, world, compact }: Props) {
  let defaultLabel = 'Offline'
  let dotColor = '#94a3b8'
  let bg = 'rgba(148, 163, 184, 0.12)'
  let border = 'rgba(148, 163, 184, 0.28)'
  let textColor = 'var(--muted)'

  if (status === 'in_game') {
    defaultLabel = 'In Game'
    dotColor = '#22c55e'
    bg = 'rgba(34, 197, 94, 0.14)'
    border = 'rgba(34, 197, 94, 0.35)'
    textColor = '#16a34a'
  } else if (status === 'sleeping') {
    defaultLabel = 'Sleeping in Bed'
    dotColor = '#a855f7'
    bg = 'rgba(168, 85, 247, 0.14)'
    border = 'rgba(168, 85, 247, 0.35)'
    textColor = '#9333ea'
  } else if (status === 'online_web') {
    defaultLabel = 'Online on Web'
    dotColor = '#0284c7'
    bg = 'rgba(2, 132, 199, 0.14)'
    border = 'rgba(2, 132, 199, 0.35)'
    textColor = '#0284c7'
  }

  const displayLabel = label || defaultLabel

  return (
    <span
      className={`status-badge status-badge-${status}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: compact ? '2px 7px' : '3px 10px',
        borderRadius: 14,
        background: bg,
        border: `1px solid ${border}`,
        color: textColor,
        fontSize: compact ? 11 : 12,
        fontWeight: 600,
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
      }}
      title={world ? `${displayLabel} in ${world}${ping != null ? ` (${ping}ms)` : ''}` : displayLabel}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          backgroundColor: dotColor,
          boxShadow: status === 'in_game' ? `0 0 6px ${dotColor}` : undefined,
          flexShrink: 0,
        }}
        aria-hidden="true"
      />
      <span>{displayLabel}</span>
      {!compact && ping != null && ping > 0 && (
        <span style={{ opacity: 0.75, fontSize: 10, fontWeight: 500 }}>
          {ping}ms
        </span>
      )}
    </span>
  )
}
