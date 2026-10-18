# Vista icons

Original Windows Vista icon artwork, hosted by the Frutiger Aero Archive.
The four primary assets were selected directly by the user. Personalization was
selected from the same supplied icon catalog for the theme selector.

Catalog: https://frutigeraeroarchive.org/icons

| Local PNG | Original resource |
| --- | --- |
| vista-search-globe.png | https://frutigeraeroarchive.org/images/icons/windows_vista/vista_search_globe.ico |
| vista-firewall-on.png | https://frutigeraeroarchive.org/images/icons/windows_vista/vista_firewall_status_1.ico |
| vista-firewall-off.png | https://frutigeraeroarchive.org/images/icons/windows_vista/vista_firewall_status_2.ico |
| vista-firewall-warning.png | https://frutigeraeroarchive.org/images/icons/windows_vista/vista_firewall_status_3.ico |
| vista-personalization.png | https://frutigeraeroarchive.org/images/icons/windows_vista/vista_personalization.ico |
| vista-perf-center.png | https://frutigeraeroarchive.org/images/icons/windows_vista/vista_perf_center.ico |
| minigames-gamepad.png | https://frutigeraeroarchive.org/images/icons/windows_vista/vista_console.ico |
| game-lucky-chest.png | https://icons.iconarchive.com/icons/iconarchive/seaside/256/Treasure-Chest-icon.png |
| game-minesweeper.png | https://icons.iconarchive.com/icons/everaldo/crystal-clear/128/App-core-bomb-icon.png |
| coin.png | https://icons.iconarchive.com/icons/hopstarter/soft-scraps/256/Coin-icon.png |

Each PNG is the original 256×256, 32-bit RGBA PNG frame extracted byte-for-byte
from its ICO container, with no redraw, generation, resizing, or pixel changes.
The full Search Globe ICO is also used as `frontend/public/favicon.ico`.
Original artwork rights remain with their owners; archival hosting is not a license.

Usage: globe = site identity; firewall on = linked / privacy assurance; firewall
off = not linked; firewall warning = error/retry notices. Text communicates each
state explicitly; these icons do not claim to report an actual firewall status.
The Performance Center artwork marks Global Statistics and is the fallback for nickname skin heads; like the
Personalization icon it was selected from the same supplied Vista catalog.


## Minecraft nickname skin heads

Linked nickname apps, their menu/dock launchers, and statistics account headings
use remote avatars from [MCHeads](https://mc-heads.net/), following its documented
texture-hash and size API: `https://mc-heads.net/avatar/<texture hash>/64`.
The image is requested directly with `referrerPolicy="no-referrer"`; no generated
head or local skin asset is introduced. MCHeads encourages attribution but does
not require it. Skin artwork rights remain with their respective owners.

LinkBridge reports SkinsRestorer's selected texture. The panel does not guess a
Mojang identity from an offline UUID or nickname. These images do not establish
identity; client skin mods may render another skin. When no texture is known or
image loading fails, `PlayerHead.tsx`
uses the original sourced `vista-perf-center.png` above. Nicknames remain visible.

The player app's Skin page loads the actual PNG from
`https://textures.minecraft.net/texture/<texture hash>` without a referrer.
`SkinFigure.tsx` draws its front and outer layer locally, respecting Classic/Slim
arms. Selected-upload previews use a local object URL. Uploaded skins are
user-provided artwork, not generated project assets. The server strips PNG
metadata before sending an unlisted image to MineSkin for signing.


## Minecraft item icons

The Inventory page draws each item with the texture the game itself uses.
LinkBridge reads the PNG straight out of the running server's own asset files —
`assets/minecraft/textures/item/<name>.png`, `…/block/<name>.png`, or
`…/item/armor/<name>.png` — and uploads it once per item key, so the picture
always matches the Minecraft version that produced the snapshot. The panel keeps
the first upload for a key and serves it as a data URL; nothing is redrawn,
generated, substituted or fetched from a third party. Mojang's texture artwork
rights remain with their owners.

Many items are assembled from a model rather than one flat PNG (heads, potions,
some blocks). When no texture file is readable for an item key, the bubble shows
the sourced `vista-perf-center.png` above with the item's name; offline, unknown,
or failing icons never invent a picture. The item's name, amount, wear and
enchantments are always stated in text.

The Lucky Chest mini-game uses the official Minecraft item textures from the client assets for its marine theme (`diamond.png`, `heart_of_the_sea.png`, `trident.png`, `nautilus_shell.png`, `prismarine_crystals.png`, `prismarine_shard.png`, `pufferfish.png`, `tropical_fish.png`). Mojang's texture artwork rights remain with their owners.

The Minesweeper mini-game uses the official Minecraft textures from client assets for its mining theme (`tnt.png` block texture for mines, `iron_ingot.png`, `gold_ingot.png`, and `diamond.png` for safe treasure ores). Mojang's texture artwork rights remain with their owners.

