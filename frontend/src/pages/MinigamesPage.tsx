import minigamesIcon from '../assets/icons/minigames-gamepad.png'
import luckyChestIcon from '../assets/icons/game-lucky-chest.png'
import minesIcon from '../assets/icons/game-minesweeper.png'

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
}

const MINIGAMES: Minigame[] = [
  {
    id: 'chest',
    name: 'Lucky Chest',
    nameRu: 'Сундук удачи',
    description: 'Таинственный сундук сокровищ. Открывайте замок, испытывайте удачу и получайте редкие призы и множители.',
    icon: luckyChestIcon,
    tag: 'Treasure Box',
  },
  {
    id: 'minesweeper',
    name: 'Minesweeper',
    nameRu: 'Сапёр',
    description: 'Классическое минное поле в стиле Windows. Открывайте безопасные клетки, умножайте ставки и остерегайтесь скрытых мин.',
    icon: minesIcon,
    tag: 'Multiplier',
  },
]

export default function MinigamesPage({}: Props) {
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
                    <span className="casino-dev-badge">В разработке</span>
                  </div>
                  <h3>{game.nameRu}</h3>
                  <span className="casino-subtitle-en">{game.name}</span>
                  <p className="casino-game-desc">{game.description}</p>
                </div>
              </div>

              <div className="casino-card-actions">
                <div className="casino-dev-note">
                  <span className="casino-dev-icon">⚙️</span>
                  <span>Разработка механики и логики</span>
                </div>
                <button
                  type="button"
                  className="btn btn-quiet casino-dev-btn"
                  disabled
                  aria-label={`${game.nameRu} пока в разработке`}
                >
                  Скоро
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
