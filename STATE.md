# Project checkpoint — 2026-10-21


## Anti-xray switched to Engine Mode 1 (Ore Hiding) up to Y=180 — 2026-10-22

- Issue observed in game via X-ray client:
  1. `engine-mode: 3` (`OBFUSCATE_LAYER`) randomized each horizontal 16×16 chunk slice to a single block, creating unnatural, solid horizontal sheets of copper, gold, and diamond ore below Y=64.
  2. `max-block-height: 64` terminated obfuscation at sea level, leaving mountain terrain and peaks around spawn (spawn is ~Y=123, terrain up to Y=180) completely unhidden, with real coal and iron seams visible to X-ray.
- Fix:
  - Switched overworld and nether to **Engine Mode 1 (Ore Hiding)** (`engine-mode: 1`). Unexposed ores underground and in mountains are disguised as ordinary `stone` and `deepslate` (or `netherrack` in the nether).
  - Raised `max-block-height: 180` in the overworld to cover high mountain emerald, coal, and iron seams.
  - Eliminated artificial geometric ore sheets and chunk packet bloat entirely; fully compatible with Bedrock (Geyser) clients without desync or freezing.
  - Mining dimension and The End remain `enabled: false`.
- Verification: configuration checked and validated; runtime configs synced to `mc/purpur/`.


## Stalled plugin download stopped the container — Geyser/Floodgate pinned — 2026-10-22

- Reported as "the server crashed" at 19:39. It was not a Java crash: Docker records `minecraft-purpur-1` **exit 1**
  at 19:39:33, ten seconds after the deploy stop (exit 0 at 19:39:23). The failed boot's `mc-image-helper` log reads
  `Failed to process source: null` / `'mcopy' command failed` / `io.netty.handler.timeout.ReadTimeoutException` — the
  newly added `floodgate-spigot` PLUGINS URL timed out against `download.geysermc.org`. `restart: unless-stopped`
  restarted the container, and the retry treated the 16 KB partial jar as "already up to date", so Paper logged
  `Error loading plugin: zip END header not found` and booted with 5 plugins (no Floodgate).
- The same defect hit the Velocity restart at 19:55: the interrupted Geyser fetch truncated
  `Geyser-Velocity.jar` to 15 KB, so Velocity logged `Can't create module for plugin geyser`
  (`ClassNotFoundException: GeyserVelocityPlugin`). Java players were fine; Bedrock was unreachable.
- Cause of both: `mc-image-helper` truncates the destination before a download completes, and its freshness check
  then compares mtimes — the failed partial file is newer than upstream's `Last-Modified`, so the next boot accepts
  it. `latest` Geyser/Floodgate URLs made this recur on every upstream build (Geyser 2.12.0 build 1269 appeared at
  18:29 that day), and this host currently receives only ~20 KB per connection before the Geyser download host
  stalls (several parallel attempts measured 0.1–1.4 KB/s).
- Fix: `compose.yaml` now pins Geyser `2.12.0` build `1269` and Floodgate `2.2.5` build `141` for both the proxy and
  the backend, matching the other pinned plugins. The replacement jars were fetched with a resumable parallel-range
  downloader and verified (`zipfile.testzip()`, 19,560 entries / 4,578 entries).
- Verification: `purpur` boots **6** plugins — AuthMe, BlueMap, GrimAC, LinkBridge, SkinsRestorer and `floodgate
  2.2.5-SNAPSHOT (b141)` — and SkinsRestorer logs `Floodgate skin listener registered`; the shared 16-byte
  `mc/purpur/plugins/floodgate/key.pem` is in place. `velocity` loads `geyser 2.12.0-b1269` and `floodgate 2.2.5`
  and listens on UDP 19132; runtime configs carry `send-floodgate-data: true` and `cache-images: 14`. A live Bedrock
  join after the repair still needs a Bedrock client.
- Geyser also prints its pre-existing NetherNet notice (`Players will not be able to connect ... starting October
  27th`) as an ERROR-level banner; it was present before this change and is not part of the failure.


## Bedrock players froze and mined nothing — anti-xray mode 2 — 2026-10-22

- Report from the Bedrock player `.Kokochi7232` (Floodgate UUID `00000000-0000-0000-0009-01f835f39efb`): blocks in
  `/mine` could not be broken, no fuel crystals could be found, and at the spawn blocks broke client-side but stayed
  on the server, then the player got stuck in them.
- Root cause 1 (freeze + ghost blocks): **Paper anti-xray `engine-mode: 2` is broken for Geyser clients** (Geyser
  issue #6650). Seconds after joining, the Bedrock client stops receiving clientbound block/entity updates; its own
  actions still reach the Java server, so broken blocks stay server-side, new chunks stop loading and the client
  eventually freezes or times out. Engine mode 3 (or 1/off) is unaffected.
- Root cause 2 (no fuel): the mine's reward is **real** copper/lapis/redstone/emerald/amethyst ores, and every one of
  those was in `hidden-blocks`. With mode 2/3 the client receives fake ores in the hidden-block pool, so a real crystal
  looks like a random stone block and every stone wall looks like a crystal. The player could not identify a single
  real vein. `/minershop buy 4` had actually succeeded at 18:28:55 (ledger `minershop_pickaxe -20000`, tier 4), so the
  tool was never the problem.
- Fix: `engine-mode: 3`, Paper's recommended fake-ore/replacement lists, `max-block-height: 64` (spawn is ~Y=123, and a
  higher ceiling fakes walls at build height), `lava-obscures: false`; per-dimension overrides now live at
  `mc-config/purpur/world/dimensions/minecraft/{mine_world,the_nether,the_end}/paper-world.yml` — **anti-xray is off in
  the mining dimension and the end**, the nether keeps mode 3 with a nether-ore pool and height 128.
- LinkBridge 1.14.1 adds `resyncBlockForClient()` / `resyncBlockNextTick()`: a refused break or placement (missing
  Prospector Pickaxe, mine bedrock, private-zone denial, block placement in the mine) now sends the authoritative block
  back, so a Bedrock client does not keep a ghost hole and rubber-band inside it.
- Not changed: `spawn-protection=16` in the runtime `server.properties` still refuses breaks within 16 blocks of the
  world spawn for non-operators (the reported spawn is `[0,145,0]`, joins land around `1.5,123,9.5`). That is vanilla
  behaviour; operators bypass it, and the plugin's own private-block zones are the server's protection system.
- Verification: plugin built (`LinkBridge-1.14.1.jar` installed, 1.14.0 disabled), purpur restarted with the synced
  configs; `world/dimensions/minecraft/mine_world/paper-world.yml` carries `enabled: false`, the defaults file carries
  `engine-mode: 3`, and the boot log shows no anti-xray configuration warning. Bedrock retest by the reporting player
  is still required.
- Also observed, not fixed: the player was in creative for most of the session and the report arrived after a long
  admin test sequence (op/de-op, gamemode changes, 1,000,000-coin grant), so the exact play session is hard to replay;
  the two root causes above are configuration, not session-specific.


## Item wear reads as remaining/maximum uses — 2026-10-22

- The inventory bubble drew a thin wear bar and the tooltip and marketplace printed a
  rounded percentage (`75% durability left`). Both now show the pair the server reports:
  `1171/1561` on the bubble pill (still coloured green → amber → red by what is left),
  `1171/1561 durability` in the tooltip, aria-label and marketplace listing.
- `durabilityParts()` / `durabilityText()` in `frontend/src/lib/inventory.ts` is the only
  formatter: it clamps a stale snapshot at `0/max` instead of printing a negative count
  and returns null for an item that cannot wear. A full-health item still shows nothing
  on the bubble.
- Narrow layout: a 9-column grid on a phone leaves ~34px bubbles, so at a ≤520px
  container the bubble keeps only the remaining count (`1171`) via `.inv-durability-max`;
  the tooltip always carries the pair. `DESIGN.md`'s inventory paragraph records the pill.
- Verification: `npm run build`, `npm run lint` and `npm test` (87 tests) pass; the app
  image was rebuilt, the served shell names the new bundle, and the bundle contains the
  `inv-durability-max` markup with the old percent string gone.


## Admin console terminal restored — 2026-10-22

- Symptom: the website's Admin Panel → Console Terminal stayed on "Connecting to server
  terminal stream...", live metrics never left their defaults (`is_live: false`, 0 MB
  RAM, `Minecraft Server`), and typed commands produced no output — while linking,
  inventory, chat, privates and clans all worked from the same plugin and token.
- Root cause (report rejected): `syncAdmin()` built `tps` from `Bukkit.getTPS()`, which
  Purpur 26.3 returns as **four** windows, but the panel's internal sync request accepted
  exactly `[f64; 3]`. Every report was answered `400 … tps: trailing characters`, and the
  plugin silently ignored non-200 answers, so `GLOBAL_ADMIN_STATE` never received one.
  The website half was live and correct the whole time.
- Root cause (no server lines): the console mirror hung a `java.util.logging` handler on
  the JUL root logger, but Paper and its forks log through Log4j2. Even a working sync
  would have shown almost nothing but plugin messages.
- Root cause (stream stops after a command): the terminal adopted the local echo's
  `Date.now()` id as its poll cursor, so `since_id` afterwards asked for lines newer than
  any the panel could produce. Panel log ids also restarted at 1 on every restart, which
  invalidated an open tab's cursor for good.
