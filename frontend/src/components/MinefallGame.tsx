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
  const [speed, setSpeed] = useState<'1x' | '2x'>('1x')
  const speedRef = useRef<'1x' | '2x'>('1x')
  const skipAnimRef = useRef(false)
  const [texturesLoaded, setTexturesLoaded] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameRef = useRef<number | null>(null)
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map())

  const sending = useRef(false)
  const wallet = payer
  const { balance, applySettled } = useStakedBalance(wallet.uuid, wallet.coins)
  const validBet = Number.isSafeInteger(bet) && bet >= rules.min_bet && bet <= rules.max_bet && bet <= balance

  // Preload textures and trigger initial preview once ready
  useEffect(() => {
    const loaded = new Map<string, HTMLImageElement>()
    const toLoad: Array<[string, string]> = [
      ...Object.entries(PICKAXE_TEXTURES),
      ...Object.entries(BLOCK_TEXTURES),
    ]

    let count = 0
    const total = toLoad.length
    const onLoaded = () => {
      count += 1
      if (count >= total) {
        imagesRef.current = loaded
        setTexturesLoaded(true)
      }
    }

    for (const [key, src] of toLoad) {
      const img = new Image()
      img.src = src
      img.onload = () => {
        loaded.set(key, img)
        onLoaded()
      }
      img.onerror = () => {
        onLoaded()
      }
      if (img.complete) {
        loaded.set(key, img)
        onLoaded()
      }
    }
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
  }, [column, pickaxe, texturesLoaded])

  useEffect(() => {
    if (!isAnimating && !round) {
      drawPreview()
    }
  }, [drawPreview, isAnimating, round, texturesLoaded])

  // Play animation sequence with real 2D bouncing physics
  const runAnimation = (playRound: MinefallRound) => {
    skipAnimRef.current = false
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

    const grid: string[][] = playRound.grid.map((row) => [...row])
    const events: MinefallEvent[] = [...playRound.events]

    // 2D Physics Body for Pickaxe
    let pickX = playRound.column * cellW + cellW / 2
    let pickY = 15
    let vx = (Math.random() - 0.5) * 2.0
    let vy = 1.8
    let angle = 0
    let angularVel = 0.08
    let cameraShake = 0
    let cameraY = 0

    let currentEventIdx = 0
    let isRecoiling = false

    // Active stats
    let activeDur = PICKAXE_CONFIGS[playRound.pickaxe].durability
    const maxDur = activeDur
    let activeMult = 0
    const accumulatedOres: Record<string, number> = {}

    setCurrentDurability(activeDur)
    setMaxDurability(maxDur)
    setLiveOres({})
    setLiveMultiplier(0)

    const particles: Particle[] = []
    const floatingTexts: FloatingText[] = []

    type ToolFragment = {
      x: number
      y: number
      vx: number
      vy: number
      angle: number
      spin: number
      size: number
      life: number
      maxLife: number
    }
    const fragments: ToolFragment[] = []

    const spawnBlockParticles = (bx: number, by: number, color: string, count = 14) => {
      for (let i = 0; i < count; i++) {
        particles.push({
          x: bx + cellW / 2,
          y: by + cellH / 2,
          vx: (Math.random() - 0.5) * 8,
          vy: (Math.random() - 0.5) * 7 - 2.5,
          color,
          size: Math.random() * 4 + 2,
          life: 0,
          maxLife: 32,
        })
      }
    }

    const spawnExplosion = (bx: number, by: number) => {
      for (let i = 0; i < 45; i++) {
        const a = Math.random() * Math.PI * 2
        const spd = Math.random() * 10 + 2
        particles.push({
          x: bx + cellW / 2,
          y: by + cellH / 2,
          vx: Math.cos(a) * spd,
          vy: Math.sin(a) * spd,
          color: Math.random() > 0.4 ? (Math.random() > 0.5 ? '#f97316' : '#eab308') : '#ef4444',
          size: Math.random() * 6 + 3,
          life: 0,
          maxLife: 42,
        })
      }
    }

    const spawnToolFragments = (fx: number, fy: number) => {
      for (let i = 0; i < 8; i++) {
        fragments.push({
          x: fx,
          y: fy,
          vx: (Math.random() - 0.5) * 8.0,
          vy: -Math.random() * 7.0 - 2.0,
          angle: Math.random() * Math.PI * 2,
          spin: (Math.random() - 0.5) * 0.4,
          size: Math.random() * 8 + 6,
          life: 0,
          maxLife: 60,
        })
      }
    }

    const step = () => {
      // Instant skip requested
      if (skipAnimRef.current) {
        setIsAnimating(false)
        setRound(playRound)
        setCurrentDurability(0)
        setLiveMultiplier(playRound.multiplier_x100)
        setLiveOres({ ...playRound.ores_collected })
        playSound(playRound.payout > 0 ? 'done' : 'close')
        return
      }

      const speedFactor = speedRef.current === '2x' ? 1.6 : 1.0

      // Physics integration (gravity + rotational tumble)
      const gravity = 0.40 * speedFactor
      vy = Math.min(vy + gravity, 11.0 * speedFactor)
      angle += angularVel * speedFactor

      // When pickaxe passes the apex of an upward recoil arc, switch to falling
      if (isRecoiling && vy >= 0) {
        isRecoiling = false
      }

      if (currentEventIdx < events.length) {
        const ev = events[currentEventIdx]
        const targetX = ev.col * cellW + cellW / 2
        const targetY = ev.row * cellH + 50 + cellH / 2

        if (!isRecoiling) {
          // Guided horizontal flight towards target block column
          const dx = targetX - pickX
          vx += Math.sign(dx) * Math.min(Math.abs(dx) * 0.12, 0.8) * speedFactor
          vx *= Math.pow(0.86, speedFactor)
        } else {
          vx *= Math.pow(0.97, speedFactor)
        }

        pickX += vx * speedFactor
        pickY += vy * speedFactor

        // Wall bounce physics (left & right mine shaft rock walls)
        const wallMargin = 14
        if (pickX < wallMargin) {
          pickX = wallMargin
          vx = Math.abs(vx) * 0.75 + 1.2
          angularVel = Math.random() * 0.3 + 0.15
          cameraShake = Math.max(cameraShake, 1.8)
          spawnBlockParticles(0, pickY, '#94a3b8', 6)
          playSound('click')
        } else if (pickX > totalW - wallMargin) {
          pickX = totalW - wallMargin
          vx = -Math.abs(vx) * 0.75 - 1.2
          angularVel = -Math.random() * 0.3 - 0.15
          cameraShake = Math.max(cameraShake, 1.8)
          spawnBlockParticles(totalW - 16, pickY, '#94a3b8', 6)
          playSound('click')
        }

        // IMPACT TRIGGER:
        // Guaranteed collision: when falling pickaxe reaches or crosses the target block
        const hasReachedTarget = !isRecoiling && (pickY >= targetY - 4 || targetY <= pickY)

        if (hasReachedTarget) {
          pickX = targetX
          pickY = targetY
          activeDur = ev.durabilityLeft
          setCurrentDurability(activeDur)

          if (ev.type === 'hit') {
            playSound('click')
            cameraShake = 3.0
            spawnBlockParticles(ev.col * cellW, ev.row * cellH + 50, '#78716c', 16)
            // Hard rock rebound: bounces upwards and kicks sideways!
            vy = -4.8 * speedFactor
            vx = (Math.random() > 0.5 ? 1 : -1) * (Math.random() * 2.5 + 1.5)
            angularVel = (Math.random() > 0.5 ? 1 : -1) * (Math.random() * 0.3 + 0.2)
            isRecoiling = true
          } else if (ev.type === 'break') {
            playSound('click')
            cameraShake = 2.4
            grid[ev.row][ev.col] = 'air'
            spawnBlockParticles(ev.col * cellW, ev.row * cellH + 50, '#57534e', 14)
            // Stone break: punchy bounce
            vy = -2.6 * speedFactor
            vx = (Math.random() - 0.5) * 3.0
            angularVel = (Math.random() - 0.5) * 0.3
            isRecoiling = true
          } else if (ev.type === 'collect_ore') {
            playSound('click')
            cameraShake = 3.2
            grid[ev.row][ev.col] = 'air'
            accumulatedOres[ev.block] = (accumulatedOres[ev.block] ?? 0) + 1
            setLiveOres({ ...accumulatedOres })
            const boost = ev.boostX100 ?? 0
            activeMult += boost
            setLiveMultiplier(activeMult)
            spawnBlockParticles(ev.col * cellW, ev.row * cellH + 50, '#38bdf8', 18)
            floatingTexts.push({
              x: targetX,
              y: targetY - 10,
              text: `+${(boost / 100).toFixed(2)}x`,
              color: '#38bdf8',
              life: 0,
              maxLife: 50,
            })
            // Ore deflection bounce
            vy = -3.2 * speedFactor
            vx = (Math.random() - 0.5) * 4.0
            angularVel = (Math.random() - 0.5) * 0.35
            isRecoiling = true
          } else if (ev.type === 'repair') {
            playSound('done')
            cameraShake = 1.8
            grid[ev.row][ev.col] = 'air'
            spawnBlockParticles(ev.col * cellW, ev.row * cellH + 50, '#4ade80', 16)
            floatingTexts.push({
              x: targetX,
              y: targetY - 10,
              text: '+2 Durability!',
              color: '#4ade80',
              life: 0,
              maxLife: 50,
            })
            vy = -3.0 * speedFactor
            vx = (Math.random() - 0.5) * 2.0
            angularVel = 0.25
            isRecoiling = true
          } else if (ev.type === 'tnt_blast') {
            playSound('close')
            cameraShake = 8.0
            grid[ev.row][ev.col] = 'air'
            spawnExplosion(ev.col * cellW, ev.row * cellH + 50)
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
                    y: aff.row * cellH + 50,
                    text: `+${(boost / 100).toFixed(2)}x`,
                    color: '#fbbf24',
                    life: 0,
                    maxLife: 50,
                  })
                }
              }
              setLiveOres({ ...accumulatedOres })
            }
            // Massive explosive launch upwards!
            vy = -8.5 * speedFactor
            vx = (Math.random() - 0.5) * 7.0
            angularVel = (Math.random() - 0.5) * 0.6
            isRecoiling = true
          } else if (ev.type === 'reach_bottom') {
            playSound('click')
            cameraShake = 4.0
            spawnBlockParticles(ev.col * cellW, ev.row * cellH + 50, '#e2e8f0', 16)
            vy = -3.0 * speedFactor
            isRecoiling = true
          } else if (ev.type === 'pickaxe_break') {
            playSound('close')
            cameraShake = 5.0
            activeDur = 0
            setCurrentDurability(0)
            spawnToolFragments(pickX, pickY)
            floatingTexts.push({
              x: targetX,
              y: targetY - 20,
              text: 'Tool Broken!',
              color: '#ef4444',
              life: 0,
              maxLife: 65,
            })
            vx = 0
            vy = 0
            isRecoiling = false
          }

          currentEventIdx += 1
        }
      } else {
        // All events completed: settle tool motion
        pickX += vx * speedFactor
        pickY += vy * speedFactor
        vx *= 0.88
        vy = Math.min(vy + gravity, 4.0)
      }

      // Smooth camera follows pickaxe
      const maxCameraY = Math.max(0, MINEFALL_ROWS * cellH + 50 - totalH + 40)
      const desiredCameraY = Math.min(Math.max(0, pickY - 180), maxCameraY)
      cameraY += (desiredCameraY - cameraY) * 0.12 * speedFactor

      // Camera shake decay
      if (cameraShake > 0) {
        cameraShake *= 0.85
        if (cameraShake < 0.2) cameraShake = 0
      }

      // Render frame
      ctx.fillStyle = '#141419'
      ctx.fillRect(0, 0, totalW, totalH)

      ctx.save()
      const shakeX = (Math.random() - 0.5) * cameraShake
      const shakeY = (Math.random() - 0.5) * cameraShake
      ctx.translate(shakeX, -cameraY + shakeY)

      // Draw visible blocks across all rows
      for (let r = 0; r < MINEFALL_ROWS; r++) {
        for (let c = 0; c < MINEFALL_COLS; c++) {
          const blockType = grid[r][c]
          if (blockType === 'air') continue
          const bx = c * cellW
          const by = r * cellH + 50
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

      // Draw and update particles
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]
        p.x += p.vx
        p.y += p.vy
        p.vy += 0.22
        p.life += 1
        if (p.life >= p.maxLife) {
          particles.splice(i, 1)
          continue
        }
        ctx.fillStyle = p.color
        ctx.fillRect(p.x, p.y, p.size, p.size)
      }

      // Draw and update tool fragments (if tool shattered)
      for (let i = fragments.length - 1; i >= 0; i--) {
        const f = fragments[i]
        f.x += f.vx
        f.y += f.vy
        f.vy += 0.35
        f.angle += f.spin
        f.life += 1
        if (f.life >= f.maxLife) {
          fragments.splice(i, 1)
          continue
        }
        ctx.save()
        ctx.translate(f.x, f.y)
        ctx.rotate(f.angle)
        ctx.fillStyle = '#ef4444'
        ctx.fillRect(-f.size / 2, -f.size / 2, f.size, f.size)
        ctx.restore()
      }

      // Draw and update floating texts
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

      // Draw pickaxe sprite if still intact
      if (activeDur > 0) {
        ctx.save()
        ctx.translate(pickX, pickY)
        ctx.rotate(angle)
        const pickImg = imagesRef.current.get(playRound.pickaxe)
        if (pickImg) {
          ctx.drawImage(pickImg, -16, -16, 32, 32)
        }
        ctx.restore()
      }

      ctx.restore()

      // Continue animation loop until all events completed and settled
      if (currentEventIdx < events.length || particles.length > 0 || floatingTexts.length > 0 || fragments.length > 0) {
        animFrameRef.current = requestAnimationFrame(step)
      } else {
        setIsAnimating(false)
        setRound(playRound)
        playSound(playRound.payout > 0 ? 'done' : 'close')
      }
    }

    animFrameRef.current = requestAnimationFrame(step)
  }

    const toggleSpeed = () => {
    setSpeed((prev) => {
      const next = prev === '1x' ? '2x' : '1x'
      speedRef.current = next
      return next
    })
  }

  const handleSkip = () => {
    skipAnimRef.current = true
  }

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
              {Object.keys(liveOres).length > 0 ? (
                <div className="minefall-live-ores-bar">
                  {Object.entries(liveOres).map(([ore, count]) => (
                    <span key={ore} className="minefall-ore-chip">
                      <img src={BLOCK_TEXTURES[ore] || stoneImg} alt="" />
                      {count}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="minefall-hud-controls">
              <button
                type="button"
                className="btn btn-sm minefall-speed-btn"
                onClick={toggleSpeed}
                title="Toggle animation playback speed"
              >
                Speed: {speed}
              </button>
              {isAnimating ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary minefall-skip-btn"
                  onClick={handleSkip}
                  title="Skip animation and reveal result immediately"
                >
                  Skip ⏭
                </button>
              ) : null}
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
            id="minefall-bet"
            bet={bet}
            balance={balance}
            rules={rules}
            disabled={isAnimating || busy}
            onChange={setBet}
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

