import type { InventorySlot } from './api'

/**
 * Custom Frutiger Aero / fantasy vector textures for custom realm items:
 * - Protection Core (Lodestone runic core)
 * - Tier 1 Fuel: Ember Shard
 * - Tier 2 Fuel: Cobalt Crystal
 * - Tier 3 Fuel: Crimson Core
 * - Tier 4 Fuel: Astral Void Crystal
 */

export const PROTECTION_CORE_ICON =
  `data:image/svg+xml;utf8,` +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <radialGradient id="pc-core-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#fff8d0" stop-opacity="1"/>
      <stop offset="25%" stop-color="#ffd700" stop-opacity="0.95"/>
      <stop offset="60%" stop-color="#00e5ff" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#0044aa" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="pc-metal-top" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#dce8f5"/>
      <stop offset="50%" stop-color="#94aabf"/>
      <stop offset="100%" stop-color="#556c80"/>
    </linearGradient>
    <linearGradient id="pc-gold-edge" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#fff5b8"/>
      <stop offset="50%" stop-color="#e6b800"/>
      <stop offset="100%" stop-color="#8a6500"/>
    </linearGradient>
    <linearGradient id="pc-body-left" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#465a6e"/>
      <stop offset="100%" stop-color="#212f3d"/>
    </linearGradient>
    <linearGradient id="pc-body-right" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#314352"/>
      <stop offset="100%" stop-color="#15202b"/>
    </linearGradient>
    <filter id="pc-glow-filter" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="2.5" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>

  <!-- Ambient Glow -->
  <circle cx="32" cy="32" r="28" fill="url(#pc-core-glow)" opacity="0.45"/>

  <!-- Isometric Outer Base (Lodestone Frame) -->
  <!-- Top Face -->
  <polygon points="32,6 56,19 32,32 8,19" fill="url(#pc-metal-top)" stroke="url(#pc-gold-edge)" stroke-width="1.8" stroke-linejoin="round"/>
  <!-- Left Face -->
  <polygon points="8,19 32,32 32,58 8,45" fill="url(#pc-body-left)" stroke="#1a2530" stroke-width="1.2" stroke-linejoin="round"/>
  <!-- Right Face -->
  <polygon points="32,32 56,19 56,45 32,58" fill="url(#pc-body-right)" stroke="#101820" stroke-width="1.2" stroke-linejoin="round"/>

  <!-- Golden Corner Braces -->
  <polygon points="32,6 38,9.5 32,13 26,9.5" fill="url(#pc-gold-edge)"/>
  <polygon points="8,19 14,19 14,27 8,25" fill="url(#pc-gold-edge)"/>
  <polygon points="56,19 50,19 50,27 56,25" fill="url(#pc-gold-edge)"/>
  <polygon points="32,58 26,54.5 32,51 38,54.5" fill="url(#pc-gold-edge)"/>

  <!-- Energy Rune Channels (Glowing Cyan Lines) -->
  <path d="M 20,26 L 32,32 L 44,26" fill="none" stroke="#00e5ff" stroke-width="1.6" opacity="0.9" filter="url(#pc-glow-filter)"/>
  <path d="M 32,32 L 32,48" fill="none" stroke="#00e5ff" stroke-width="1.8" opacity="0.9" filter="url(#pc-glow-filter)"/>
  <path d="M 16,36 L 24,40" fill="none" stroke="#00e5ff" stroke-width="1.4" opacity="0.75"/>
  <path d="M 48,36 L 40,40" fill="none" stroke="#00e5ff" stroke-width="1.4" opacity="0.75"/>

  <!-- Floating Glowing Core Orb -->
  <circle cx="32" cy="27" r="11" fill="url(#pc-core-glow)" filter="url(#pc-glow-filter)"/>
  <circle cx="32" cy="27" r="6" fill="#ffffff" opacity="0.9"/>
  <!-- Orbital Ring -->
  <ellipse cx="32" cy="27" rx="14" ry="5" fill="none" stroke="#ffd700" stroke-width="1.4" transform="rotate(-15 32 27)" opacity="0.85"/>
  <!-- Specular Reflection -->
  <ellipse cx="30" cy="24" rx="3.5" ry="2" fill="#ffffff" opacity="0.85"/>