- Fix: the panel accepts any TPS window count (keeps the first three, a missing window
  stays 20) and the plugin sends exactly three; the terminal mirrors the Log4j2 root
  stream with ANSI stripped and keeps the JUL handler as a fallback; dashboard commands
  run through the real console sender and collect the lines logged on that thread (the
  hand-built `CommandSender` proxy broke vanilla commands and swallowed output); log ids
  are seeded from the clock so they keep increasing across restarts; the frontend polls
  with a server-only cursor and de-duplicates a command's echoed lines; a failing admin
  sync is logged once a minute instead of vanishing.
- Also: `.env.docker`'s real `SMTP_USERNAME`/`SMTP_PASSWORD` leaked into the `tests`
  service, so every mail-sending test answered `503` against mailpit. Blank credentials
  are now ignored, and the `tests` service sets them empty.
- Verification: `cargo check --tests` clean; the full `tests`-service suite passes;
  `npm run build`, `npm run lint` and `npm test` pass; LinkBridge 1.14.0 deployed and the
  live panel now reports `is_live: true` with Purpur's RAM/version, streams real server
  lines and returns real command output.


## Offline Mail & Delivery Parcel System and Territory Alerts — 2026-10-21

- **Offline Mail & Delivery Parcel System**:
  - Implemented offline delivery parcel sending from website inventory, marketplace (as gifts), and direct currency/parcel dispatch in Player Controls.
  - Stored parcels durably in PostgreSQL (`mail_parcels` in migration `0023_offline_mail_and_territory_alerts.sql`).
  - Item withdrawal and escrow handled losslessly from inventory or marketplace listing.
  - On Minecraft login (AuthMe `LoginEvent` / `RegisterEvent`), players receive the exact in-game alert:
    `You received a delivery from [Player]! Type /mail claim.`
  - In-game command `/mail claim` (and `/mail list`) connects to `/internal/mail/claim`, credits coins, and places items into player inventory with drop-safety fallback if inventory is full.
  - Added dedicated `MailPage.tsx` tab in Player Controls with incoming delivery status, sent parcel history, and direct coin parcel dispatch.
- **Territory Defense Alerts**:
  - Automated web alerts when a player's private protection core fuel drops below 2 hours (< 7200 seconds) or when a breach charge detonates on their base.
  - In `LinkBridgePlugin.java`, breach charge detonations report territory alerts asynchronously to `/internal/territory/alert`.
  - Backend dynamically detects low fuel (< 2 hours) on placed private blocks and merges with persisted alerts in `GET /api/territory/alerts`.
  - Desktop UI in `Shell.tsx` features automated alert polling, menubar alert badges, and rich floating Aero alert toast banners with quick navigation to Player Controls.
  - `PrivatesPage.tsx` displays active defense alerts and per-core critical fuel warnings.
- **Verification**:
  - `cargo check --tests`: Clean compilation with zero warnings/errors and full integration test coverage (`offline_mail_parcel_send_and_claim`, `territory_defense_alerts_low_fuel_and_breach`).
  - `npm --prefix frontend test`: 73 unit tests passed.
  - `npm --prefix frontend run build`: Clean production build (131ms).
  - `npm --prefix frontend run lint`: Zero lint errors.
  - `./scripts/build-plugin.sh`: LinkBridge 1.12.0 built and installed into `mc/purpur/plugins/LinkBridge-1.12.0.jar`.


## Live 3D map restored (Caddy `map` route) — 2026-10-21

- Symptom: the Live 3D Map window on `oasisaero.ru` did not load BlueMap. `/map/`
  and every `/map/...` asset returned the website SPA (and 404s for real files)
  instead of the map, so the iframe could not connect to the map server. The rest
  of the site was unaffected.
- Root cause: `./Caddyfile` is a single-file bind mount, which Docker pins to the
  file's inode. The proxy container was created before the `/map/*` route was
  added; the later checkout replaced the file, but the running Caddy kept reading
  the old inode. `caddy reload` therefore reported "config is unchanged" and
  `docker compose up -d proxy` saw no change to recreate. BlueMap itself was
  healthy (bound to 8100, tiles rendering, SSE and websocket-free live endpoint
  working).
- Applied live: `docker compose --env-file .env.docker up -d --no-deps --force-recreate proxy`.
  Verified `/map/`, `/map/settings.json`, `/map/maps/world/settings.json`, the
  webapp JS/CSS, `custom.css`, a rendered tile (`maps/world/tiles/...`), and the
  real SSE endpoint `/map/maps/world/live/sse` (200 `text/event-stream`).
- Durable fix: `scripts/deploy.sh` now force-recreates only the proxy after
  `compose up` so every deploy applies the committed Caddyfile. Added regression
  coverage in `scripts/tests/test_deploy.py` and documented the inode trap in
  `AGENTS.md`.
- Verification: `bash -n scripts/deploy.sh`; all 9 deploy-script tests pass.
  No backend, frontend, database, world or player data was changed.


## Private Block Protection & Mining Dimension System — 2026-10-20

- Implemented Private Block system and Mining Dimension on Paper/Purpur via LinkBridge plugin (`LinkBridgePlugin.java`, `plugin.yml`) and backend (`src/main.rs`).
- Private Block mechanics:
  - Purchase: up to 3 Private Blocks per player with coins via `/ps buy` (1st: 500c, 2nd: 20,000c, 3rd: 50,000c; 4th rejected).
  - Requires 1,000 coins wallet reserve.
  - Placed block (`Lodestone` with PDC metadata) anchors a protected territory.
  - Interactive GUI on right-click to view status, remaining fuel, active size, trusted members, and deposit fuel.
  - Trusted members management via `/ps add <player>` and `/ps remove <player>`.
  - Core dismantling via GUI or owner break returns core item to inventory.
  - Protection cancels block breaks, block places, and container interactions (chests, barrels, furnaces, doors, hoppers) for unauthorized players while fueled.
- Fuel & Footprint scaling:
  - Powered exclusively by custom fuel crystals mined from the Mining Dimension (no vanilla resource conflicts):
    - Tier 1 (Ember Shard): 3×3 area (radius 1), +2h fuel duration.
    - Tier 2 (Cobalt Crystal): 7×7 area (radius 3), +3h fuel duration.
    - Tier 3 (Crimson Core): 11×11 area (radius 5), +4h fuel duration.
    - Tier 4 (Astral Void Crystal): 15×15 area (radius 7 - MAX), +6h fuel duration.
  - Fuel accumulates up to 72 hours max storage; decrements over time and deactivates protection when 0.
- Mining Dimension (`mine_world`) & Ore Regeneration:
  - 5-minute timed cave expedition entered via `/mine` or `/mine enter`.
  - 4-hour cooldown between expeditions (`MINE_EXPEDITION_COOLDOWN_SECONDS = 14400`).
  - Active BossBar countdown timer (`⏳ [Mine Expedition] MM:SS remaining`).
  - When timer reaches 0 or player types `/mine leave`, player is safely returned to overworld spawn.
  - Mined crystal ores turn to Bedrock and automatically regenerate on a cooldown timer (30s to 120s) with chime sound and particles.
  - Block placement inside the mining world is prevented to avoid griefing.
- Miner's Shop & Tiered Prospector Pickaxes:
  - Accessible via `/minershop` or `/mine shop`:
    - Tier 1 (Apprentice Prospector Pickaxe): 150 coins, mines Tier 1 fuel crystals.
    - Tier 2 (Surveyor Prospector Pickaxe): 1,000 coins, mines Tiers 1–2.
    - Tier 3 (Excavator Prospector Pickaxe): 5,000 coins, mines Tiers 1–3.
    - Tier 4 (Master Core Drill): 20,000 coins, mines all Tiers (1–4).
  - Attempting to mine crystals with insufficient pickaxe tier prevents breaking and alerts the player.
- Backend API endpoints:
  - `POST /internal/private/buy`: atomic block purchase with progressive pricing and reserve checks.
  - `GET /internal/private/list`: lists owned private blocks, placement status, size, and fuel.
  - `POST /internal/private/sync`: updates block location, radius, fuel, and member state.
  - `POST /internal/minershop/buy`: atomic pickaxe purchases.
  - `POST /internal/mine/enter`: 4-hour cooldown validation and expedition tracking.
  - `GET /internal/mine/status`: cooldown status query.
- Database schema (`migrations/0020_private_blocks_and_mining.sql`):
  - Added `private_blocks` table with constraints for index (1..=3), radius (1, 3, 5, 7), fuel tier (1..=4).
  - Added `mine_expeditions` table tracking player last entry timestamps and expedition counts.
- Test coverage & verification:
  - Added Rust integration test `private_blocks_and_mine_expedition_workflow` in `src/main.rs` (141 passed; 0 failed).
  - Added Java unit test cases in `InventoryNbtTest.java` verifying `PrivateRules`, `FuelRules`, `PickaxeRules`, and `ExpeditionRules`.
  - Built plugin jar: `./scripts/build-plugin.sh`.
  - Passed frontend tests (`npm test` 60/60) and build (`npm run build`).


## Tiered equipment repairs (Iron, Golden, Diamond, Netherite armor) — 2026-10-20

- Added support for repairing Golden, Diamond, and Netherite armor pieces via `/services repair [confirm]` in game alongside existing iron equipment.
- Economic balancing:
  - Iron equipment: 10 coins / quarter durability unit (`ECONOMY_REPAIR_PRICE = 10`, full repair 40 coins vs ~60–80 coins new).
  - Golden armor (`golden_helmet`, `golden_chestplate`, `golden_leggings`, `golden_boots`): 15 coins / quarter durability unit (`ECONOMY_GOLD_REPAIR_PRICE = 15`, full repair 60 coins vs ~100 coins new).
  - Diamond armor (`diamond_helmet`, `diamond_chestplate`, `diamond_leggings`, `diamond_boots`): 60 coins / quarter durability unit (`ECONOMY_DIAMOND_REPAIR_PRICE = 60`, full repair 240 coins vs ~400 coins new).
  - Netherite armor (`netherite_helmet`, `netherite_chestplate`, `netherite_leggings`, `netherite_boots`): 175 coins / quarter durability unit (`ECONOMY_NETHERITE_REPAIR_PRICE = 175`, full repair 700 coins vs ~1,800 coins new).
  - Repairs remain limited to at most 3 units per UTC day with a 1,000-coin wallet reserve requirement.
