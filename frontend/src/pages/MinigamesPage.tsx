import { useState } from 'react'
import minigamesIcon from '../assets/icons/minigames-gamepad.png'
import luckyChestIcon from '../assets/icons/game-lucky-chest.png'
import minesIcon from '../assets/icons/game-minesweeper.png'
import LuckyChestGame from '../components/LuckyChestGame'
import MinesweeperGame from '../components/MinesweeperGame'
import PayerSelect from '../components/PayerSelect'
import { useAuth } from '../lib/auth-context'
import { useStatistics } from '../lib/useStatistics'
import { useMinigameRules, usePayer } from '../lib/useMinigames'
import { formatReturn, type Payer } from '../lib/minigames'

type Props = {
  onGoToAccount?: () => void
}

type Minigame = {
  id: 'chest' | 'minesweeper'
  name: string
  nameRu: string
  description: string
  icon: string
  tag: string
  ready?: boolean
}

const MINIGAMES: Minigame[] = [
  {
    id: 'chest',
    name: 'Lucky Chest',
    nameRu: 'Сундук удачи',
    description:
      'Таинственный сундук сокровищ. Крутите морские сокровища в водных пузырьках и ловите алмазный джекпот! Ставка и выплата идут на баланс Minecraft.',
    icon: luckyChestIcon,
    tag: 'Treasure Box',
    ready: true,
  },
  {
    id: 'minesweeper',
    name: 'Minesweeper',
    nameRu: 'Сапёр',
    description:
      'Шахтёрское минное поле Minecraft. Открывайте безопасные блоки, находите железо, золото и алмазы, повышайте множитель ставки и остерегайтесь скрытого динамита!',
    icon: minesIcon,
    tag: 'Mines & Ore',
    ready: true,
  },
]