</svg>`)

export const FUEL_TIER_1_ICON =
  `data:image/svg+xml;utf8,` +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <radialGradient id="f1-ambient" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffcc00" stop-opacity="0.8"/>
      <stop offset="50%" stop-color="#ff5500" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#aa1100" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="f1-facet-front" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fff8a0"/>
      <stop offset="40%" stop-color="#ffaa00"/>
      <stop offset="100%" stop-color="#dd3300"/>
    </linearGradient>
    <linearGradient id="f1-facet-side" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ff8800"/>
      <stop offset="60%" stop-color="#bb2200"/>
      <stop offset="100%" stop-color="#770a00"/>
    </linearGradient>
    <linearGradient id="f1-facet-highlight" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#ffcc44"/>
    </linearGradient>
  </defs>

  <!-- Heat Aura -->
  <circle cx="32" cy="33" r="26" fill="url(#f1-ambient)"/>

  <!-- Shard Facets (Ember Crystal Cluster) -->
  <!-- Left Secondary Shard -->
  <polygon points="18,48 12,36 21,30 24,44" fill="url(#f1-facet-side)" stroke="#ffaa00" stroke-width="0.8"/>
  <polygon points="18,48 24,44 26,38 21,30" fill="url(#f1-facet-front)"/>

  <!-- Right Secondary Shard -->
  <polygon points="46,50 52,38 43,32 40,46" fill="url(#f1-facet-side)" stroke="#ffaa00" stroke-width="0.8"/>
  <polygon points="46,50 40,46 38,40 43,32" fill="url(#f1-facet-front)"/>

  <!-- Main Center Shard -->
  <polygon points="32,8 44,28 32,56 20,28" fill="url(#f1-facet-side)" stroke="#ffe066" stroke-width="1.2"/>
  <polygon points="32,8 38,24 32,56 26,24" fill="url(#f1-facet-front)"/>
  <!-- Central Ridge Facet -->
  <polygon points="32,8 34,22 32,56" fill="url(#f1-facet-highlight)" opacity="0.85"/>

  <!-- Ember Sparks -->
  <circle cx="21" cy="18" r="1.8" fill="#fff799"/>
  <circle cx="44" cy="16" r="1.4" fill="#ffaa00"/>
  <circle cx="48" cy="27" r="1.6" fill="#fff799"/>
  <circle cx="15" cy="26" r="1.3" fill="#ff7700"/>
</svg>`)

export const FUEL_TIER_2_ICON =
  `data:image/svg+xml;utf8,` +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <radialGradient id="f2-ambient" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#00f5ff" stop-opacity="0.8"/>
      <stop offset="50%" stop-color="#0088ff" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#002288" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="f2-facet-a" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#d4ffff"/>
      <stop offset="40%" stop-color="#00d4ff"/>
      <stop offset="100%" stop-color="#0066cc"/>
    </linearGradient>
    <linearGradient id="f2-facet-b" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00aaff"/>
      <stop offset="60%" stop-color="#0044aa"/>
      <stop offset="100%" stop-color="#001855"/>
    </linearGradient>
    <linearGradient id="f2-specular" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#a0f0ff"/>
    </linearGradient>
  </defs>

  <!-- Ambient Glow -->
  <circle cx="32" cy="32" r="26" fill="url(#f2-ambient)"/>

  <!-- Cobalt Multi-Crystal Cluster -->
  <!-- Left Crystal -->
  <polygon points="14,46 22,22 28,48 18,52" fill="url(#f2-facet-b)" stroke="#66e0ff" stroke-width="0.8"/>
  <polygon points="22,22 28,48 24,36" fill="url(#f2-facet-a)"/>

  <!-- Right Crystal -->
  <polygon points="50,46 42,20 36,48 46,52" fill="url(#f2-facet-b)" stroke="#66e0ff" stroke-width="0.8"/>
  <polygon points="42,20 36,48 40,34" fill="url(#f2-facet-a)"/>

  <!-- Main Tall Cobalt Crystal -->
  <polygon points="32,7 44,26 36,57 24,53 20,26" fill="url(#f2-facet-b)" stroke="#b3f5ff" stroke-width="1.2"/>
  <polygon points="32,7 39,24 33,56 26,24" fill="url(#f2-facet-a)"/>
  <!-- Specular Facet Edge -->
  <polygon points="32,7 34,22 33,56" fill="url(#f2-specular)" opacity="0.9"/>

  <!-- Crystalline sparkles -->
  <polygon points="32,15 33.5,19 37,20.5 33.5,22 32,26 30.5,22 27,20.5 30.5,19" fill="#ffffff" opacity="0.9"/>
  <circle cx="16" cy="18" r="1.3" fill="#a0f5ff"/>
  <circle cx="48" cy="14" r="1.5" fill="#a0f5ff"/>