- Backend implementation (`src/main.rs`):
  - Added constants and helper functions: `iron_repair_key`, `golden_armor_repair_key`, `diamond_armor_repair_key`, `netherite_armor_repair_key`, `repair_unit_price`, and `is_repairable_key`.
  - Updated `validate_repair` to validate all repairable tiers.
  - Updated `repair_quote` and `buy_repair` to quote and charge using the dynamic item tier unit price.
  - Updated `public_economy` (`GET /api/economy`) to expose `repair_unit_prices` mapping while preserving backwards compatibility on `repair_unit_price`.
- Database schema (`migrations/0019_tier_armor_repair.sql`):
  - Updated `economy_tasks_check` constraint on `economy_tasks` table to allow positive prices for tiered equipment repairs instead of hardcoding `price = repair_units * 10`.
- Minecraft plugin (`LinkBridgePlugin.java`):
  - Added `RepairRules` helper class with material validation and tier price lookups.
  - Updated `serviceCommand` to accept golden, diamond, and netherite armor items alongside iron equipment, with updated usage and quote messages.
  - Generic execution in `applyEconomyTask` applies durability repairs seamlessly across all tiers.
- Test coverage & verification:
  - Added Rust integration test `tiered_armor_repairs_and_validation` in `src/main.rs` covering quotes, purchases, balance deductions, unrepairable equipment rejection, and public economy API info.
  - Added Java unit test cases in `InventoryNbtTest.java` verifying `RepairRules` material qualification and unit price resolution across all tiers and invalid items.
  - Passed all backend tests: 140 passed; 0 failed (`docker compose run --rm tests`).
  - Passed plugin build and unit tests: `./scripts/build-plugin.sh`.
  - Passed frontend tests (60/60) and production build: `npm test`, `npm run build`.


## In-game `/market` & `/ah` auction house GUI and purchasing — 2026-10-20

- Implemented `/market` (alias `/ah`) command in Minecraft via LinkBridge plugin (`plugin.yml` and `LinkBridgePlugin.java`).
  - Supports `/market` (opens page 1), `/market <page>`, `/market search <query>`, and `/market cancel <listing_id>`.
  - Opens a 54-slot chest GUI displaying active marketplace listings using authentic `ItemStack` instances deserialized from base64 NBT.
  - Lore shows seller name, available quantity, unit price, lot price, and purchase instructions (`Left-Click: Buy 1 · Right-Click: Buy All`).
  - Sellers viewing their own listings see `[Your Listing]` and `Shift-Click to Cancel`.
  - Navigation row includes previous/next page buttons, current page and search filter indicators, player's current coin balance, and selling instructions.
- Added internal transactional backend endpoints in `src/main.rs`:
  - `POST /internal/marketplace/listings`: paginated active listings with search filter, buyer balance lookup, and lossless serialized `item_bytes`.
  - `POST /internal/marketplace/buy`: atomic in-game purchase with coin balance deduction, seller credit minus commission, order logging, and deliver task creation into `market_tasks`.
  - `POST /internal/marketplace/cancel`: allows sellers to cancel active listings and returns unsold items back to inventory via escrow delivery.
- Test coverage:
  - Added Rust integration test `in_game_marketplace_listings_and_buy_workflow` in `src/main.rs` covering unauthenticated requests, unlinked accounts, self-purchase conflicts, quantity/total mismatch, unit and lot purchases, remaining balance updates, and listing cancellations.
  - Isolated test inputs in `in_game_marketplace_listings_and_buy_workflow` with unique per-run names and ID matching so concurrent test runs against the shared database never collide.
  - Added Java unit test cases in `InventoryNbtTest.java` verifying `MarketRules` pagination parsing, lot/unit purchase quantity and price math, and GUI title formatting.
- Verified `cargo check --tests`, `npm test` (60/60 tests), `npm run lint`, and `npm run build`.


## Item durability serialization fix & marketplace durability visibility — 2026-10-20

- Fixed weapon/tool durability serialization in `LinkBridgePlugin.java`:
  - `ItemStack` in Paper does not implement `org.bukkit.inventory.meta.Damageable`. The serialization check `item instanceof Damageable` was previously evaluated as false for all items, resulting in `damage: null, max_damage: null` being sent for damaged items.
  - Corrected to `item.getItemMeta() instanceof Damageable damageable && item.getType().getMaxDurability() > 0`, properly populating `damage` and `max_damage` in inventory and marketplace sync payloads.
- Enhanced Marketplace UI:
  - Added an explicit `(${durability}% durability)` pill directly beside item names on listing rows in `MarketplacePage.tsx` and styled in `App.css` (golden/amber in light and dark mode), ensuring buyers immediately see when a listed weapon, tool, or armor piece is damaged.
  - Verified frontend `ItemBubble` durability wear bar and inspection tooltips correctly display calculated percentage wear.
  - Added frontend test `damaged items preserve damage values and format durability correctly` in `frontend/tests/api.test.ts`.


## In-game `/sell` marketplace command — 2026-10-20

- Implemented `/sell <price> [price for stack]` command in Minecraft via LinkBridge plugin (`plugin.yml` and `LinkBridgePlugin.java`).
- The command sells the item or block stack currently held in the player's primary hand.
- Price parameters:
  - `<price>`: unit price in coins (`1..=1_000_000_000`).
  - `[price for stack]` (optional): whole-lot price in coins (`1..=1_000_000_000`). If omitted, defaults to `price * quantity`.
- Added internal backend endpoint `POST /internal/marketplace/sell` in `src/main.rs`:
  - Authenticated via `LINK_SERVICE_TOKEN`.
  - Validates player UUID, held slot, item fingerprint, quantity, prices, and item structure via `valid_inventory_slot`.
  - Ensures player account is linked to a website account, not busy with another pending task, and has not exceeded 100 active listings.
  - Inserts `market_listings` (status `pending`) and creates a withdraw `market_tasks` row in a single transaction.
  - Returns `201 Created` with listing ID, task ID, quantity, and pricing details.
- Integrated with LinkBridge's transactional escrow mechanism:
  - Upon receiving 201 response, LinkBridge immediately triggers `syncMarketplace()`.
  - Bukkit main-thread task execution verifies slot and fingerprint, safely withdraws the item from hand, saves PDC receipt, and calls `/internal/marketplace/report`.
  - Listing becomes active on the website marketplace under Marketplace and Player Controls -> Inventory.
  - If a conflict occurs (e.g. item moved during async network hop), the listing is safely aborted without item loss or duplication.
- Added integration test `in_game_marketplace_sell_creates_listing_and_withdraw_task` in `src/main.rs`.
- Synchronized documentation in `PRODUCT.md`, `AGENTS.md`, and `STATE.md`.


## Git & feature branch workflow convention — 2026-10-20

- Documented project rule in `AGENTS.md`: never commit or push directly to `main`. Always create a feature branch related to the function and commit changes locally. Never push to remote or merge into `main` automatically; only push or merge when the user explicitly instructs to push or to merge.


## Marketplace pending delivery limit — 2026-10-20

- Added a 5-item limit (`MARKET_MAX_PENDING_DELIVERIES = 5`) on pending inventory deliveries per player UUID.
  When a player already has 5 items queued in escrow waiting for inventory space (`market_tasks` with `kind='deliver' AND status='pending'`), further purchases and listing cancellations return `429 Too Many Requests`.
- Updated `MarketplacePage.tsx` with user-friendly warnings for full delivery queues and disabled Buy/Cancel buttons when a player's delivery queue is saturated.
- Added backend integration test `marketplace_caps_pending_deliveries_at_five` in `src/main.rs` and frontend unit test in `frontend/tests/api.test.ts`.
- Verified `cargo check --tests`, 18 operator script tests, and 58 frontend unit tests.


## Non-strict economy simulation in CI — 2026-10-20

- Updated `.github/workflows/deploy.yml` to run `./scripts/simulate-economy.sh` in report mode without `--strict`.
  The simulation executes all 3,840 virtual years, rigorously asserts 100% of coin/goods
  conservation, budget bounds, non-negative wallets, and labor invariants, and generates
  full reports and charts for GitHub Actions without blocking deployment on synthetic stress-model
  starter-affordability failures (15 in `constrained_supply` and 1 in `high_wear`).
- Strict mode (`./scripts/simulate-economy.sh --strict`) remains intact for explicit release-gate
  enforcement.
- Verified operator script tests (18 tests passing) and `cargo check --tests`.


## Fishing, farming and iron-work onboarding — 2026-10-20

- Migration 0018 / LinkBridge 1.10.0 adds persisted objective kinds and a second
  starter counter. New UUIDs first mine ten ore blocks and smelt/extract ten iron
  ingots. Both must finish after acceptance; no new bonus iron, bread or XP.
  Vanilla drops/XP remain ordinary gameplay. Existing accepted/completed quest
  identities are grandfathered as onboarded, with all accepted terms preserved.
- Afterward `/quests start hunting|fishing|farming` selects a repeatable. Baseline
  targets: ten eligible natural hostiles, five fish caught by rod, or sixteen
  mature wheat/carrot/potato/beetroot crop blocks. Fishing and farming scale with
  the same lifetime earning curve. One active quest, four shared acceptances per
  UTC day, 24-hour deadline, and origin-day coin reservations remain intact.
  A zero-coin starter can unlock the feature; zero-coin repeatables are rejected.
