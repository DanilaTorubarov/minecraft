import { useEffect, useRef, useState, useCallback } from 'react'
import woodenPick from '../assets/minefall/wooden_pickaxe.png'
import stonePick from '../assets/minefall/stone_pickaxe.png'
import ironPick from '../assets/minefall/iron_pickaxe.png'
import goldenPick from '../assets/minefall/golden_pickaxe.png'
import diamondPick from '../assets/minefall/diamond_pickaxe.png'
import netheritePick from '../assets/minefall/netherite_pickaxe.png'

import stoneImg from '../assets/minefall/stone.png'
import deepslateImg from '../assets/minefall/deepslate.png'
import obsidianImg from '../assets/minefall/obsidian.png'
import bedrockImg from '../assets/minefall/bedrock.png'
import tntImg from '../assets/minefall/tnt_side.png'
import craftingImg from '../assets/minefall/crafting_table_front.png'
import coalOreImg from '../assets/minefall/coal_ore.png'
import copperOreImg from '../assets/minefall/copper_ore.png'
import ironOreImg from '../assets/minefall/iron_ore.png'
import goldOreImg from '../assets/minefall/gold_ore.png'
import redstoneOreImg from '../assets/minefall/redstone_ore.png'
import lapisOreImg from '../assets/minefall/lapis_ore.png'
import diamondOreImg from '../assets/minefall/diamond_ore.png'
import emeraldOreImg from '../assets/minefall/emerald_ore.png'
import ancientDebrisImg from '../assets/minefall/ancient_debris_side.png'

import PayerSelect from './PayerSelect'
import GameBetControls from './GameBetControls'
import { ApiError, playMinefall } from '../lib/api'
import { invalidateServerData } from '../lib/serverData'
import { useStakedBalance } from '../lib/useMinigames'
import { playSound } from '../lib/sounds'
import {
  clampBet,
  formatCoins,
  formatMultiplier,
  formatReturn,
  minigameFailure,
  newClientId,
  type MinigameRules,
  type Payer,
} from '../lib/minigames'
import {
  PICKAXE_CONFIGS,
  BLOCK_CONFIGS,
  MINEFALL_COLS,
  MINEFALL_ROWS,
  type PickaxeTier,
  type BlockType,
  type MinefallRound,
  type MinefallEvent,
} from '../lib/minefall'

const PICKAXE_TEXTURES: Record<PickaxeTier, string> = {
  wooden: woodenPick,
  stone: stonePick,
  iron: ironPick,
  golden: goldenPick,
  diamond: diamondPick,
  netherite: netheritePick,
}

const BLOCK_TEXTURES: Record<string, string> = {
  stone: stoneImg,
  deepslate: deepslateImg,
  obsidian: obsidianImg,
  bedrock: bedrockImg,
  tnt: tntImg,
  crafting_table: craftingImg,
  coal_ore: coalOreImg,
  copper_ore: copperOreImg,
  iron_ore: ironOreImg,
  gold_ore: goldOreImg,
  redstone_ore: redstoneOreImg,
  lapis_ore: lapisOreImg,
  diamond_ore: diamondOreImg,
  emerald_ore: emeraldOreImg,
  ancient_debris: ancientDebrisImg,
}

type Particle = {
  x: number
  y: number
  vx: number
  vy: number
  color: string
  size: number
  life: number
  maxLife: number
}

type FloatingText = {
  x: number
  y: number
  text: string
  color: string
  life: number
  maxLife: number
}

