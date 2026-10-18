import { useState } from 'react'
import minigamesIcon from '../assets/icons/minigames-gamepad.png'
import luckyChestIcon from '../assets/icons/game-lucky-chest.png'
import minesIcon from '../assets/icons/game-minesweeper.png'
import LuckyChestGame from '../components/LuckyChestGame'
import MinesweeperGame from '../components/MinesweeperGame'

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
    description: 'Таинственный сундук сокровищ. Крутите морские сокровища в водных пузырьках и ловите алмазный джекпот!',
    icon: luckyChestIcon,
    tag: 'Treasure Box',
    ready: true,
  },
  {
    id: 'minesweeper',
    name: 'Minesweeper',
    nameRu: 'Сапёр',
    description: 'Шахтёрское минное поле Minecraft. Открывайте безопасные блоки, находите железо, золото и алмазы, повышайте множитель ставки и остерегайтесь скрытого динамита!',
    icon: minesIcon,
    tag: 'Mines & Ore',
    ready: true,
  },
]

export default function MinigamesPage({}: Props) {
  const [activeGame, setActiveGame] = useState<'chest' | 'minesweeper' | null>(null)

  if (activeGame === 'chest') {
    return <LuckyChestGame onBack={() => setActiveGame(null)} />
  }
  if (activeGame === 'minesweeper') {
    return <MinesweeperGame onBack={() => setActiveGame(null)} />
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
              Добро пожаловать в игровой раздел! Здесь вы сможете сыграть в увлекательные мини-игры и испытать свою удачу.
            </p>
          </div>
        </div>
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
                {!game.ready && (
                  <span className="casino-dev-note">Разработка логики</span>
                )}
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