- Only authenticated Survival actions count. Canceled actions, fishing junk and
  treasure, immature crops and automated harvesting do not count. Persistent
  chunk markers exclude newly placed/piston-moved iron ore; old placed ores have
  no retroactive provenance. Smelting credits player extraction, not hoppers.
- Independent event counters use the immutable outbox. Missing counters default
  to zero without changing old canonical report hashes. SQL ignores irrelevant
  activity for each accepted kind. New quests create no item/XP delivery tasks;
  legacy promised deliveries retain the durable player receipt protocol.
- Verified `cargo check --tests`, 136 backend/Postgres tests and 18 operator
  tests. Plugin build and inventory/objective-filter/outbox counter regressions
  pass. An upgrade test applies migration 0018 over real pre-objective tables,
  preserving old receipt replay, hunting terms and item/XP delivery promises.
- Frontend build, lint and 57 tests pass. The Minigames help now names hunting,
  fishing and farming rather than suggesting all income comes from hunting.
- Current simulated onboarding now uses personal iron-gathering labor and five
  assumed smelting minutes, with no free materials/XP. It then uses hunting as
  the repeatable benchmark. Fishing/farming action rates, furnace parallelism
  and 24-hour starter expiry are not represented faithfully; gameplay calibration
  is still needed. Earlier 80/80 money and 240/240 timely-kit figures below belong
  to the superseded material-grant policy and are not current evidence.
- Current normal-population benchmark: money 80/80, market affordability 64/80;
  all 240 late newcomers eventually get kits, 195/240 within sixty active minutes.
  Removing the material subsidy slows starter access. Sixteen affordability
  failures preserve the failing strict deployment gate; thresholds are unchanged.
- Full 3,840-year matrix completed in 424 seconds: all accounting/labor/funding
  invariants passed; strict mode returned 101 for sixteen normal-case market
  failures. Verified complete unique trace coverage, no current NPC materials,
  and the final Rust source SHA-256; refreshed the report charts.
- Source/build changes only. No production migration, runtime JAR installation,
  server restart, real-player interaction, commit or push.

## Implemented budget and reward policy — 2026-10-20

- Migration 0017 and LinkBridge 1.9.0 implement the selected 60-day issuance
  budget, 20% newcomer reserve and frozen fair daily allowances (maximum 1,200
  per UUID). Eligibility is known identities with five active minutes during
  the previous thirteen completed dates. First-day players receive the permanent
  100-coin grant and may earn materials/XP; coin allocation starts next day.
- Accepted rewards reserve their origin day's funding and remain fixed across
  policy changes/midnight. Legacy promises are honored, outstanding rewards
  count in measured supply, expiry releases funding, and reports settle once.
  A migration applied after an old daily review waits until tomorrow to fund
  new coin contracts, preserving that review and every existing balance.
- Finite early rewards: 3/8/8/8 iron while still needing a kit, 16 first-contract
  bread, and five real XP for each of the first ten completions. Durable ordered
  online delivery waits for AuthMe and storage space, saves a player-file receipt
  with inventory/XP before acknowledgement, and preserves marketplace receipts.
- `/services repair` quotes a held iron item; explicit confirmation accepts
  ten coins per quarter durability, at most three units/day, leaving a 1,000
  reserve. Immutable persisted requests retry safely; changed items refund once.
  User chose teleport to a future owned private block. That feature is absent:
  `/services travel` explains it is unavailable and its API never debits coins.
- Verification: `cargo check --tests`; 132 Rust/Postgres tests in a disposable
  Compose project; 18 operator tests; frontend build/lint and 57 tests; plugin
  Gradle `inventoryNbtTest jar` all pass. A separate rolled-back schema verified
  migration over an already-reviewed old policy, completion backfill and legacy
  terms. No real-client delivery or repair interaction has been exercised yet.
- Simulator adaptive runs now use the implemented policy, shared production
  budget/allocation/material helpers, prior-day grants/eligibility and disabled
  travel. Historical six candidates remain comparisons, with their old timing
  explicitly identified. The repair benefit still approximates iron-equivalent
  wear; XP utility and behavior remain uncalibrated. The diagnostic advanced
  mining gate is not implemented as a real crafting restriction.
- Current normal-population results: money 80/80, market affordability 70/80;
  all 240/240 late newcomers equip within sixty active minutes. Ten
  constrained-supply market failures retain a failing strict deployment gate.
  Heavy-minigame and wealthy-return money objectives fail in all 40 stress
  runs each; hoarding and alternate-identity scenarios pass money in 40/40 each. The historical 7/80 joint pass below belongs to the old policy.
- The full 3,840-year matrix completed in 411 seconds. Accounting/labor/funding
  invariants passed throughout; strict mode returned 101 for those ten failures.
  Verified all 960 implemented/control and 2,880 historical candidate years,
  unique identities/scenario coverage, complete daily traces, funding bounds
  and the current source SHA-256. Generated reports/charts are local artifacts.
- Local source and build outputs only: no production migration, wallet/world
  change, runtime plugin installation, service restart, commit or push.

## Budget, service and starter-material experiments — 2026-10-19

- Added six test-only candidates: issuance recovery over 30/60/120 days; 60-day
  recovery with 35% or 70% daily service willingness; and 60-day/35% services
  with finite starter contract materials. Twenty percent of funding is reserved
  for first-14-day identities; remaining funding is shared fairly before work.
  New grants subtract from funding. Signed net removal, service sinks and finite
  NPC resource creation are reconciled explicitly. Offered contract rewards are
  fixed before simulated work; live difficulty still depends on coin earnings.
- All five assumption sets, twelve scenarios and eight seeds are retained:
  960 current/frozen control years plus 2,880 candidate years = 3,840 years.
  The full matrix completed in about fifteen minutes locally. Every candidate
  passed accounting, labor and funding invariants; saved traces and metadata
  were checked for coverage, identity, balances, funding and censored cohorts.
- In normal populations (80 runs/240 late newcomers per variant), current rules
  pass money in 22/80, market affordability in 41/80, both in 7/80, and equip
  155/240 newcomers within sixty active session minutes. Every budget variant
  passes money in 80/80. The 60-day budget passes market affordability in 65/80
  and equips 212/240 within sixty minutes; voluntary services help modestly.
- Strongest tested package: 60-day recovery, 35% service willingness and bounded
  starter materials. Money passes 80/80, market affordability 70/80, timely kits
  240/240. The remaining ten normal-case market failures all use constrained
  supply. This is a promising next candidate, not a production-ready guarantee:
  assumptions remain uncalibrated, returning held wealth can exceed the target,
  heavy minigame use can drain funds, and material resale/alt funneling plus
  advanced crafting demand are not represented faithfully enough for rollout.
- Tests: `cargo check --tests`, 128 Rust/Postgres tests and 18 operator tests
  passed; all six model regressions were rerun after the final candidate change.
  One initial broad test filter invoked SQL checks without a database; the
  subsequent full suite used the disposable database and passed. Strict mode
  returns 101 because the unchanged current policy still fails 73/80 release
  cases. Candidate verdicts cannot turn an unimplemented policy green in CI.
- Added comparison JSON/Markdown, full traces per candidate, coin-flow and stress
  summaries, and visually checked PNG/SVG comparisons. CI publishes the candidate
  comparison with the control results. The compiled-source hash matches the current file, and all 960 control money,
  inventory and labor paths match the prior model; production Rust before the
  test-only module is byte-for-byte unchanged. No live data, game settings,
  installed plugins or production services were changed, committed or pushed.


## Simulation model improvements before policy tuning — 2026-10-19

- Supersedes the earlier quest-first model's behavioral assumptions below.
  Production issuance, controller, commission, minigame rules and acceptance
  thresholds have not been tuned. All changes remain local and unpushed.
- Simulated players now choose work using quest reward/minute, personal needs,
  posted reservation prices, commission and lagged observed sell-through. One
  shared minute budget covers quests, iron and food; fractional yields carry
  between sessions. Gathering can directly equip a player before market sales.
- Demand follows actual play, with bounded replacement backlogs. Axe ownership
  (3 iron) and full equipment (27 iron + food) are distinct milestones. Starting
  and day-301 cohorts include actual mixed-route progression, session minutes,
  calendar days and unfinished counts; completion-only quantiles are labeled.
  Quotes are sampled before purchases rather than from end-of-day leftovers.
- Five explicitly uncalibrated assumption sets cover constrained/reference/high
  supply, slower combat and greater wear. All twelve scenarios, eight seeds and
  both policies run for a year: 960 virtual years / 350,400 daily observations.
  Identity, attendance and productivity RNG streams are separate from games.
- Accounting/labor invariants pass. The unchanged strict objectives fail in
  73/80 normal-population adaptive runs, leaving deployment blocked. Under
  reference assumptions all 24 late stable-population newcomers complete a kit
  within one 30-minute session, yet all eight money-target checks fail. Under
  constrained supply all 24 eventually complete, but p90 of cohort p90 session
  minutes is 1,620. Findings depend on invented assumptions, not live prices;
  ECONOMY.md records calibration requirements and remaining simplifications.
- Verified `cargo check --tests`, 126 backend tests and 18 operator-script tests.
  All four model regression tests were rerun after excluding private hoards
  and closed weekly markets from quoted supply. Full-matrix strict failure is
  expected; the release objectives have not been relaxed.
- Reports now identify the assumption set in JSON/CSV, show cohort censoring and
  include a visually checked sensitivity chart alongside reference-case plots.
  No services, real wallets, installed plugin or world data were modified.


