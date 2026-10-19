import coinIcon from '../assets/icons/coin.png'
import { formatCoins, type Payer } from '../lib/minigames'

type Props = {
  payer: Payer
  accounts: Payer[]
  onChoose: (uuid: string) => void
  /** Switching payer mid-round would move the stake to another account's coins. */
  disabled?: boolean
}

/**
 * The balance being staked and the account it belongs to. Coins live on a
 * Minecraft UUID, so a login with several linked accounts has to say which one
 * pays — the number next to the name is that account's, never a sum.
 */
export default function PayerSelect({ payer, accounts, onChoose, disabled = false }: Props) {
  return (
    <div className="chest-balance-pill casino-payer-pill">
      <img src={coinIcon} alt="" className="chest-coin-icon" />
      <span className="chest-balance-num">{formatCoins(payer.coins)}</span>
      <span className="chest-balance-label">монет</span>
      {accounts.length > 1 ? (
        <select
          className="casino-payer-select"
          value={payer.uuid}
          onChange={(event) => onChoose(event.target.value)}
          disabled={disabled}
          aria-label="Счёт для ставки"
          title="Счёт для ставки"
        >
          {accounts.map((account) => (
            <option key={account.uuid} value={account.uuid}>
              {account.username}
            </option>
          ))}
        </select>
      ) : (
        <span className="casino-payer-name">{payer.username}</span>
      )}
    </div>
  )
}
