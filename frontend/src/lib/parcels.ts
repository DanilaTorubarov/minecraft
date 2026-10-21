export type ParcelItem = {
  key: string
  amount: number
  display_name?: string | null
}

export type ParcelSummaryData = {
  coins: number
  quantity: number
  item?: ParcelItem | null
}

export type TerritoryAlertSummary = {
  kind: 'breach' | 'fuel_low'
}

export function isFuelCriticallyLow(fuelSeconds: number): boolean {
  return fuelSeconds > 0 && fuelSeconds <= 7200
}

export function formatFuelRemaining(fuelSeconds: number): string {
  if (fuelSeconds <= 0) return 'Depleted'
  const hours = Math.floor(fuelSeconds / 3600)
  const minutes = Math.floor((fuelSeconds % 3600) / 60)
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return `${minutes}m`
}

export function parcelSummary(parcel: ParcelSummaryData): string {
  const parts: string[] = []
  if (parcel.coins > 0) {
    parts.push(`${parcel.coins.toLocaleString()} coin${parcel.coins === 1 ? '' : 's'}`)
  }
  if (parcel.quantity > 0 && parcel.item) {
    const name = parcel.item.display_name || parcel.item.key.replace(/^minecraft:/, '').replace(/_/g, ' ')
    parts.push(`${parcel.quantity}x ${name}`)
  } else if (parcel.quantity > 0) {
    parts.push(`${parcel.quantity} item${parcel.quantity === 1 ? '' : 's'}`)
  }
  return parts.join(' + ') || 'Empty parcel'
}

export function isBreachAlert(alert: TerritoryAlertSummary): boolean {
  return alert.kind === 'breach'
}

export function isLowFuelAlert(alert: TerritoryAlertSummary): boolean {
  return alert.kind === 'fuel_low'
}