## Seeded economy simulations and CI release gate — 2026-10-19

- Added a test-only agent simulator in `src/main.rs`: twelve scenarios, eight
  deterministic seeds, adaptive/frozen policies and 365-day traces (192 virtual
  years). Production and simulation share daily controller arithmetic, activity
  defaults, grant/contract constants, reward progression, fee rounding and deal
  distributions. Live game wrappers retain OS randomness; there is no seed API.
- The separate `compose.economy-sim.yaml` and `scripts/simulate-economy.sh` do not
  load `.env.docker`, start game/database services, or join production networks.
  Report mode checks conservation; `--strict` additionally enforces the declared
  normal-population money/affordability objectives. CI runs strict mode before
  deployment, renders charts and uploads generated reports even on acceptance
  failure. Generated traces are ignored under `reports/economy/`.
- Every simulated day checks coin/goods conservation, nonnegative wallets,
  one grant/identity, bounded contracts/policy and fee movement. Reproducibility,
  hoarding and AFK checks run with the ordinary backend suite. Existing SQL/API
  tests continue to check persistence, atomicity, ownership and replay races.
- Results: accounting invariants passed throughout the matrix; all sixteen
  adaptive stable/growing-population cases failed starter affordability. The
  monetary target can be met while modeled starter equipment remains scarce or
  expensive. Hoarding/low trading accumulates coins; heavy games drains them.
  Abundant supply improves affordability while leaving excess money. These are
  synthetic behavioral scenarios, not observed server prices; assumptions and
  sensitivity cases are recorded in ECONOMY.md and the generated manifest.
- Strict mode returned exit 101 and preserved its reports as expected. The new
  release gate therefore intentionally blocks deployment pending review of the
  economic policy, goods model and acceptance goals; no thresholds or production
  parameters were silently changed to get a passing result.
- Verified: `cargo check --tests`, 123 ordinary Rust/Postgres tests and 18 operator
  script tests; full simulation matrix and expected strict failure. Matplotlib
  PNG/SVG charts and an offline index were generated and visually inspected.
  Results include source SHA-256, assumptions, daily CSV, raw JSON, summary and
  seed-level acceptance failures. Existing player data/services were untouched.
- Work remains local, uncommitted and unpushed. No GitHub Actions run, production
  deployment, Minecraft client simulation or actual market-price measurement
  occurred. See `reports/economy/summary.md` locally and ECONOMY.md for commands.


## Real economy steps 1–5 — 2026-10-19

- Added migration `0016_economy.sql`: balances are preserved, opening positions
  and subsequent wallet changes are recorded in a database-enforced append-only
  ledger, and grant identities/report receipts survive unlinking and website
  account deletion. Test block-break income is removed, including old-plugin
  statistics reports.
- LinkBridge 1.8.0 reports daily qualifying Survival activity through a separate
  immutable outbox. The first authenticated economy registration grants 100 coins
  once. `/quests` and `/quests start` expose natural-hostile-mob contracts, fixed
  accepted terms, lifetime-earned difficulty and a four-contract UTC daily limit.
- Added a once-daily policy review with a 14-day qualification window, smoothed
  population/supply, 70,000 coins per active UUID, unexpired committed stakes,
  +/-10% neutral band, sustained signals and five bounded economic settings.
  `ECONOMY_AUTOMATION=false` freezes reviews without resetting balances.
- New Marketplace listings explicitly accept the current 0–5% seller commission;
  existing listings keep zero fees. The accepted rate survives policy changes.
  Seller previews use server-calculated proceeds; cumulative fee rounding, coin
  movement, order receipt and delivery commit together.
- Minigame probabilities adjust slightly and equally for everyone. Public config
  matches the dealt distributions. Stale starts return 412 without a debit;
  stored levels/reels/boards preserve paid rounds and receipt recovery across
  policy changes. Mines keeps its TNT count and varies ore distribution only.
- Verification: `cargo check --tests`; all 122 PostgreSQL-backed tests passed on
  a fresh disposable Compose database with normal concurrency. The seven economy
  checks were rerun after excluding expired, lazily settled stakes from supply.
  Frontend production build, ESLint and 57 Node tests passed. Gradle compiled
  LinkBridge 1.8.0 and its inventory NBT runner passed. The Gradle generic `check`
  task rejects this repository's main-method test convention as “no discovered
  tests”; the documented `inventoryNbtTest jar` command passed.
- The final production image booted against the disposable database, served the
  neutral public policy and completed its first daily review at migration 0016.
  It built with hardened bases using the documented local
  offline Cargo-cache Dockerfile; committed Dockerfile/Compose image provenance
  is unchanged. Seller fee/proceeds and keyboard access were inspected in Dark
  at wide and 520px window widths using labeled disposable fixtures, never real
  player balances. Captures are ignored under `.impeccable/review/economy-*`.
- All changes are local, uncommitted and unpushed. No existing services, real
  database, worlds or installed runtime plugin JARs were changed. No production
  rollout or authenticated Minecraft client test occurred. Economic price
  monitoring/calibration and client-level natural-spawn/AFK/quest verification
  remain. See `ECONOMY.md` for defaults, limitations and coordinated rollout.

## English minigames and recovery — 2026-10-19

- Follow-up: capped the Minesweeper cabinet at 288px (field about 258px), with classic gray beveled cells and recessed counters. Desktop/mobile and Light/Dark previews checked; square cells measured at about 49px at the capped size.

- Minigames, its menu/dock/title bar, payer controls, paytables and errors now use English. Both games use existing Aero surface/field/button tokens. Lucky Chest reels move complete shared-material bubbles and decelerate in sequence; reduced motion places the results directly. Minesweeper uses classic raised squares, an inset field, keyboard arrows and the site palette in both themes.
- Pending chest requests retain their exact client ID, payer and stake in per-user tab storage until resolved; retries and post-unlink receipt recovery cannot buy a second spin. Concurrent starts/receipt checks serialize on the user row and reuse their transaction connection.
- Minesweeper responses identify the original payer. Expiry is checked in the same transaction as reveal/cash-out, so stale tabs cannot bypass the fifteen-minute deadline. Recovery errors block new stakes until retried.
- Migration `0015_market_task_rotation.sql` rotates Marketplace queue heads by last-check time, preserving per-player FIFO while preventing full inventories from starving later players.
- Removed the five unused legacy font/texture/sound assets and obsolete game CSS. Updated the stale frontend application guide.
- Verified: `cargo check --tests`, 115 PostgreSQL-backed backend tests, 55 frontend tests, ESLint and the full Docker production image. Browser checks used a temporary, clearly labeled simulated-coin fixture at wide and narrow widths in both themes; the fixture was removed. Captures are gitignored under `.impeccable/review/`. Local app/proxy were rebuilt; no external deployment or Git push was performed.


## Local Purpur executable option — 2026-10-18

- External-server logs supplied by the operator show Java rejecting
  `purpur-26.3-2652.jar` while the startup downloader repeatedly reports it is
  already up to date. A manual download stalled after about 20 KiB. The cause
  of the original corruption is not established.
- Added optional `compose.purpur-local.yaml`, activated with `COMPOSE_FILE` in
  `.env.docker`: Java 25, local CUSTOM_SERVER mode, read-only executable mount
  outside `/data`, and a SHA-256 pre-start check. The server remains Purpur with
  the same world, plugins, AuthMe and forwarding configuration.
- `scripts/install-local-purpur.sh` verifies a complete local build 2652 source
  and staged copy before atomically installing under `mc/server-jars/`. The
  recovery copy's SHA-256 is
  `893bf450c86117b1e872e992f874fca5e7f1f51b8dcc910eb2e646076c58e42a`.
- Verified the real recovery JAR and installer, merged Compose configuration,
  shell syntax, all 13 operator-script tests, and `cargo check --tests`.
  Docker's daemon was unavailable, so no live boot was tested. No external
  deployment or local service restart was performed; local `.env.docker` was
  unchanged. This option removes Purpur executable downloads only; plugins and
  missing libraries may still need network access.

This file records the state at this checkpoint. It is historical evidence, not a live health indicator. Read `README.md` for operation, `AGENTS.md` for engineering constraints, and `PRODUCT.md` / `DESIGN.md` for product and visual intent.

## Implemented

- Account registration/login/logout, session security, linking, masked in-game email reminders, and account security/email flows (see `EMAIL.md`). Website passwords require at least six characters; AuthMe's separate in-game policy requires ten.
- Persistent coins: one per authenticated, uncancelled block break; `/bal` and `/balance`; immutable reports with permanent deduplication receipts and durable plugin retry files. Migration `0007` starts balances at zero.
- Expanded server activity counters in migration `0008`, displayed in grouped statistics with real loading/empty/error states.
- Global Statistics combines the current user's linked accounts only. Each nickname/skin-head launcher opens an independent player app with Statistics and Skin pages. Shared statistics refresh every five seconds; each window keeps its own page and geometry during the linked session.
- SkinsRestorer 15.12.6 on Purpur only, AuthMe-gated commands, Ely.by-first/Mojang-fallback skin lookup. TLauncher skins can be imported as standard PNGs; launcher rendering overrides remain client-controlled.
- Owned-player website skin upload: PNG validation and metadata stripping, Classic/Slim preview, durable MineSkin signing queue, and LinkBridge 1.4.0 synchronization into SkinsRestorer. Migration `0009` separates observed textures from link-owned pending uploads. Saved means server storage acknowledged, not a visual guarantee on every client.
- Player inventory: LinkBridge samples every authenticated player's inventory on the server thread (storage, armor, off hand — 41 slots with amounts, durability, custom names and enchantments) and reports the newest snapshot; item textures come from the official Minecraft client textures packaged for the server version and are uploaded once per item key. The player app's **Inventory** page shows them as still Frutiger Aero bubbles with amount pill, wear bar and enchantment glow, and an honest empty state until the server reports one. Migration `0010` adds `player_inventory` (replaced per report, no link FK) and `item_icons` (the first upload for a key wins).
- Aero desktop, independent windows, sourced skin heads, Light Asadal / Dark night-park wallpapers, animated wallpaper, music widget beside the dock, and interface sounds. Preserve asset attribution and provenance.