</svg>`)

export const FUEL_TIER_3_ICON =
  `data:image/svg+xml;utf8,` +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <radialGradient id="f3-ambient" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ff2255" stop-opacity="0.85"/>
      <stop offset="50%" stop-color="#bb0033" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#550011" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="f3-facet-light" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffd0dc"/>
      <stop offset="40%" stop-color="#ff2a6d"/>
      <stop offset="100%" stop-color="#b3003b"/>
    </linearGradient>
    <linearGradient id="f3-facet-dark" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#cc0044"/>
      <stop offset="60%" stop-color="#7a0028"/>
      <stop offset="100%" stop-color="#3d0014"/>
    </linearGradient>
    <linearGradient id="f3-edge" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#ff80a0"/>
    </linearGradient>
  </defs>

  <!-- Crimson Pulsating Glow -->
  <circle cx="32" cy="32" r="27" fill="url(#f3-ambient)"/>

  <!-- Geometrical Crimson Core (Heart/Gem Cluster) -->
  <!-- Outer Gem Shield -->
  <polygon points="32,9 51,21 44,48 32,57 20,48 13,21" fill="url(#f3-facet-dark)" stroke="#ff7396" stroke-width="1.3" stroke-linejoin="round"/>

  <!-- Inner Top Facets -->
  <polygon points="32,9 51,21 38,27 32,17" fill="url(#f3-facet-light)"/>
  <polygon points="32,9 13,21 26,27 32,17" fill="url(#f3-facet-light)" opacity="0.85"/>

  <!-- Center Heart Facet (Radiant Core) -->
  <polygon points="32,17 38,27 32,45 26,27" fill="url(#f3-edge)"/>

  <!-- Lower Angled Facets -->
  <polygon points="38,27 51,21 44,48 32,45" fill="url(#f3-facet-light)"/>
  <polygon points="26,27 13,21 20,48 32,45" fill="url(#f3-facet-dark)"/>
  <polygon points="32,45 44,48 32,57" fill="url(#f3-facet-dark)"/>
  <polygon points="32,45 20,48 32,57" fill="url(#f3-facet-light)" opacity="0.8"/>

  <!-- Core Brilliant Highlight -->
  <ellipse cx="32" cy="24" rx="4" ry="2.5" fill="#ffffff" opacity="0.95"/>
  <circle cx="48" cy="18" r="1.5" fill="#ffaec0"/>
  <circle cx="16" cy="18" r="1.5" fill="#ffaec0"/>
</svg>`)