export default function MinefallGame({
  onBack,
  payer,
  accounts,
  onChoosePayer,
  rules,
}: {
  onBack: () => void
  payer: Payer
  accounts: Payer[]
  onChoosePayer: (uuid: string) => void
  rules: MinigameRules
}) {
  const [pickaxe, setPickaxe] = useState<PickaxeTier>('iron')
  const [column, setColumn] = useState(4)
  const [bet, setBet] = useState(() => clampBet(50, rules.min_bet, rules.max_bet, payer.coins))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [round, setRound] = useState<MinefallRound | null>(null)
  const [history, setHistory] = useState<MinefallRound[]>([])
  const [showTable, setShowTable] = useState(false)

  const [currentDurability, setCurrentDurability] = useState(PICKAXE_CONFIGS.iron.durability)
  const [maxDurability, setMaxDurability] = useState(PICKAXE_CONFIGS.iron.durability)
  const [liveOres, setLiveOres] = useState<Record<string, number>>({})
  const [liveMultiplier, setLiveMultiplier] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameRef = useRef<number | null>(null)
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map())

  const sending = useRef(false)
  const wallet = payer
  const { balance, applySettled } = useStakedBalance(wallet.uuid, wallet.coins)
  const validBet = Number.isSafeInteger(bet) && bet >= rules.min_bet && bet <= rules.max_bet && bet <= balance

  // Preload textures
  useEffect(() => {
    const loaded = new Map<string, HTMLImageElement>()
    const toLoad: Array<[string, string]> = [
      ...Object.entries(PICKAXE_TEXTURES),
      ...Object.entries(BLOCK_TEXTURES),
    ]

    for (const [key, src] of toLoad) {
      const img = new Image()
      img.src = src
      img.onload = () => loaded.set(key, img)
    }
    imagesRef.current = loaded
  }, [])

  // Update pickaxe durability limits when changing pickaxe
  const handlePickaxeChange = (tier: PickaxeTier) => {
    if (busy || isAnimating) return
    setPickaxe(tier)
    setCurrentDurability(PICKAXE_CONFIGS[tier].durability)
    setMaxDurability(PICKAXE_CONFIGS[tier].durability)
  }

  // Draw static preview grid
  const drawPreview = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const cellW = 38
    const cellH = 34
    const totalW = MINEFALL_COLS * cellW
    const totalH = 460
    canvas.width = totalW
    canvas.height = totalH
    ctx.imageSmoothingEnabled = false

    // Dark cave background
    ctx.fillStyle = '#141419'
    ctx.fillRect(0, 0, totalW, totalH)

    // Render stone/ore preview blocks
    for (let r = 0; r < 14; r++) {
      for (let c = 0; c < MINEFALL_COLS; c++) {
        const x = c * cellW
        const y = r * cellH + 50
        let texKey = 'stone'
        if (r > 6) texKey = 'deepslate'
        if ((r + c) % 5 === 0) texKey = 'coal_ore'
        if ((r * 2 + c) % 7 === 0) texKey = 'iron_ore'
        if (r > 8 && (r + c) % 6 === 0) texKey = 'gold_ore'
        if (r === 3 && c === 2) texKey = 'crafting_table'
        if (r === 5 && c === 6) texKey = 'tnt'

        const img = imagesRef.current.get(texKey)
        if (img) {
          ctx.drawImage(img, x, y, cellW, cellH)
        } else {
          ctx.fillStyle = r > 6 ? '#323438' : '#57575b'
          ctx.fillRect(x, y, cellW, cellH)
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.25)'
        ctx.strokeRect(x, y, cellW, cellH)
      }
    }

    // Top indicator arrow for drop column
    const arrowX = column * cellW + cellW / 2
    ctx.fillStyle = '#4ade80'
    ctx.beginPath()
    ctx.moveTo(arrowX - 8, 12)
    ctx.lineTo(arrowX + 8, 12)
    ctx.lineTo(arrowX, 24)
    ctx.closePath()
    ctx.fill()

    // Pickaxe sprite at entry
    const pickImg = imagesRef.current.get(pickaxe)
    if (pickImg) {
      ctx.drawImage(pickImg, arrowX - 16, 22, 32, 32)
    }
  }, [column, pickaxe])

  useEffect(() => {
    if (!isAnimating && !round) {
      drawPreview()
    }
  }, [drawPreview, isAnimating, round])

  // Play animation sequence based on server round events
  const runAnimation = (playRound: MinefallRound) => {
    setIsAnimating(true)
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const cellW = 38
    const cellH = 34
    const totalW = MINEFALL_COLS * cellW
    const totalH = 460
    canvas.width = totalW
    canvas.height = totalH
    ctx.imageSmoothingEnabled = false

    // Clone grid so animation modifies local copy
    const grid: string[][] = playRound.grid.map((row) => [...row])
    const events: MinefallEvent[] = [...playRound.events]

    let pickX = playRound.column * cellW + cellW / 2
    let pickY = 20
    let pickAngle = 0
    let targetX = pickX
    let targetY = pickY
    let targetAngle = 0

    let currentEventIdx = 0
    let eventTimer = 0
    const particles: Particle[] = []
    const floatingTexts: FloatingText[] = []

    let cameraY = 0
    let activeDur = PICKAXE_CONFIGS[playRound.pickaxe].durability
    const maxDur = activeDur
    let activeMult = 0
    const accumulatedOres: Record<string, number> = {}

    setCurrentDurability(activeDur)
    setMaxDurability(maxDur)
    setLiveOres({})
    setLiveMultiplier(0)

    const spawnBlockParticles = (bx: number, by: number, color: string) => {
      for (let i = 0; i < 12; i++) {
        particles.push({
          x: bx + cellW / 2,
          y: by + cellH / 2,
          vx: (Math.random() - 0.5) * 6,
          vy: (Math.random() - 0.5) * 6 - 2,
          color,
          size: Math.random() * 4 + 2,
          life: 0,
          maxLife: 30,
        })
      }
    }

    const spawnExplosion = (bx: number, by: number) => {
      for (let i = 0; i < 35; i++) {
        const angle = Math.random() * Math.PI * 2
        const speed = Math.random() * 8 + 2
        particles.push({
          x: bx + cellW / 2,
          y: by + cellH / 2,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          color: Math.random() > 0.5 ? '#f97316' : '#eab308',
          size: Math.random() * 6 + 3,
          life: 0,
          maxLife: 40,
        })
      }
    }

    const step = () => {
      // Advance physics towards target
      pickX += (targetX - pickX) * 0.25
      pickY += (targetY - pickY) * 0.25
      pickAngle += (targetAngle - pickAngle) * 0.25

      // Camera smoothly follows pickaxe
      const desiredCameraY = Math.max(0, pickY - 180)
      cameraY += (desiredCameraY - cameraY) * 0.15

      eventTimer += 1
      if (eventTimer >= 8 && currentEventIdx < events.length) {
        eventTimer = 0
        const ev = events[currentEventIdx]
        currentEventIdx += 1

        targetX = ev.col * cellW + cellW / 2
        targetY = ev.row * cellH + cellH / 2
        targetAngle += 1.2

        if (ev.type === 'hit') {
          playSound('click')
          activeDur = ev.durabilityLeft
          setCurrentDurability(activeDur)
          spawnBlockParticles(ev.col * cellW, ev.row * cellH, '#78716c')
        } else if (ev.type === 'break') {
          playSound('click')
          grid[ev.row][ev.col] = 'air'
          activeDur = ev.durabilityLeft
          setCurrentDurability(activeDur)
          spawnBlockParticles(ev.col * cellW, ev.row * cellH, '#57534e')
        } else if (ev.type === 'collect_ore') {
          playSound('click')
          grid[ev.row][ev.col] = 'air'
          activeDur = ev.durabilityLeft
          setCurrentDurability(activeDur)
          accumulatedOres[ev.block] = (accumulatedOres[ev.block] ?? 0) + 1
          setLiveOres({ ...accumulatedOres })
          const boost = ev.boostX100 ?? 0
          activeMult += boost
          setLiveMultiplier(activeMult)
          spawnBlockParticles(ev.col * cellW, ev.row * cellH, '#38bdf8')
          floatingTexts.push({
            x: targetX,
            y: targetY - 10,
            text: `+${(boost / 100).toFixed(2)}x`,
            color: '#38bdf8',
            life: 0,
            maxLife: 45,
          })
        } else if (ev.type === 'repair') {
          playSound('done')
          grid[ev.row][ev.col] = 'air'
          activeDur = ev.durabilityLeft
          setCurrentDurability(activeDur)
          floatingTexts.push({
            x: targetX,
            y: targetY - 10,
            text: '+3 Durability!',
            color: '#4ade80',
            life: 0,
            maxLife: 45,
          })
        } else if (ev.type === 'tnt_blast') {
          playSound('close')
          grid[ev.row][ev.col] = 'air'
          spawnExplosion(ev.col * cellW, ev.row * cellH)
          if (ev.affected) {
            for (const aff of ev.affected) {
              grid[aff.row][aff.col] = 'air'
              if (aff.isOre) {
                accumulatedOres[aff.block] = (accumulatedOres[aff.block] ?? 0) + 1
                const boost = aff.boostX100 ?? 0
                activeMult += boost
                setLiveMultiplier(activeMult)
                floatingTexts.push({
                  x: aff.col * cellW + cellW / 2,
                  y: aff.row * cellH,
                  text: `+${(boost / 100).toFixed(2)}x`,
                  color: '#fbbf24',
                  life: 0,
                  maxLife: 45,
                })
              }
            }
            setLiveOres({ ...accumulatedOres })
          }
        } else if (ev.type === 'pickaxe_break') {
          playSound('close')
          activeDur = 0
          setCurrentDurability(0)
          spawnBlockParticles(targetX, targetY, '#ef4444')
          floatingTexts.push({
            x: targetX,
            y: targetY - 20,
            text: 'Tool Broken!',
            color: '#ef4444',
            life: 0,
            maxLife: 60,
          })
        }
      }

      // Render frame
      ctx.fillStyle = '#141419'
      ctx.fillRect(0, 0, totalW, totalH)

      ctx.save()
      ctx.translate(0, -cameraY)

      // Draw visible blocks
      for (let r = 0; r < MINEFALL_ROWS; r++) {
        for (let c = 0; c < MINEFALL_COLS; c++) {
          const blockType = grid[r][c]
          if (blockType === 'air') continue
          const bx = c * cellW
          const by = r * cellH
          if (by + cellH < cameraY - 40 || by > cameraY + totalH + 40) continue

          const img = imagesRef.current.get(blockType)
          if (img) {
            ctx.drawImage(img, bx, by, cellW, cellH)
          } else {
            ctx.fillStyle = blockType === 'bedrock' ? '#1c1917' : '#57534e'
            ctx.fillRect(bx, by, cellW, cellH)
          }
          ctx.strokeStyle = 'rgba(0,0,0,0.2)'
          ctx.strokeRect(bx, by, cellW, cellH)
        }
      }

      // Draw particles
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]
        p.x += p.vx
        p.y += p.vy
        p.vy += 0.2
        p.life += 1
        if (p.life >= p.maxLife) {
          particles.splice(i, 1)
          continue
        }
        ctx.fillStyle = p.color
        ctx.fillRect(p.x, p.y, p.size, p.size)
      }

      // Draw floating texts
      for (let i = floatingTexts.length - 1; i >= 0; i--) {
        const ft = floatingTexts[i]
        ft.y -= 0.8
        ft.life += 1
        if (ft.life >= ft.maxLife) {
          floatingTexts.splice(i, 1)
          continue
        }
        ctx.font = 'bold 13px sans-serif'
        ctx.fillStyle = ft.color
        ctx.textAlign = 'center'
        ctx.fillText(ft.text, ft.x, ft.y)
      }

      // Draw falling pickaxe if not fully broken
      if (activeDur > 0 || currentEventIdx < events.length) {
        ctx.save()
        ctx.translate(pickX, pickY)
        ctx.rotate(pickAngle)
        const pickImg = imagesRef.current.get(playRound.pickaxe)
        if (pickImg) {
          ctx.drawImage(pickImg, -16, -16, 32, 32)
        }
        ctx.restore()
      }

      ctx.restore()

      // Continue animation loop until all events completed and settled
      if (currentEventIdx < events.length || particles.length > 0 || floatingTexts.length > 0) {
        animFrameRef.current = requestAnimationFrame(step)
      } else {
        setIsAnimating(false)
        setRound(playRound)
        playSound(playRound.payout > 0 ? 'done' : 'close')
      }
    }

    animFrameRef.current = requestAnimationFrame(step)
  }

  // Cancel animation on unmount
  useEffect(() => {
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    }
  }, [])

  const handleDrop = async () => {
    if (sending.current || isAnimating) return
    sending.current = true
    setBusy(true)
    setError('')
    setRound(null)

    try {
      const clientId = newClientId()
      const playRound = await playMinefall({
        uuid: payer.uuid,
        bet,
        pickaxe,
        column,
        client_id: clientId,
        economy_level: rules.economy.level,
      })

      applySettled(playRound.balance, payer.uuid, payer.coins)
      invalidateServerData('stats')
      setHistory((old) => [playRound, ...old.filter((e) => e.round_id !== playRound.round_id)].slice(0, 5))

      runAnimation(playRound)
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 412) {
        window.dispatchEvent(new Event('economy-policy-changed'))
      }
      setError(minigameFailure(failure instanceof ApiError ? failure.status : 0).message)
      invalidateServerData('stats')
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  const selectedConfig = PICKAXE_CONFIGS[pickaxe]
  const durPercent = Math.max(0, Math.min(100, Math.round((currentDurability / maxDurability) * 100)))

  return (
    <div className="minigame-workspace">
      <div className="game-heading">
        <img src={PICKAXE_TEXTURES[pickaxe]} alt="" />
        <div>
          <button className="btn btn-ghost" onClick={onBack} disabled={isAnimating || busy}>
            ← All minigames
          </button>
          <h1>Minefall</h1>
          <p className="page-sub">Drop a physical pickaxe into the mine. Smash rock, trigger TNT, and reap valuable ores!</p>
        </div>
      </div>

      <PayerSelect payer={payer} accounts={accounts} onChoose={onChoosePayer} disabled={isAnimating || busy} />

      {error ? (
        <div className="note" data-tone="error" role="alert">
          <p>{error}</p>
        </div>
      ) : null}

      <div className="game-layout">
        {/* Main interactive mining stage */}
        <section className="minefall-stage-wrapper">
          <div className="minefall-hud">
            <div className="minefall-durability-meter">
              <span className="muted">Durability:</span>
              <div className="minefall-durability-bar">
                <div
                  className="minefall-durability-fill"
                  style={{
                    width: `${durPercent}%`,
                    backgroundColor: durPercent > 50 ? '#22c55e' : durPercent > 20 ? '#eab308' : '#ef4444',
                  }}
                />
              </div>
              <strong>
                {currentDurability} / {maxDurability}
              </strong>
            </div>

            <div className="minefall-live-stats">
              <span className="muted">Running Boost:</span>
              <strong className="minefall-boost-tag">
                {liveMultiplier > 0 ? `+${(liveMultiplier / 100).toFixed(2)}x` : '+0.00x'}
              </strong>
            </div>
          </div>

          {/* Interactive column picker */}
          <div className="minefall-column-selector" aria-label="Drop column selector">
            {Array.from({ length: MINEFALL_COLS }, (_, i) => (
              <button
                key={i}
                type="button"
                className={`minefall-col-btn ${column === i ? 'selected' : ''}`}
                onClick={() => !isAnimating && !busy && setColumn(i)}
                disabled={isAnimating || busy}
                title={`Drop at column ${i + 1}`}
              >
                {column === i ? '▼' : i + 1}
              </button>
            ))}
          </div>

          <div className="minefall-canvas-container">
            <canvas ref={canvasRef} className="minefall-canvas" />

            {/* Settled Round Result Overlay */}
            {round && !isAnimating ? (
              <div className="minefall-result-overlay">
                <div className="minefall-result-card">
                  <h2>{round.payout > 0 ? 'Vein Extracted!' : 'Pickaxe Shattered!'}</h2>
                  <p className="page-sub">
                    {round.payout > 0
                      ? `Yield multiplier: ${formatMultiplier(round.multiplier_x100)}`
                      : 'No ores recovered before tool failure.'}
                  </p>

                  <div className="minefall-result-payout">
                    <span>Payout:</span>
                    <strong className={round.payout > 0 ? 'win-text' : 'loss-text'}>
                      {formatCoins(round.payout)} coins
                    </strong>
                  </div>

                  {Object.keys(round.ores_collected).length > 0 ? (
                    <div className="minefall-ores-summary">
                      <p className="muted">Ores mined:</p>
                      <div className="minefall-ores-chips">
                        {Object.entries(round.ores_collected).map(([ore, count]) => (
                          <span key={ore} className="minefall-ore-chip">
                            <img src={BLOCK_TEXTURES[ore] || stoneImg} alt="" />
                            {count}x {BLOCK_CONFIGS[ore as BlockType]?.name ?? ore}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <button className="btn btn-primary" onClick={handleDrop} disabled={!validBet || busy}>
                    Drop Again ({formatCoins(bet)} coins)
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        {/* Side control panel */}
        <aside className="game-options">
          {/* Pickaxe Selection */}
          <div className="card-glass">
            <h3 className="section-title">Select Pickaxe</h3>
            <div className="minefall-pickaxe-grid">
              {(Object.keys(PICKAXE_CONFIGS) as PickaxeTier[]).map((tier) => {
                const cfg = PICKAXE_CONFIGS[tier]
                const active = pickaxe === tier
                return (
                  <button
                    key={tier}
                    type="button"
                    className={`minefall-pick-card ${active ? 'active' : ''}`}
                    onClick={() => handlePickaxeChange(tier)}
                    disabled={isAnimating || busy}
                  >
                    <img src={PICKAXE_TEXTURES[tier]} alt={cfg.name} />
                    <div>
                      <strong>{cfg.name}</strong>
                      <span className="muted">{cfg.durability} Durability</span>
                      {cfg.oreBonus > 1 ? <span className="badge-gold">2x Midas Ore!</span> : null}
                    </div>
                  </button>
                )
              })}
            </div>
            <p className="subtext">{selectedConfig.description}</p>
          </div>

          {/* Bet controls */}
          <GameBetControls
            bet={bet}
            minBet={rules.min_bet}
            maxBet={rules.max_bet}
            balance={balance}
            disabled={isAnimating || busy}
            onSetBet={setBet}
          />

          <button
            className="btn btn-primary btn-large btn-block"
            disabled={!validBet || isAnimating || busy}
            onClick={handleDrop}
          >
            {isAnimating ? 'Mining...' : `Drop Pickaxe (${formatCoins(bet)} coins)`}
          </button>

          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowTable((prev) => !prev)}
          >
            {showTable ? 'Hide Paytable' : 'View Ore Paytable & Rules'}
          </button>

          {showTable ? (
            <div className="card-glass text-sm">
              <h4>Ore Multipliers</h4>
              <ul className="minefall-paytable-list">
                <li><strong>Coal Ore:</strong> +0.05x</li>
                <li><strong>Copper Ore:</strong> +0.08x</li>
                <li><strong>Iron Ore:</strong> +0.15x</li>
                <li><strong>Gold Ore:</strong> +0.30x</li>
                <li><strong>Redstone Ore:</strong> +0.20x</li>
                <li><strong>Lapis Ore:</strong> +0.25x</li>
                <li><strong>Diamond Ore:</strong> +0.60x</li>
                <li><strong>Emerald Ore:</strong> +1.00x</li>
                <li><strong>Ancient Debris:</strong> +2.00x</li>
              </ul>
              <h4>Special Blocks</h4>
              <p><strong>TNT:</strong> Detonates in a 3×3 radius, harvesting all caught ores without costing tool durability!</p>
              <p><strong>Crafting Table:</strong> Repairs tool for +3 durability!</p>
              <p className="muted">Expected Return: {formatReturn(rules.minefall.rtp_x10000)}</p>
            </div>
          ) : null}

          {history.length > 0 ? (
            <div className="card-glass">
              <h4 className="section-title">Recent Plunges</h4>
              <ul className="minefall-history-list">
                {history.map((h) => (
                  <li key={h.round_id}>
                    <span>{PICKAXE_CONFIGS[h.pickaxe]?.name}:</span>
                    <strong className={h.payout > 0 ? 'win-text' : 'loss-text'}>
                      {h.payout > 0 ? `+${formatCoins(h.payout)}` : '0 coins'} ({formatMultiplier(h.multiplier_x100)})
                    </strong>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  )
}