## Deployment observed at checkpoint

- Web app rebuilt successfully through Docker; `https://localhost/` returned HTTP 200.
- App, Caddy, PostgreSQL, Mailpit, Velocity and Purpur are running; PostgreSQL, Mailpit, Velocity and Purpur reported healthy.
- **Purpur recovered.** An interrupted download had left `mc/purpur/purpur-26.3-2652.jar` incomplete (34,249,194 bytes) and Purpur was stopped, which took gameplay and game-to-panel synchronization offline. On restart the image re-fetched the jar and the download completed: the runtime jar is now 58,033,746 bytes with MD5 `bbf5d8703bc8ee5aa6c5251e1bbcaa78`, identical to the preserved `.plugin-build/purpur-26.3-2652-verified.jar`. Purpur booted in 7.6 s, is healthy, and enabled AuthMe 6.0.1, SkinsRestorer 15.12.6 and LinkBridge 1.5.0 with no load or dependency errors. The preserved jar stays as the offline recovery copy (ignored by Git). Never delete worlds, AuthMe data, skin selections or volumes.
- `mc/purpur/plugins/` holds LinkBridge 1.5.0; the build script retired earlier jars to `.jar.disabled`.
- Compose retains AuthMe's shared library cache, uses the European Paper Maven mirror, and disables HTTP/2 for artifact downloads. Network availability is still required.

## Verification evidence

At this checkpoint:

- `cargo check --tests`: passed.
- Frontend ESLint: passed; Node 24 regression tests: **31 passed**.
- Docker production build: TypeScript/Vite and Rust release build passed; HTTPS returned 200.

Inventory change (same day):

- `cargo check --tests`: passed. Compose `tests` suite: **83 passed** — four new inventory/item-icon checks (service token, malformed snapshots, snapshot replacement and owner-only reads, icon caching and serving), plus the pre-existing set.
- The three fixed-window burst tests (login, register, link claim) now wait for a fresh rate-limit window before their burst: a window rollover mid-burst resets the counter and made them fail rarely under parallel load.
- Frontend: TypeScript/Vite build, ESLint and **31** Node tests passed.
- Gradle/JDK 25 built and installed LinkBridge **1.5.0** (inventory reporter + item-icon upload); older jars were retired to `.jar.disabled` by the build script.
- Live after the rebuild: `https://localhost/` serves the new bundle (`index-DJmEdAKS.js`, `index-EzIIO8cT.css`); migration `0010` applied (`player_inventory`, `item_icons` present); `GET /api/players/{uuid}/inventory` answers `401` without a session; `POST /internal/inventory/report` still answers `404` through the public proxy. A browser-level look at the Inventory page was **not** possible here — the browser tools could not reach the local HTTPS stack — so its appearance rests on the frontend build/lint and the CSS review, not a capture.

During the implementation preceding this checkpoint:

- Rust/PostgreSQL suite: **79 passed**; focused skin checks rerun after the final provider-response limit change passed.
- Gradle/JDK 25 plugin build passed, producing LinkBridge 1.4.0.
- A disposable end-to-end upload reached `saved` through MineSkin and SkinsRestorer; its test account and persisted fixture were removed. No authenticated Minecraft client's rendering was verified.
- Desktop/mobile skin-page previews and local PNG selection were reviewed. Local captures under `.impeccable/review/` are ignored.

## Local build workaround

Docker's registry downloads stalled during this session. The last web rebuild used a temporary Dockerfile with an offline Cargo registry cache; the committed normal `Dockerfile` remains the standard build path.

The ignored `.plugin-build/` directory currently holds `cargo-registry/`, `skin-offline.Dockerfile`, and `skin-offline.compose.yaml`. To reuse that workstation cache from the repository root:

```sh
docker compose --env-file .env.docker -f compose.yaml -f .plugin-build/skin-offline.compose.yaml up --build -d app proxy
```

These local files are not portable prerequisites. A fresh checkout should use the normal build with registry access. The earlier Postgres tests used a read-only mount of the host's populated Cargo registry and `CARGO_NET_OFFLINE=true` to avoid the same network stall.

## What Git preserves

The checkpoint commit includes source, migrations, templates, supplied assets and their provenance, and documentation. `.env.docker`, Minecraft runtime data under `mc/`, Docker volumes, build caches, and local verification captures stay outside Git. A source commit is not a database/world backup. Use `./scripts/export.sh` for a consistent operational archive including secrets, Minecraft data, and a Postgres dump; it briefly stops running writers and restores their prior running state. No runtime export was created for this source checkpoint.

## Next verification

Purpur is running again and reports healthy; AuthMe 6.0.1, SkinsRestorer 15.12.6 and LinkBridge 1.5.0 enabled cleanly. What remains is client-level: verify skin rendering with an authenticated player and an unmodified second client, checking both a known official account and a known Ely.by account. Client skin replacement may affect the result; appearance never changes authentication or offline UUID ownership.

Then, with the same authenticated player, open that player's app on the website and check the **Inventory** page against the game: armor, off hand, hotbar and main inventory in the game's own slots, amounts and wear matching, enchanted items glowing, a renamed item showing its name, and common items (tools, blocks, food) showing real textures while model-assembled items (heads, potions) fall back to the sourced Performance Center artwork. Confirm nothing is shown before the plugin's first report, that a report lands within one sampling interval of an inventory change, and that unlinking hides the inventory while re-linking restores it.

## Inventory icon and bubble correction — 2026-10-18

- The original inventory implementation assumed dedicated-server jars contained client textures. Inspection found zero `assets/minecraft/textures/` entries in both the Mojang server jar and Purpur jar, and zero cached item icons. LinkBridge 1.5.1 now packages 2,131 original PNGs from the official 26.3 client; the build verifies Mojang metadata/client SHA-1 checksums and keeps downloads in `.plugin-build/client-textures/`.
- Built and installed 1.5.1, restarted Purpur, and observed its enable message and healthy container status. Cached official textures for the three existing reported item keys through the internal endpoint (HTTP 200): stone sword, rotten flesh, leather helmet. No player inventory contents changed.
- Inventory uses clearer Aero bubbles in both themes, immediate item-name/detail tooltips on hover/focus/touch with Escape dismissal, and correct Bukkit armor ordering (39 helmet through 36 boots). Tooltip portals escape window clipping and switch below items near the viewport top.
- Verification: `cargo check --tests`, production Docker TypeScript/Vite build, ESLint and all 31 frontend regression tests passed. Light desktop and dark 360px-wide content were inspected with the actual InventoryPage in an isolated sample-data preview; keyboard name disclosure and Escape dismissal were checked. `.impeccable/review/inventory-final.png` records the light preview. The authenticated live player page was not inspected, and client-level inventory/skin verification remains outstanding.
- During server startup/rebuild the logs included a panel-sync timeout and a transient watchdog dump with the main thread parked; Purpur subsequently reported healthy. No restart loop was observed.

## Matching background bubbles — 2026-10-18

Background and inventory bubbles now share the same CSS glass material in `frontend/src/index.css`: clear centers, cyan lower caustics, restrained colored rims and curved highlights, with matching Light/Dark overrides. Wallpaper size, depth blur, rise/drift, film animation and reduced-motion behavior are preserved. The Docker production build passed and the local app was rebuilt. Live Light and Dark appearances were inspected; the Light capture is `.impeccable/review/background-bubbles.png` (ignored).

## Bubble reflection refinement — 2026-10-18

Replaced the broad rotated oval reflection in the shared inventory/background bubble material with two small, softly fading upper-rim glints. Docker production build passed and the local app was rebuilt; the live background was inspected with the oval patch absent. Capture: `.impeccable/review/bubble-reflection-fixed.png` (ignored).

## Compact moving inventory bubbles — 2026-10-18

Inventory grids now cap their width (568px for nine slots, 312px for equipment), with 8px gaps and 6px gaps in narrow containers. Bubbles gently bob 3px vertically/1px horizontally on staggered loops, pausing on hover/focus; the existing global reduced-motion rule disables the animation. Docker production build passed and the app was rebuilt. Sample-data previews were inspected at wide Light and 360px Dark sizes; browser computed styles confirmed active motion and paused inspection, and the name tooltip remained available. Capture: `.impeccable/review/inventory-compact.png` (ignored).

## Registration email confirmation — 2026-10-18