export const FUEL_TIER_4_ICON =
  `data:image/svg+xml;utf8,` +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <radialGradient id="f4-ambient" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#d946ef" stop-opacity="0.85"/>
      <stop offset="45%" stop-color="#8b5cf6" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="#1e1b4b" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="f4-facet-nebula" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fae8ff"/>
      <stop offset="30%" stop-color="#d946ef"/>
      <stop offset="70%" stop-color="#7c3aed"/>
      <stop offset="100%" stop-color="#2e1065"/>
    </linearGradient>
    <linearGradient id="f4-facet-void" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#6366f1"/>
      <stop offset="50%" stop-color="#3b0764"/>
      <stop offset="100%" stop-color="#0f0728"/>
    </linearGradient>
    <linearGradient id="f4-astral-sheen" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#c084fc"/>
    </linearGradient>
  </defs>

  <!-- Astral Nebula Halo -->
  <circle cx="32" cy="32" r="28" fill="url(#f4-ambient)"/>

  <!-- Cosmic Orbital Ring -->
  <ellipse cx="32" cy="34" rx="24" ry="7" fill="none" stroke="#d946ef" stroke-width="1.2" transform="rotate(-20 32 34)" opacity="0.6"/>

  <!-- Astral Void Crystals -->
  <!-- Left Spire -->
  <polygon points="12,44 19,16 26,42 18,50" fill="url(#f4-facet-void)" stroke="#c084fc" stroke-width="0.8"/>
  <polygon points="19,16 26,42 22,30" fill="url(#f4-facet-nebula)"/>

  <!-- Right Spire -->
  <polygon points="52,44 45,16 38,42 46,50" fill="url(#f4-facet-void)" stroke="#c084fc" stroke-width="0.8"/>
  <polygon points="45,16 38,42 42,30" fill="url(#f4-facet-nebula)"/>

  <!-- Center Obelisk Void Crystal -->
  <polygon points="32,5 45,24 38,58 26,58 19,24" fill="url(#f4-facet-void)" stroke="#f0abfc" stroke-width="1.3"/>
  <polygon points="32,5 40,22 34,57 26,22" fill="url(#f4-facet-nebula)"/>
  <!-- Specular Astral Ridge -->
  <polygon points="32,5 34,20 33,56" fill="url(#f4-astral-sheen)" opacity="0.95"/>

  <!-- Starlight Glimmers -->
  <polygon points="32,18 33.5,21 37,22.5 33.5,24 32,27 30.5,24 27,22.5 30.5,21" fill="#ffffff"/>
  <polygon points="46,12 47,14 49,15 47,16 46,18 45,16 43,15 45,14" fill="#fae8ff" opacity="0.9"/>
  <circle cx="16" cy="14" r="1.5" fill="#f0abfc"/>
  <circle cx="48" cy="38" r="1.2" fill="#ffffff"/>
</svg>`)

/**
 * Checks if a slot holds a Protection Core.
 */
export function isProtectionCoreItem(slot: InventorySlot | null | undefined): boolean {
  if (!slot) return false
  const name = (slot.display_name ?? '').toLowerCase()
  return (
    name.includes('protection core') ||
    (slot.key === 'minecraft:lodestone' && (name.includes('core') || name.includes('private'))) ||
    slot.key === 'minecraft:lodestone'
  )
}

/**
 * Resolves dedicated custom artwork for custom realm items.
 * Returns null if the item is a standard vanilla item.
 */
export function getCustomItemIcon(slot: InventorySlot | null | undefined): string | null {
  if (!slot) return null
  if (isProtectionCoreItem(slot)) {
    return PROTECTION_CORE_ICON
  }
  const name = (slot.display_name ?? '').toLowerCase()
  if (name.includes('tier 1 fuel') || name.includes('ember shard')) {
    return FUEL_TIER_1_ICON
  }
  if (name.includes('tier 2 fuel') || name.includes('cobalt crystal')) {
    return FUEL_TIER_2_ICON
  }
  if (name.includes('tier 3 fuel') || name.includes('crimson core')) {
    return FUEL_TIER_3_ICON
  }
  if (name.includes('tier 4 fuel') || name.includes('astral void crystal')) {
    return FUEL_TIER_4_ICON
  }
  return null
}

/**
 * Returns the custom crystal icon for a given fuel tier (1..=4).
 */
export function getFuelTierIcon(tier: number): string {
  switch (tier) {
    case 1: return FUEL_TIER_1_ICON
    case 2: return FUEL_TIER_2_ICON
    case 3: return FUEL_TIER_3_ICON
    case 4: return FUEL_TIER_4_ICON
    default: return FUEL_TIER_1_ICON
  }
}