export default function MinigamesPage({ onGoToAccount }: Props) {
  const { user, ready } = useAuth()
  const { stats, loadError, retry: retryStats } = useStatistics(user?.id)
  const { rules, error: rulesError, retry: retryRules } = useMinigameRules()
  const accounts = stats?.accounts ?? []
  const { payer: chosenPayer, choose } = usePayer(accounts)
  const [activeGame, setActiveGame] = useState<'chest' | 'minesweeper' | null>(null)

  // Nothing here is free play any more: every stake is real coins on a Minecraft
  // UUID, so the window asks for a login and a linked account before it deals.
  if (!ready) {
    return <p className="loading">Загрузка…</p>
  }

  if (user === null) {
    return (
      <div className="casino-page">
        <div className="page-head casino-head">
          <div className="casino-title-row">
            <img className="casino-header-icon" src={minigamesIcon} alt="" />
            <div>
              <h1>Мини-игры</h1>
              <p className="page-sub">Играйте на монеты Minecraft. Для этого нужен вход и привязанный аккаунт.</p>
            </div>
          </div>
        </div>
        <div className="note">
          <p>Войдите в панель, чтобы играть на монеты своего аккаунта Minecraft.</p>
          <button type="button" className="btn" onClick={onGoToAccount}>
            Войти
          </button>
        </div>
      </div>
    )
  }

  if (loadError !== '' && stats === null) {
    return (
      <div className="casino-page">
        <div className="note" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn" onClick={retryStats}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (stats === null) {
    return <p className="loading">Загружаем баланс…</p>
  }

  if (accounts.length === 0) {
    return (
      <div className="casino-page">
        <div className="page-head casino-head">
          <div className="casino-title-row">
            <img className="casino-header-icon" src={minigamesIcon} alt="" />
            <div>
              <h1>Мини-игры</h1>
              <p className="page-sub">Ставки списываются с баланса Minecraft-аккаунта.</p>
            </div>
          </div>
        </div>
        <div className="note">
          <p>
            Нет привязанного аккаунта Minecraft. Привяжите его — и монеты, заработанные в игре, станут ставкой здесь.
            Проверить баланс в игре можно командой <span className="chest-inline-cmd">/bal</span>.
          </p>
          <button type="button" className="btn" onClick={onGoToAccount}>
            Link an account
          </button>
        </div>
      </div>
    )
  }

  if (rules === null) {
    return rulesError === '' ? (
      <p className="loading">Загружаем правила…</p>
    ) : (
      <div className="casino-page">
        <div className="note" role="alert">
          <p>{rulesError}</p>
          <button type="button" className="btn" onClick={retryRules}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (chosenPayer === null) {
    return <p className="loading">Загружаем баланс…</p>
  }

  // Only the fields the window needs: a balance, never a whole statistics row.
  const payer: Payer = { uuid: chosenPayer.uuid, username: chosenPayer.username, coins: chosenPayer.coins }
  const payers: Payer[] = accounts.map((account) => ({
    uuid: account.uuid,
    username: account.username,
    coins: account.coins,
  }))

  if (activeGame === 'chest') {
    return (
      <LuckyChestGame
        onBack={() => setActiveGame(null)}
        payer={payer}
        accounts={payers}
        onChoosePayer={choose}
        rules={rules}
      />
    )
  }
  if (activeGame === 'minesweeper') {
    return (
      <MinesweeperGame
        onBack={() => setActiveGame(null)}
        payer={payer}
        accounts={payers}
        onChoosePayer={choose}
        rules={rules}
      />
    )
  }

  return (
    <div className="casino-page">
      {/* --- Page Header with Description --- */}
      <div className="page-head casino-head">
        <div className="casino-title-row">
          <img className="casino-header-icon" src={minigamesIcon} alt="" />
          <div>
            <h1>Мини-игры</h1>
            <p className="page-sub">
              Добро пожаловать в игровой раздел! Ставки и выигрыши — это монеты Minecraft: то же число, что показывает{' '}
              <span className="chest-inline-cmd">/bal</span> в игре. Возврат около{' '}
              {formatReturn(rules.chest.rtp_x10000)}.
            </p>
          </div>
        </div>
        <PayerSelect payer={payer} accounts={payers} onChoose={choose} />
      </div>

      {/* --- Available Games (Slots & Minesweeper) --- */}
      <section className="section casino-section" aria-labelledby="casino-games-heading">
        <div className="section-head">
          <h2 id="casino-games-heading">Доступные игры</h2>
          <span className="casino-section-hint">Выберите игру для запуска</span>
        </div>

        <div className="casino-dual-grid">
          {MINIGAMES.map((game) => (
            <div key={game.id} className="casino-aero-card" tabIndex={0}>
              <div className="casino-card-specular" aria-hidden="true" />

              <div className="casino-card-main">
                <div className="casino-game-icon-orb">
                  <div className="casino-orb-highlight" aria-hidden="true" />
                  <img src={game.icon} alt="" className="casino-game-icon-img" />
                </div>

                <div className="casino-game-details">
                  <div className="casino-card-meta">
                    <span className="casino-tag">{game.tag}</span>
                    <span className={`casino-dev-badge ${game.ready ? 'casino-badge-ready' : ''}`}>
                      {game.ready ? 'Доступно' : 'В разработке'}
                    </span>
                  </div>
                  <h3>{game.nameRu}</h3>
                  <span className="casino-subtitle-en">{game.name}</span>
                  <p className="casino-game-desc">{game.description}</p>
                </div>
              </div>

              <div className="casino-card-actions">
                {!game.ready && <span className="casino-dev-note">Разработка логики</span>}
                {game.ready ? (
                  <button
                    type="button"
                    className="btn btn-primary casino-play-btn"
                    onClick={() => setActiveGame(game.id as 'chest' | 'minesweeper')}
                    aria-label={`Играть в ${game.nameRu}`}
                    data-ui-sound="open"
                  >
                    Играть
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-quiet casino-dev-btn"
                    disabled
                    aria-label={`${game.nameRu} пока в разработке`}
                  >
                    Скоро
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