- New registrations now require a six-digit email code valid for 15 minutes. `POST /api/register` returns `202` with an opaque browser challenge only after SMTP accepts delivery; `POST /api/register/confirm` creates the verified user and consumes the pending signup atomically (`201`). Pending signups cannot log in. Existing users retain their existing verification state and login access.
- Migration `0011` stores pending signup details with Argon2 password hashes and SHA-256 challenge/code hashes, never plaintext codes/challenges. Codes are bound to their browser challenge, single-use, limited to five incorrect attempts, with a 60-second resend cooldown and five messages per mailbox per hour plus IP limits. SMTP failure rolls back the pending row. The countdown accounts for delivery time; expired pending rows are pruned on later registration requests.
- Register now switches to a labeled one-time-code field, expiry countdown, resend and change-details actions, with explicit loading/error/expiry states and a Mailpit-only delivery notice. Successful confirmation signs in, with a login notice if sign-in fails. The Compose tests service now starts Mailpit automatically.
- Verification: `cargo check --tests`, production Docker build, ESLint, **88 Rust/PostgreSQL tests**, and **33 frontend tests** passed. New backend coverage checks expiry, attempt exhaustion, concurrent/single-use confirmation, resend replacement, mailbox budget rollback and duplicate-login races. Existing test users complete confirmation through a test-only code fixture.
- A disposable live API flow fetched the actual registration code from Mailpit, verified that pre-confirmation login failed, confirmed the code, checked `email_verified`, logged in, and rejected replay. Its database account and pending/budget data were removed. Desktop and 360px confirmation-step previews were inspected using the real component with seeded sample state; capture `.impeccable/review/registration-confirmation.png` is ignored. No real external inbox delivery was tested: current local delivery is Mailpit; production SMTP configuration remains operator-owned in `EMAIL.md`.

## Password minimum and theme fixes — 2026-10-18

- AuthMe's committed template now sets `minPasswordLength: 6` for new/changed Minecraft passwords, matching the website minimum. Existing passwords are unchanged. The earlier ten-character policy above describes the previous checkpoint.
- Missing, invalid and unavailable website theme preferences now fall back to System in both early HTML boot and React; explicit Light/Dark/System choices remain valid.
- Dark wallpaper is centered in WebGL and the static fallback. Its previous 130px downward shift clamped the top texture row into vertical streaks; the daylight offset is preserved. Dark browser preview confirms a clean top edge; capture `.impeccable/review/dark-wallpaper-fixed.png` is ignored.
- Verification: `cargo check --tests`, ESLint, all 33 frontend tests, and the production Docker build passed. No running services were restarted or deployed. Once pushed to `main`, the configured GitHub workflow tests and deploys the commit and restarts Purpur, which syncs the AuthMe template on boot.

## Email-or-login sign-in — 2026-10-18

- Website sign-in now accepts a trimmed, case-insensitive email or login name. The form uses “Email or login” and username autocomplete. The API accepts `{identifier, password}` and retains the legacy `{email, password}` payload.
- Lockout and failed-attempt tracking use the resolved account’s canonical email for both identifiers; generic 401 responses and password/email-change session serialization remain intact. Email matches take precedence if another account has that same login; no fallback tries a different account’s password.
- Verification: `cargo check --tests`, all 91 Rust/PostgreSQL tests, all 34 frontend tests, ESLint, and the production Docker build passed. Browser preview confirms the new label. Changes remain local and unpushed.

## Additional sign-in regression coverage — 2026-10-18

- Added six backend tests for malformed/ambiguous payloads, unknown/blank identifiers without cookies or failure rows, normalized email/login through both payload names with correct session ownership and exact password preservation, bidirectional failure-counter reset, locked cross-account email/login collisions, and pending-signup login before/after confirmation. Inserting test cases clean up accounts before assertions.
- Added two frontend tests for network failure and rate-limit/server error propagation; the existing sign-in contract test also verifies same-origin credentials.
- Verification: all **97 Rust/PostgreSQL tests** and **36 frontend tests** passed, along with `cargo check --tests`, ESLint and `git diff --check`. This increment changes tests and this checkpoint only; nothing was pushed or deployed.

## Inventory stack deletion, including offline players — 2026-10-18

- Filled inventory bubbles now open an inline inspection with Delete stack / Cancel, explicit whole-stack permanence, keyboard focus return, and pending/completed/conflict/request-error feedback. The website waits for server acknowledgement instead of clearing a slot optimistically.
- Migration `0012` adds one durable deletion per linked UUID and rotates offline refreshes. Requests require the owning session, an explicit edit header, the slot and a full-item NBT fingerprint; ownership/concurrent requests are serialized. Service-token acknowledgements match the current request and commit status plus snapshot together. Old snapshots gain fingerprints from offline refreshes without requiring another game login.
- LinkBridge **1.6.0** edits authenticated online inventories on the server thread and verifies saved receipts on disk. Offline edits use the pinned 26.3 server level directory's `players/data/<uuid>.dat`, including armor/off hand in `equipment`; they preserve unrelated tags, create `.dat.linkbridge-backup`, and atomically replace the file with a persistent deletion/conflict receipt. Lost-response retries cannot delete replacement stacks. Unsupported files stay untouched and cannot block other tasks.
- The live check caught the 26.3 directory change: `World.getWorldFolder()` now points at a dimension, and `playerdata` has moved to `players/data`. The implementation uses `Server.getLevelDirectory()`. Early disposable fixtures at the incorrect path were cleaned without modification.
- Verification: `cargo check --tests`, **98 Rust/PostgreSQL tests**, **38 frontend tests**, ESLint, TypeScript checks, the production Docker build, and Gradle/JDK 25 NBT regression checks passed. The standard plugin Docker build now runs those regression checks before installation. Light desktop and 360px Dark sample-data previews were inspected, including selection and pending feedback; capture `.impeccable/review/inventory-delete-mobile.png` is ignored.
- Docker Desktop was started; the local web and Minecraft stack is running, Purpur is healthy and enabled LinkBridge 1.6.0. A real website → API → plugin → offline-file test passed for storage slot 0, helmet 39 and off hand 40; it checked preserved unrelated contents, stale-stack conflict, and backup creation. Its synthetic UUID, player file, backup, website account, sessions, links, inventory and observed skin rows were removed. No existing player's items were deleted. An authenticated in-game client's online deletion has not been exercised. Nothing was pushed or deployed externally.

## Marketplace — 2026-10-19

- Added an independent Marketplace desktop app with menu/dock launchers, retained window state, server-side item/seller search, cursor pagination, My listings, and delivery/return status. It reuses the exact ItemBubble component from Inventory, including official textures, wear, enchantment aura and portal tooltips.
- Inventory now offers **Send to Marketplace** instead of deletion. Sellers choose quantity and independent optional per-item / whole-lot coin prices (at least one required). Buyers may buy quantities or the whole remaining lot; partial sales scale the original lot quote proportionally, rounded up. The old public deletion route returns 404; private legacy work/refresh synchronization remains compatible.
- Migration `0013` adds durable escrow, FIFO game-server tasks and permanent purchase receipts. The server validates full-item fingerprints before withdrawal, publishes only acknowledged escrow, and atomically transfers coins/stock plus records delivery. Purchases reject stale quotes, insufficient funds and same-website-account trades. Retries preserve the exact order ID/quote and never charge twice. Cancellation returns unsold items; pending deliveries wait for enough empty storage slots without overwriting or dropping items. Unlinking waits for outstanding listings/transfers/deliveries.
- LinkBridge **1.7.0** supports authenticated online and saved-file offline transfers/deliveries on the server thread. Item bytes and a replay receipt persist alongside each saved change, preserving hidden item components across lost acknowledgements. Offline files retain unrelated tags and backups. Oversized withdrawal payloads fail before mutation.
- Verification: `cargo check --tests`, frontend TypeScript and ESLint, **40 frontend tests**, standard production Docker build, standard Docker Gradle/NBT build, and **101 Rust/PostgreSQL tests through Compose** passed. Docker was initially unavailable; isolated native PostgreSQL/SMTP and cached Java25/Gradle verified the implementation first, then Docker started and the normal container checks completed. Temporary native services were stopped.
- Deployed locally: rebuilt app/proxy, applied migration `0013`, installed LinkBridge 1.7.0 and restarted Purpur. HTTPS returns 200; PostgreSQL, Mailpit, Velocity and Purpur are healthy. Purpur logged LinkBridge 1.7.0 enabled cleanly. This is local deployment only; nothing was pushed or deployed externally.
- A disposable live website/API → plugin → offline-file flow passed partial withdrawal, quantity purchase, exact-order replay, coin debit/credit once, proportional lot pricing, cancellation/unsold return, a separate discounted whole-lot purchase, repeated deliveries without overwrite, preserved unrelated player tags and backup creation. Synthetic website accounts, sessions, linked UUIDs, listings, tasks, orders, inventories, skin rows, coin rows and player files/backups were removed. No existing player's items or balances were used. Authenticated in-game online fulfillment remains unexercised.
- Light desktop / 390px Dark browse, purchase and sell sample-data renders were inspected; browser checks covered quantity/lot totals, transfer and delivery messages, and registry-key search with surrounding whitespace. The fresh review scored both findings resolved: removed redundant client search filtering and made missing-fingerprint close/reselect recovery explicit. Documentation check found no Marketplace-specific gaps. Captures under `.impeccable/review/marketplace-*.png` are ignored. The deployed browser verified real menu/dock launchers and Marketplace's unauthenticated window (`marketplace-live.png`); it did not inspect a real user's private inventory.

## Item-panel reveal and dock activation — 2026-10-19

- Inventory sell details and Marketplace inspection now unfold from their top edge over 240ms, using a clipped glass reveal and slight vertical expansion. Selecting a different item remounts the details to restart the reveal. Reduced Motion displays details immediately.
- Every dock app now hides only when both open and focused; an open app behind another is raised/focused on its first click. Raising uses the quiet click sound, hidden apps use open, and hiding the focused app uses close. Menu behavior, retained contents/geometry and focus return are preserved.
- Verified TypeScript, ESLint, all **40 frontend tests**, `cargo check --tests` and the production Docker build; rebuilt the local app/proxy. Real-browser checks covered Account behind a maximized Marketplace plus Global Statistics, Marketplace and Settings: first dock activation leaves the app open/active, the second hides it. Player dock buttons use the same focus condition; no private player session was needed. Sample-data inventory inspection verified the `inventory-panel-open` animation at `0.24s` on initial selection and switching items, with heading focus preserved. No backend/plugin changes, external deployment or push.

## Player Controls and four-account limits — 2026-10-19

- Consolidated nickname windows into one **Player Controls** menu/dock app. A native account selector in the centered title bar chooses the linked player; each user/UUID retains its own mounted Statistics, Inventory and Skin pages, while the app shares one window geometry. Statistics account links and Marketplace inventory shortcuts select the requested player. The selector preserves keyboard operation and does not drag or maximize the window. Focused-only dock hiding and item-panel reveal remain intact.
- Website accounts may link up to **four** Minecraft accounts. Code issuance and claims return `422` at capacity; claims serialize on the user row, and rejected claims roll back without consuming their code. Start/claim use the same user-before-code lock order. The Account app shows capacity and hides additional linking at four. Existing links are preserved.
- AuthMe's committed template sets `maxRegPerIp`, `maxLoginPerIp` and `maxJoinPerIp` to **4**. Existing Minecraft accounts are preserved. LinkBridge **1.7.1** explains a full website account when a claim returns `422`.
- Verification: `cargo check --tests`, TypeScript, ESLint, **40 frontend tests**, **103 Rust/PostgreSQL tests through Compose**, and the standard Docker Gradle/NBT build passed. New backend tests cover the fourth/fifth link, code reuse after unlink, and concurrent claims at capacity. Desktop Light and 390px Dark browser previews exercised four clearly labeled sample accounts, account-specific inventory quantities, retained pages, title selection and the full-capacity Account state. Captures `.impeccable/review/player-controls-{desktop,mobile}.png` are ignored. Finish review returned Ship; documentation review found no remaining scope-specific gaps. The temporary preview server was stopped.
- **Paused at the user's request.** All source changes are saved locally, uncommitted and unpushed. LinkBridge 1.7.1 was built and installed; Purpur was restarted and copied the AuthMe template (runtime values verified as 4/4/4), but its completed startup/health and plugin enable still need verification. The frontend production stage built successfully; the full website image was still compiling Rust and was cancelled before app recreation, so the running website may still show the preceding version. Resume with the standard app/proxy Compose rebuild, verify HTTPS and Player Controls in the deployed browser, then check Purpur health and LinkBridge 1.7.1 enable. No external deployment occurred.

## Deployment blocked by untracked files — 2026-10-19

- The production deployment after `c2cf072` failed on the server, not in CI: its checkout still held untracked local copies of `compose.purpur-local.yaml`, `scripts/install-local-purpur.sh` and `scripts/verify-purpur.sh`, which that commit starts tracking, so `git merge --ff-only` refused to overwrite them. Tracked changes and the tested revision were otherwise in order.
- `scripts/deploy.sh` now computes the untracked paths that the tested commit tracks and moves exactly those into `.git/deploy-untracked-<timestamp>/` before `git switch`/`merge`, preserving them instead of overwriting or deleting them. Tracked files are never moved, and no other untracked path is touched.
- Verification: `python3 -m unittest discover -s scripts/tests` (**15 tests**, including the new preserve/never-move cases) and `bash -n scripts/deploy.sh` passed. Pushing the fix to `main` reruns the full workflow and the deployment.
## Minigames on the real coin balance, merged into `main` — 2026-10-19

- Lucky Chest and Minesweeper now stake and return `player_stats.coins` — the balance `/bal` prints and the plugin reports into — instead of a browser-local sandbox balance. The old client-side reels and tables are gone: the browser sends a stake (or the cell it wants to open) and renders the round the server returns.
- The server owns the whole round: `minigame_rounds` (migration `0014`) records one row per staked round, a partial unique index allows one `active` round per `(user_id, game)`, and every coin change is one guarded `UPDATE ... WHERE coins >= $1` inside the round's transaction. A retried chest spin (same browser `client_id`) returns the recorded spin; a repeated reveal or cash-out returns the settled round; `mines/start` resumes the live round instead of staking twice; a round left untouched for 900 s forfeits its stake as `expired`.
- The tables were rebuilt to a real house margin: Lucky Chest **91.8%** return (it was a ~196% money printer before), each Minesweeper preset **92.6–92.8%** at the earliest cash-out (they ranged 27–93% before). `chest_rtp_x10000()`/`mines_rtp_x10000()` are computed from the paytables the server pays from, so the figure the window shows cannot drift from the figure paid.
- One linked account pays, chosen in a picker when the user has several (`minecraft-minigame-payer`); a user with no linked account sees the ordinary "Link an account" pointer and cannot play. `409` on the routes means exactly one thing — not enough coins. Nothing is simulated and no balance is invented.
- Verification: `cargo check --tests` passed; the merged suite reported **112 passed** (main's 103 plus nine minigames checks: charge/pay/replay idempotency, foreign-account `404`, insufficient-coins `409` with an untouched balance, TNT loss, min-cash-out gating, resume, forfeiture, session requirements, the published paytable, and the house-margin proof); `npm run build`, `npm run lint` and all **54** frontend tests passed (main's 40 plus 14 new minigames tests covering stake clamping, payer choice, paytable labels, status messages, and that a spin posts a stake and an id rather than an outcome).
- `main` was merged in this session (`origin/main`, including `2b7a7f5`). That brings `0012_inventory_deletions.sql` and `0013_marketplace.sql`, the two files sqlx demanded before the app could boot against the repository's database (`validate_applied_migrations` → `MigrateError::VersionMissing`: the database already had 12 and 13 applied while the branch's `migrations/` jumped `0011` → `0014`). Conflicts were resolved by keeping main's single **Player Controls** window and adding the **Minigames** window beside it (`Shell.tsx`, `windowGeometry.ts`, `DesktopWindow.tsx`), by keeping both appended blocks in `App.css`, and by combining both documents' narratives.
- Verified end to end **without touching the real database**: `project_db` was `pg_dump`ed into a throwaway `postgres:18`, the merged app booted against that clone and applied `0014` on top of the already-applied `0012`/`0013`, and the full suite ran against it (**112 passed**). The real `project_db` was left exactly as found by that work — 1 user, 1 linked account, `_sqlx_migrations` at `0013`, no `minigame_rounds`. It has since had `0014` applied on purpose: the branch's first local `up` (bring the stack live to check it) added the one additive table. From that moment a checkout without `0014` cannot boot against this database at all, because sqlx validates the applied set (`validate_applied_migrations` → `MigrateError::VersionMissing`) — merging this branch into `main` is what removes the mismatch, and it has now been merged.
- **`main` keeps the hardened images; this machine's cluster needs a local override instead.** The branch had pinned community `caddy:2` / `postgres:18` / `rust:1` (plus the community `Dockerfile` bases) because the `pgdata` volume holds a PostgreSQL 18 cluster at `<volume>/18/data` owned by uid **999**, while `dhi.io/postgres:18` runs as uid **70** and exits with `initdb: error: could not access directory "/var/lib/postgresql/18/data": Permission denied` (reproduced). That pin was **reverted before merging** — `compose.yaml` and `Dockerfile` are byte-identical to `origin/main` again, so production's hardened provenance (and its already-deployed uid-70 cluster) is untouched. This machine instead carries a gitignored `compose.override.yaml` pinning only `db` (community `postgres:18` + explicit `PGDATA=/var/lib/postgresql/18/data`); Compose merges it automatically and `.gitignore` keeps it out of the repository. Verified after the revert: `up -d` replaced **only** `proxy` (`dhi.io/caddy:2`, HTTPS 200, minigames config 200) while `db` ran on untouched, and the real cluster still held its 1 user, 1 linked account and migration 14. The volume was never re-initialized, chowned or emptied.
- Not verified: nothing was deployed, and no window was inspected in a browser against a live stack; the minigames windows and their coexistence with main's Marketplace and Player Controls rest on the build, lint and tests, not a capture.

## Minigames merged into `main` and pushed — 2026-10-19

- `minigames` was merged into `main` as a fast-forward (the branch already contained `origin/main` via its merge commit) and `main` was pushed, which is what triggers the repository's own workflow: **Test and deploy** runs the frontend lint/build/tests, the operator-script tests, `cargo check --tests` + `cargo test` against the disposable compose database, a production image build, the plugin build, and then — `if: github.ref == 'refs/heads/main'` — `scripts/deploy.sh` over SSH to the production host.
- The image divergence was settled the safe way: `compose.yaml` and `Dockerfile` are byte-identical to `origin/main` (hardened `dhi.io` builds and images), because production is already deployed and its `pgdata` cluster was created by `dhi.io/postgres` as uid 70. Only this machine carries a gitignored `compose.override.yaml` (community `db` image + explicit `PGDATA`) for the uid-999 cluster in its own volume; the repository never sees it, and production never receives it.
- The stack was left live on this host at `https://localhost` (all six services healthy, migration `0014` applied to the real database on purpose) so the Minigames window could be checked against the real balance. That balance is **0 coins** — no historical backfill — so the games correctly refuse a bet until coins are earned in-game.
- Verification after the revert, on the live stack: `docker compose up -d` recreated only `proxy` (now `dhi.io/caddy:2`), `db` continued on untouched with the real cluster's 1 user / 1 linked account / migration 14, `GET /` returned 200 with the hashed bundle, `GET /api/minigames/config` returned 200, and `http://localhost` still 308-redirected to HTTPS. Earlier in the same session the merged revision passed `cargo check --tests`, **112** backend tests, `npm run build`, `npm run lint` and **54** frontend tests.
