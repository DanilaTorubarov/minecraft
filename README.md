# Rust, React, and PostgreSQL with Docker

A web panel for a Minecraft server: an account system with server-side sessions and account linking, plus the game stack itself.

The `proxy` container runs Caddy and terminates HTTPS — it is the only web service exposed to the outside (ports 80 and 443). The `app` container runs the Rust server on port 8080 and serves the built React frontend; it is reachable only through the proxy. The `db` container runs PostgreSQL 18. PostgreSQL data is stored in the `pgdata` Docker volume, separately from the PostgreSQL installation on your Mac. The `velocity` and `purpur` containers run the Minecraft proxy and backend (see [Minecraft server](#minecraft-server)), with **AuthMe** doing in-game authentication and the **LinkBridge** plugin (source in `plugin/`) bridging `/website` to the panel.

## What is in this repository

| Path | What it is |
| --- | --- |
| `src/main.rs` | The entire Rust API — authentication, security, linking, statistics, coins, minigames, and skin uploads |
| `migrations/` | The SQL schema, applied by sqlx automatically on startup |
| `frontend/` | The React 19 + Vite app — `/register`, `/login`, and the `/cabinet` account page, plus the desktop's Account, Statistics, Minigames and Settings windows |
| `Dockerfile` | Multi-stage build: npm build → cargo build → slim runtime image |
| `compose.yaml` | The whole stack — `proxy`, `app`, `db`, `velocity`, `purpur`, and a `tests` profile |
| `Caddyfile` | TLS termination, security headers, and the `/internal/*` block |
| `mc-config/` | Minecraft config templates, committed — mirrors the server directory 1:1 |
| `plugin/` | The LinkBridge Java plugin source, built by `./scripts/build-plugin.sh` |
| `scripts/` | `mc-init.sh` (first-run setup), `build-plugin.sh`, `export.sh` (move to another host) |

`mc/` (the Minecraft world, plugins, secrets and player accounts), `target/`, `frontend/dist/`, `.plugin-build/` and `plugin/build/` are all generated locally and never committed.

## Saved project state

See [STATE.md](STATE.md) for the dated implementation checkpoint, verification evidence, local deployment status, and outstanding recovery work. [AGENTS.md](AGENTS.md) records engineering rules; [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md) describe product and interface decisions.

## Before starting

Start Docker Desktop and sign in to Docker Hardened Images:

```sh
docker login dhi.io
```

If this host already holds a `pgdata` volume created by the **community** PostgreSQL image (uid 999), the hardened `db` image cannot open it (`Permission denied` on `/var/lib/postgresql/18/data`). Do not edit `compose.yaml` — production runs the hardened images. Put the exception in a gitignored `compose.override.yaml`, which Compose merges automatically on this machine only:

```yaml
services:
  db:
    image: postgres:18
    environment:
      PGDATA: /var/lib/postgresql/18/data
```

Never delete, empty or chown the volume to avoid this. See [AGENTS.md](AGENTS.md) "Traps".

On a fresh clone, copy the example file, then edit `.env.docker` to use your own password in both places:

```sh
cp -n .env.docker.example .env.docker
```

The file starts with these values:

```dotenv
POSTGRES_PASSWORD=replace_with_a_private_password
DATABASE_URL=postgresql://postgres:replace_with_a_private_password@db:5432/project_db
SITE_ADDRESS=localhost
```

`db` is the PostgreSQL container's hostname inside Compose. If your password contains URL-special characters, URL-encode them in `DATABASE_URL`. `SITE_ADDRESS` is the public hostname the proxy serves (see below). Do not commit `.env.docker`.

`./scripts/mc-init.sh` then adds two generated secrets to the same file on first run — `VELOCITY_SECRET` (proxy ↔ backend forwarding) and `LINK_SERVICE_TOKEN` (in-game plugin → panel). The Minecraft version and memory are pinned with `MC_VERSION` and `MC_MEMORY`. `.env.docker.example` documents every knob, including the rate-limit defaults below.

## Build and start

For GitHub tests followed by automatic SSH deployment to Ubuntu, see
[DEPLOYMENT.md](DEPLOYMENT.md).

Run these commands from this project directory:

```sh
docker compose --env-file .env.docker up --build -d
docker compose --env-file .env.docker ps
```

On macOS, run `./scripts/trust-localhost.sh` once after the proxy starts, then open <https://localhost>. The helper verifies the running server against Caddy's public root certificate and adds SSL trust for `localhost` in your user keychain. macOS may request keychain authorization. Reload or restart your browser after installing trust. To see startup messages:

```sh
docker compose --env-file .env.docker logs -f proxy app db
```

Press `Ctrl+C` to stop following logs; the containers keep running.

### Rebuild only the website

```sh
docker compose --env-file .env.docker up --build -d app proxy
```

This rebuilds the Rust API and React bundle without starting the Minecraft services. Database migrations run automatically when the app starts. The normal build uses the committed `Dockerfile`; temporary offline-cache overrides used on this workstation are described in `STATE.md` and are not prerequisites for a fresh clone.

## HTTPS and domains

Caddy terminates TLS on ports 80 and 443 and forwards to `app`; it is the only container published to the host. Redirects and certificates are automatic. With `SITE_ADDRESS=localhost` Caddy issues a local certificate from its own CA. Set `SITE_ADDRESS` to a real domain (for example `panel.example.com`) and Caddy obtains a public Let's Encrypt certificate — as long as that domain's DNS points at this host and ports 80 and 443 are reachable. Certificates are kept in the `caddy_data` volume, so they survive restarts.

Local CA trust is configured per computer, outside Docker. On macOS use `./scripts/trust-localhost.sh`; on other systems, import the public `/data/caddy/pki/authorities/local/root.crt` from the `proxy` container into the OS/browser trust store. Never export the CA private key. Reinstall trust if the `caddy_data` volume is replaced. To remove the macOS trust later, delete the matching “Caddy Local Authority” certificate in Keychain Access (the helper prints its SHA-256 fingerprint).

The image runs as a non-root user, which cannot bind ports below 1024, so Caddy listens on 8080/8443 inside the container and Compose maps host 80/443 onto them. You should not need to change this.

## Database schema

This container starts with an empty `project_db`; it does not copy tables or users from PostgreSQL on your Mac. The app applies the SQL migrations in `migrations/` automatically on startup (via sqlx), so there is no manual setup step.

To inspect the tables, open `psql` inside the database container:

```sh
docker compose --env-file .env.docker exec db psql -U postgres -d project_db
```

Use `\dt` to list tables and `\q` to leave `psql`. To add or change a table, add a new numbered file to `migrations/`; never edit a migration that has already been applied.

## Rate limiting and lockout

The auth endpoints are protected in two independent ways. Both store their state in Postgres, so limits survive restarts.

- **Per IP** (`/api/login`, `/api/register`): a fixed-window counter returns `429 Too Many Requests` with a `Retry-After` header once an address goes over its budget. The client IP comes from `X-Real-IP`, which Caddy sets from the real connection and overwrites on every request, so it cannot be spoofed.
- **Per account** (`/api/login` only): repeated wrong passwords put that account into an exponential backoff (15m, 30m, 1h … capped at 24h). A locked account is answered with the **same `401`** as a wrong password, so the endpoint never reveals which accounts exist. A successful login clears the counter, and the lock expires on its own — a user can never be permanently locked out.

Before the first lockout, failures older than `LOCKOUT_WINDOW_SECONDS` reset the counter.
After a lockout, each subsequent failed attempt after expiry increases the backoff;
only a successful login clears that escalation history.

The defaults, all overridable in `.env.docker`:

```dotenv
LOGIN_IP_LIMIT=20              # login attempts per IP per window
LOGIN_IP_WINDOW_SECONDS=900    # 15 minutes
REGISTER_IP_LIMIT=10           # registrations per IP per window
REGISTER_IP_WINDOW_SECONDS=3600
LOCKOUT_THRESHOLD=10           # failures before an account backs off
LOCKOUT_WINDOW_SECONDS=900     # failures older than this stop counting
LOCKOUT_BASE_SECONDS=900       # first lockout duration
LOCKOUT_MAX_SECONDS=86400      # cap (24h)
```

Because Docker Desktop adds a NAT hop, every request reaches the app from the same address while running locally, so the per-IP limit behaves like a global one on your Mac. On a real server Caddy sees each client's true address.

## Account linking

A web account is paired with a Minecraft account **without ever sharing a Minecraft password**. The panel stores only the pairing (web user ↔ Minecraft UUID); the in-game auth plugin keeps owning the Minecraft credentials.

```
logged-in user            in-game plugin              panel
──────────────            ──────────────              ─────
POST /api/link/start
  → one-time code (8 chars, 5 min)

                          player runs /website link <code>
                          POST /internal/link/claim
                          Authorization: Bearer <LINK_SERVICE_TOKEN>
                          { code, uuid, username }
                                                      marks the code used,
                                                      stores the pairing
GET /api/link  → linked accounts
DELETE /api/link/{uuid} → unlink
```

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| `POST` | `/api/link/start` | session cookie | `200` `{code, expires_in}`; `422` at four linked accounts |
| `GET` | `/api/link` | session cookie | `200` `{accounts: [...]}` |
| `DELETE` | `/api/link/{uuid}` | session cookie | `204`, or `404` if not yours |
| `POST` | `/internal/link/claim` | service token | `200`, `404` bad/used/expired code, `409` UUID already linked, `422` website account already has four links, `401` bad token, `503` not configured |
| `POST` | `/internal/link/status` | service token | `200` linked, `404` not linked, `400` malformed UUID, `401` bad token, `503` not configured |
| `POST` | `/internal/link/email` | service token | `200` plain-text masked email, `Cache-Control: no-store`; `404` unlinked, `400` malformed UUID, `401` bad token, `503` not configured |

Details:

- Codes are **single-use**, expire after `LINK_CODE_TTL_SECONDS` (default 300), and only the newest code per user stays valid. Only the code's SHA-256 is stored, never the code.
- The alphabet omits characters that are easy to misread in-game (`I`, `L`, `O`, `U`, `0`, `1`).
- `/internal/*` is **blocked at the proxy** (it answers `404` to the internet) and additionally requires the service token. `scripts/mc-init.sh` generates `LINK_SERVICE_TOKEN` in `.env.docker` (the plugin sends it as a bearer token); with it unset the endpoint answers `503`.
- Link claim and status answer with **bare status codes and no body**. Email reminders and balances return plain text; skin synchronization uses JSON.
- An unknown, used, or expired code all return the same `404`, so codes cannot be probed.
- Website accounts can link up to **four** Minecraft accounts. Both code issuance and redemption return `422` at capacity. Claims serialize on the website user row, so concurrent codes cannot exceed four. Capacity rejection leaves the code usable after unlinking; existing links are not deleted.
- Linking a UUID that is already linked returns `409` and does **not** consume the code, so the player can retry.

The knobs, overridable in `.env.docker`:

```dotenv
LINK_CODE_TTL_SECONDS=300         # how long a code stays valid
LINK_CLAIM_IP_LIMIT=30            # claim requests per IP per window
LINK_CLAIM_IP_WINDOW_SECONDS=60
```

Every in-game claim arrives from the game server's single container address, so `LINK_CLAIM_IP_LIMIT` is effectively a **server-wide** budget for Minecraft linking rather than a per-player one. The plugin's own per-player cooldown protects it.

## Statistics

The game server measures what it can see in game — play time, blocks placed and broken, mobs killed, deaths, distance traveled, items crafted and picked up, fish caught, damage dealt and taken, logins, items enchanted, tools broken, animals bred, times slept and advancements — and reports the growth to the panel. The panel stores it per in-game UUID. **Global Statistics** shows combined totals for the current user’s linked accounts; one **Player Controls** app manages a selected linked account using a nickname/skin-head picker in its title bar. Launch it from the menu or dock, or choose an account from the global account list. “Global” means your linked accounts combined, never server-wide statistics. The panel never measures the game itself; it only shows what the server reported.

All statistics apps share one server snapshot, refreshed every five seconds while the page is visible and when it regains focus or links change. Global Statistics and Player Controls close, minimize, and reopen independently. Player Controls keeps one geometry, while each linked player retains its own selected page and mounted contents across account switching. The five menu and dock launchers scroll horizontally when the viewport is narrow. Skin heads use the server-reported texture hash through [MCHeads](https://mc-heads.net/). Unknown textures and loading failures use sourced Performance Center artwork. Requests send no referrer.

```
authenticated player in game      LinkBridge plugin             panel
──────────────────────────        ───────────────               ─────
time online, blocks placed/broken,
mobs killed, deaths, distance,
crafting, fishing, damage, ...
                                  every five seconds, on quit,
                                  and on shutdown:
                                  POST /internal/stats/report
                                  Authorization: Bearer <LINK_SERVICE_TOKEN>
                                  { report_id, players: [{ uuid, username,
                                    play_seconds, blocks_placed,
                                    blocks_broken, mobs_killed, ... }, ...] }
                                                    adds the deltas to
                                                    player_stats
GET /api/stats  → the user's linked accounts, each with its stats
                  (null until the server has reported any), plus a
                  summary across all of them
```

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| `POST` | `/internal/stats/report` | service token | `200`, `400` malformed entry or empty batch, `401` bad token, `503` not configured |
| `GET` | `/api/stats` | session cookie | `200` `{accounts: [...], summary: {...}}`, `401` without a session |

Details:

- Reports carry **deltas since the last accepted report** with an immutable UUID `report_id`. Statistics, coins, and the receipt commit in one transaction. Identical retries return `200` without adding anything; reusing an ID with different content returns `409`. The plugin saves each outgoing report to `mc/purpur/plugins/LinkBridge/pending-report.json` before sending and replays it after restart. A sudden crash can still lose activity that has not yet been saved into a report.
- Fractional metrics keep their fractions across flushes: distance is reported in **hundredths of a block** (`distance_cm`) and damage in **hundredths of a heart** (`damage_dealt` / `damage_taken`). The panel stores exactly what is reported; the website converts for display (blocks/kilometres, hearts).
- Distance counts walking, sprinting, swimming and flying; a single move event over 8 blocks is a teleport, portal or server correction and is skipped rather than counted as travel.
- Damage is the final damage the game applied (after blocks, armour and effects), so a cancelled or fully absorbed hit adds nothing.
- Activity only counts after a player has authenticated with AuthMe — standing at the login gate is not playing.
- `first_seen_at` / `last_seen_at` are when the panel first heard, and last heard, from the game server about a UUID; they are not in-game timestamps.
- The report endpoint is **not** rate limited, for the same reason as `link_status`: at most one batched request per flush, from the game server's single container address. New report fields are additive: a plugin that predates them keeps working, because a missing counter is accepted as zero rather than a rejected batch.
- Statistics survive unlinking: the rows are keyed by UUID with no foreign key, so unlinking hides them and re-linking the same in-game name restores them.
- `stats-report-seconds` (default `5`) in `mc-config/purpur/plugins/LinkBridge/config.yml` sets the flush interval.

## Registration email confirmation

New website accounts require a six-digit email code valid for **15 minutes**.
`POST /api/register` sends the code and returns `202` with an opaque browser
challenge; no user is created yet. The registration page shows the code field,
expiry countdown, and resend action. `POST /api/register/confirm` consumes the
code and creates a verified account (`201`), then the page signs in. Wrong,
expired, used or exhausted codes return `400`; a taken email/login returns `409`.
Codes allow five incorrect attempts, and resending waits 60 seconds with a
five-per-mailbox hourly limit. Existing IP limits also apply. Delivery failure
returns `503` without creating an account. Existing users retain login access.

The local setup delivers to [Mailpit](http://localhost:8025), not a real inbox.
For real email delivery, configure SMTP as described in [EMAIL.md](EMAIL.md).
Migration `0011` stores only hashed pending credentials; confirmation is atomic.

## Inventory

Player Controls also has an **Inventory** page for its selected player: what that player is carrying, as the game server last saw it — armor, off hand, hotbar and main inventory, with every item in its own bubble over the desktop scenery. The panel draws the layout the game reports; it never invents one.

```
authenticated player in game      LinkBridge plugin             panel
──────────────────────────        ───────────────               ─────
hotbar, main inventory, armor,
off hand — amounts, durability,
custom names, enchantments
                                  sampled every five seconds on
                                  the server thread; a new
                                  snapshot on change, and a
                                  periodic re-send:
                                  POST /internal/inventory/report
                                  Authorization: Bearer <LINK_SERVICE_TOKEN>
                                  { uuid, username, slots: [ 41 entries ] }
                                                    replaces
                                                    player_inventory
                                  item textures read from the
                                  packaged official client assets, once per
                                  item key:
                                  POST /internal/items/icons
GET /api/players/{uuid}/inventory → the 41 slots, each with its
                                    stored icon and full-item fingerprint, or null slots
                                    until a snapshot arrives
```

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| `GET` | `/api/players/{uuid}/inventory` | owning session | `200` `{username, updated_at, slots, marketplace, deletion}`, `Cache-Control: no-store`; `404` if not owned |
| `POST` | `/api/players/{uuid}/inventory/marketplace` | owning session + `X-Marketplace: trade` | `{slot, fingerprint, quantity, unit_price, lot_price}` → `202` queued; `400` invalid input/header, `409` stale/busy, `404` not owned, `429` 100 active listings for this player |
| `POST` | `/internal/inventory/deletions` | service token | up to 25 pending deletions or rotating refresh tasks, including offline players; blocked by public proxy |
| `POST` | `/internal/inventory/deletions/report` | service token | `{uuid, request_id, status, slots}` → `200` acknowledgement and fresh snapshot in one transaction; `409` stale/already-completed request; blocked by public proxy |
| `POST` | `/internal/inventory/report` | service token | `200`, `400` malformed snapshot, `401` bad token, `503` not configured; blocked by the public proxy |
| `POST` | `/internal/items/icons` | service token | `200`, `400` malformed batch, `401` bad token, `503` not configured; blocked by the public proxy |

Details:

- A snapshot is **current state, not a delta**: it replaces the previous one for that UUID. Rows are keyed by UUID with no foreign key, so an inventory survives unlinking (it is invisible while unlinked) and re-linking restores it.
- The layout is the game's own: storage `0–35` (hotbar `0–8`, main `9–35`), armor `36–39` (boots, leggings, chestplate, helmet) and off hand `40`. A null entry is an empty slot.
- Each item carries its registry key, amount, wear (`damage` and `max_damage` together, drawn as a bar that turns amber and then red), a name when the player renamed it, and its enchantments — an enchanted item's bubble glows.
- Item icons come from the official Minecraft client textures packaged for the server version, so a picture always matches the version that produced the snapshot, and are stored once per item key. An item with no readable texture (some items are assembled from models rather than a single PNG) shows the sourced Performance Center artwork with its name; nothing is ever generated.

The LinkBridge build downloads the official Minecraft **26.3 client** from Mojang’s version manifest, verifies the metadata and client SHA-1 checksums, and packages only item/block texture PNGs. Dedicated-server jars omit these textures. The cache lives in `.plugin-build/client-textures/`; the installed plugin carries the textures when moving the stack. Keep `textureVersion` in `plugin/build.gradle` aligned with `paper-api` and the backend version. See [plugin/TEXTURES.md](plugin/TEXTURES.md). Inventory item names appear on hover, keyboard focus and touch; Escape dismisses the tooltip.
- Until the game server has reported anything for a UUID, `slots` is `null` and the page says so. No item, number or inventory is invented.
- The page refreshes every five seconds while it is visible. `inventory-report-seconds` (default `60`) in `mc-config/purpur/plugins/LinkBridge/config.yml` is how often an unchanged inventory is re-sent; a change is reported as soon as it is sampled.
- The report endpoint is **not** rate limited, for the same reason as `link_status` and the statistics report: it is reachable only from the game server's single container address, behind the service token, at a bounded rate — one snapshot per inventory change plus a periodic refresh per player.

Select a filled bubble to inspect the stack, choose a quantity, and **Send to Marketplace**. Set a per-item price, whole-lot price, or both. Prices are independent positive whole coins, each at most 1,000,000,000. A listing becomes active only after the game server confirms removal of those exact items. The page keeps the last known inventory until acknowledgement. Changed stacks are rejected; no removal is inferred from `202`. The former public deletion endpoint now returns `404`; private deletion synchronization remains to finish previously accepted work and rotate saved-file reads.

LinkBridge **1.7.0** processes inventory and marketplace work in its serialized inventory pass (every ten seconds). Authenticated online players use Bukkit on the server thread and save immediately, with the saved receipt verified on disk. Offline players use the level directory's `players/data/<uuid>.dat` (the pinned 26.3 layout), including modern equipment. The plugin preserves unrelated tags, keeps `<uuid>.dat.linkbridge-backup`, and atomically replaces files. Full-item SHA-256 fingerprints cover hidden components, including container contents. Marketplace withdrawal receipts preserve the full serialized escrow item alongside the inventory change, so a lost acknowledgement cannot remove or deliver it twice. Very large item payloads (over 60,000 base64 characters) fail withdrawal before mutation; unsupported or corrupt files remain untouched and pending. Pending tasks never imply that a player is online.

Linked saved inventories rotate through a read at most once per 30 seconds (up to 25 per pass, oldest checked first), filling fingerprints without requiring a player to join. Online players awaiting AuthMe authentication are skipped. No saved file means no invented snapshot.

## Marketplace

Open **Marketplace** from the menu or dock. Browse confirmed escrow using the inventory's bubbles, search by item or seller, and choose a listing to inspect its prices. **My listings** includes your waiting, active, unsuccessful and closed listings. Search runs on the server and cursor pagination returns up to 50 listings per page; other users see only active offers and seller nicknames, never raw item data or private inventory.

Sellers review server-calculated proceeds and the current 0–5% commission before listing; that rate is fixed for the listing. Pre-economy listings retain zero commission. Buyers pay the displayed price.

Choose a linked buyer, then either a quantity at the unit price or all remaining items at the whole-lot price. Both may be offered at different rates. After a partial sale, the remaining whole-lot quote is `ceil(original lot price × remaining / original quantity)`. For example, 12 items at 10 coins each may also have a whole-lot price of 90 coins: buying 3 individually costs 30; the remaining 9-item lot costs 68. Buyers confirm the exact remaining amount and total; stale quotes return `409`, insufficient funds `422`. A website account cannot buy its own listings, even through another linked player.

The purchase transaction locks the listing and both coin balances, charges once, credits the seller minus the accepted commission, reduces remaining stock and records a durable delivery. The browser retains the order ID and original quote after a lost response for safe retry. Accepted purchases are final. **Cancel listing & return items** removes an active offer and queues its unsold quantity for return to its seller. Transfers, purchases and returns survive restarts in migration `0013`.

Deliveries wait for sufficient **empty storage slots**, splitting over native stack limits when needed. They never overwrite items, use armor slots or drop overflow. The recipient can stay offline; online delivery requires AuthMe authentication. The website distinguishes waiting from game-server-confirmed delivery. While a player has waiting/active listings or pending deliveries, unlink returns `409` to prevent abandoning escrow. Finish or cancel the offers and let deliveries complete first. Escrow and trade receipts are durable; do not remove them manually.

All writes below require `X-Marketplace: trade` as well as a session. Reads use `Cache-Control: no-store`. Service-token routes remain blocked by Caddy.

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| `GET` | `/api/marketplace?mine=false&q=&cursor=` | session | `{listings, deliveries, next_cursor}`; at most 50 listings and 100 latest own deliveries |
| `POST` | `/api/marketplace/{id}/buy` | session + trade header | `{request_id, buyer_uuid, quantity, pricing, expected_total, expected_remaining}`; `pricing` is `unit` or `lot`, request ID is a UUID; `202` accepted/replayed, `409` changed/self-trade/conflicting receipt, `422` insufficient coins, `404` unknown listing/not-owned buyer |
| `POST` | `/api/marketplace/{id}/cancel` | seller session + trade header | `202` unsold return queued; `409` no longer active, `404` not owned |
| `POST` | `/internal/marketplace/sync` | service token | up to 25 tasks; only the oldest pending task per player |
| `POST` | `/internal/marketplace/report` | service token | matching task ID, UUID, status, lossless item bytes for withdrawals and 41-slot snapshot; `200` acknowledged/replayed, `400` invalid data, `409` out of order |

Upgrade the API/frontend and plugin together:

```sh
./scripts/build-plugin.sh
docker compose --env-file .env.docker up --build -d app proxy
docker compose --env-file .env.docker restart purpur
```

The builder runs NBT regression checks and installs LinkBridge 1.7.0. Database migrations apply on app startup. Existing inventory snapshots become editable after a fingerprint refresh; a stopped game server leaves transfers and deliveries pending.

## Coins

Each Minecraft UUID owns one persistent wallet shared by the server and website. Test block-break income has been removed. After upgrading, the first authenticated visit grants 100 coins once; `/quests start` begins a mine-and-smelt-ten-iron starter objective; afterward `/quests start hunting`, `fishing` or `farming` selects a repeatable coin quest. `/quests` shows progress. New quests give no bonus iron or XP; existing promises are honored. Contracts pay automatically, become harder as lifetime quest earnings grow, and retain their accepted reward. Existing balances are preserved, and balances/grant history survive unlinking.

[ECONOMY.md](ECONOMY.md) describes the append-only ledger, daily activity qualification, 70,000-coin target, gradual controller, 0–5% seller commission, small public minigame probability adjustments, configuration, protocol and coordinated API/plugin rollout. These are monetary controls; price stability still needs observation and tuning.

- `/bal` and `/balance` show the authenticated player's own balance. No target-player argument is accepted. The command flushes pending earnings before reading the database and reports unavailability if syncing fails, rather than showing a stale number. It shares the `/website` cooldown.
- Statistics shows coins for each linked Minecraft account and the total across those accounts. Earnings also accumulate before linking, survive unlinking, and appear when the UUID is linked again.
- The plugin syncs every **5 seconds** by default, on quit, on shutdown, and when checking `/bal`; the open website refreshes every **5 seconds**. These intervals mean the website can trail a block break by about 10 seconds under normal conditions. `stats-report-seconds` remains configurable.
- `POST /internal/balance` accepts `{uuid}`, requires the service token, and returns the integer balance as plain text with `Cache-Control: no-store`. A UUID with no earnings returns `0`; malformed UUIDs return `400`, bad credentials `401`, and missing server configuration `503`. Caddy blocks the endpoint publicly, like all `/internal/*` paths.
- Retry receipts are permanent, preventing duplicate payment after timeouts or restart. Do not remove them or the plugin's pending report during normal operation. If the panel is unavailable, activity stays in memory and a prepared report stays on disk; unsaved activity can be lost on a hard crash. Normal shutdown attempts a final flush.

Build the plugin with `./scripts/build-plugin.sh`, rebuild the API with `docker compose --env-file .env.docker up --build -d app`, then restart Purpur with `docker compose --env-file .env.docker restart purpur`. The builder renames older LinkBridge jars to `.jar.disabled` so only one version loads. Upgrade both halves together: the new report format requires `report_id`.

## Minigames

Two games in the desktop's **Minigames** window spend exactly the coins `/bal` reports: **Lucky Chest** (three reels) and **Minesweeper** (a 5×5 field with TNT and ores). A coin is a coin in both directions — a stake leaves the balance the in-game command shows and a win is credited back to it, so a result is visible in game on the next `/bal`.

```
browser                            panel                              Postgres
───────                            ─────                              ────────
pick the paying account,
send a stake or a cell             one live round per user and game
POST /api/minigames/...     ───▶   roll or deal on the server,       ───▶  minigame_rounds
                                   charge and pay in one                 one guarded UPDATE
                                   transaction                           on player_stats.coins
◀──── the round, what it paid, and the new balance
```

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| `GET` | `/api/minigames/config` | none | `200` the paytable, limits and return rates — the numbers the server pays from |
| `GET` | `/api/minigames/state` | session | `200` `{active}` — the live Minesweeper round, or `null` |
| `POST` | `/api/minigames/chest/spin` | session | `200` `{round_id, bet, reels, multiplier_x100, payout, balance}`; `400` bad stake or client id, `404` not your account, `409` not enough coins |
| `POST` | `/api/minigames/mines/start` | session | `200` the round; an existing live round is resumed rather than charged a second stake |
| `POST` | `/api/minigames/mines/reveal` | session | `200` the round with that cell opened; TNT settles it as a loss |
| `POST` | `/api/minigames/mines/cashout` | session | `200` the settled round; `400` below the minimum number of opened cells |

Details:

- **The server decides everything.** The browser sends a stake, or the cell it wants to open, and never an outcome; it displays the balance the response carries. There is no client-side RNG, no client-side balance, and no sandbox mode.
- **One account pays.** Coins live on a single Minecraft UUID, so one linked account is the payer: the window shows a picker when the user has several and remembers the choice (`minecraft-minigame-payer`). With no linked account the page shows the ordinary “Link an account” pointer instead — nothing is simulated.
- **Baseline player returns are about 92%, with small public economic adjustments.** At neutral policy, Lucky Chest has an expected return of **91.8%**. At baseline, each Minesweeper table (8, 10, 13 or 16 TNT) returns **92.6–92.8%** when cashing out at the earliest allowed moment, and the per-cell reward rises with the TNT count so the harder tables are wilder rather than worse. An automated test proves that no deeper cash-out beats that return, and the window displays the same figures `chest_rtp_x10000`/`mines_rtp_x10000` compute.
- **One live round per user and game.** Reloading resumes the round already paid for. A round the player walks away from forfeits its stake after **15 minutes** (`MINIGAME_ROUND_TTL_SECONDS`); refunding it would let anyone scout a field for free. A chest spin carries a browser-generated `client_id`, so a retried request returns the same spin instead of charging twice, and a repeated cash-out or reveal returns the settled round.
- **Minesweeper never leaks the field.** Until a cell is opened a response says only how many TNT the table holds. Once a round is settled — cashed out, blown up, or expired — it reveals the whole board.
- Every coin change is one statement, `UPDATE player_stats SET coins = coins ± $1 WHERE uuid = $2 AND coins >= $1`, inside the round's transaction. The `coins >=` guard and the column's `CHECK (coins >= 0)` mean a balance can never go negative, even with two requests racing.
- Rounds live in `minigame_rounds` (migration `0014`), keyed to the user with `ON DELETE CASCADE`, with a partial unique index that allows exactly one `active` round per user and game. The UUID column has no foreign key: like statistics, a round outlives unlinking.

## The web panel

Three client-rendered pages: `/register`, `/login`, and `/cabinet` — the account page, where the link state, the link code, and the linked accounts live. Deep links work because the server hands back the built `index.html` for any path that is not a real file. A path that *does* name a file keeps its `404`, so a stale page pointing at a chunk that no longer exists fails loudly instead of returning HTML where JavaScript was expected.

The panel uses an **old Mac desktop with Frutiger Aero glass**: a 40px menu bar and bottom dock launch Account, Global Statistics, Minigames, Marketplace, Player Controls and Settings. Player Controls has one dock button and a native title-bar account picker, containing Statistics, Inventory and Skin pages for the selected linked player. On desktop, drag or resize windows, minimize/close and reopen them from the dock, maximize/restore, or Reset their geometry. Focus the title bar to move with arrow keys, or the resize grip to resize; Shift changes the step from 10px to 40px. Closing a window keeps the session and form state. Windows stack on mobile, and each launch focuses and scrolls to the selected window. A small animated **music player** sits beside the bottom dock at the same height, keeps skip/play/pause/stop/volume controls visible, and plays quiet background music with animated level bars (sourced, attributed tracks, its own volume, always starting paused); small interface sounds play on window and button actions and can be turned off in Settings → Sound. [DESIGN.md](DESIGN.md) documents the visual system.

Account contains the existing registration, login and cabinet routes. The cabinet puts link status first, with linking beside account details when its window has enough room. Authentication pairs a sourced-icon welcome sidebar with the form; narrower windows hide the sidebar. The user-selected Asadal wallpaper sits lower behind the desktop and appears once. It is decorative artwork, never an image of the real server. Light uses that Asadal scene; Dark switches to the user-supplied night park. Both have provenance sidecars.

Open **Settings → Appearance** for **Light, Dark, and System**. Fresh browsers, invalid preferences and unavailable storage default to System. Explicit choices persist locally as `minecraft-theme`; System follows the operating system and changes synchronize across tabs. Storage failure still allows selection for the current page. Open Sans is self-hosted with its license. Confirmed links use the supplied green Vista shield; unlinked accounts use its red Off shield and explicit text. Notices use the supplied Warning shield. Search Globe marks Account and the favicon; Personalization marks Settings. CSS draws the traffic-light window controls. Windows flex with a damped wobbly-glass effect, and the sourced Asadal image becomes a WebGL live wallpaper with ambient water movement, pointer/touch ripples, rising bubbles, sweeping sunbeams, and traveling glints. Its ambient animation stems loop without a visible cut; all motion falls back to still presentation under Reduced Motion, and the wallpaper also falls back when WebGL is unavailable. No new raster artwork was generated. The panel displays only account and link data the server knows. Green Aero arrow, hand, text and disabled cursors retain native fallbacks and unchanged touch/forced-color behavior. Asset sources remain in `frontend/src/assets/icons/SOURCES.md` and `cursors/SOURCES.md`.

| Asset | Source | Notes |
| --- | --- | --- |
| `frontend/src/assets/fonts/open-sans.ttf` | Open Sans, SIL Open Font License | Self-hosted variable font; license in `fonts/open-sans-LICENSE.txt`. |
| `frontend/src/assets/asadal-stock-18.webp` | User-supplied Asadal image, from [Frutiger Aero Archive](https://frutigeraeroarchive.org/wallpapers) | Shared Light/Dark wallpaper; the adjacent `.webp.json` records its source, conversion, and archive rights notice. |

See `frontend/src/assets/ARTWORK.md` for artwork provenance and the archive’s rights notice. The previous generated day/night scenery has been removed from project assets. The former Minecraft font, dirt, and wood files remain as unused historical assets.

Its checks are `npm run build` (`tsc -b && vite build`), `npm run lint`, and
`npm test` (Node 24's built-in test runner). The image build runs the build check;
run lint and tests separately in the Node container used by the Dockerfile.
The 54 frontend tests cover successful logout, server errors, connection failures, theme preference parsing and storage fallback, System resolution, early-boot theme parity, window geometry/bounds, player-sounds settings, and the minigames window's pure helpers — stake clamping, the payer choice, paytable labels, server-status messages, and that a spin sends a stake and an id rather than an outcome. Pointer, keyboard, focus and responsive window behavior also require browser verification.

## Minecraft server

The stack runs a **Velocity** proxy and a **Purpur** backend (a Paper fork; Paper plugins run unchanged). It is an offline ("cracked") server: players authenticate with an in-game password, not a Mojang account.

```
internet (Java)    ──▶ velocity :25565 (TCP) ──▶ purpur :25565   (internal only, no published port)
internet (Bedrock) ──▶ velocity :19132 (UDP) ──▶
                       (only public MC ports)
```

Only `velocity` publishes a port. `purpur` has none, so it can be reached *only* through the proxy — that is what makes the proxy's word trustworthy.

### How the proxy is trusted

The backend accepts a login only when it comes from Velocity with **modern player-info forwarding**: Velocity signs the player's identity (UUID, name, IP) with a shared secret, and the backend verifies it. A client connecting straight to the backend is refused — it is asked for `velocity:player_info` and dropped.

The secret lives in exactly one place, `VELOCITY_SECRET` in `.env.docker`. `scripts/mc-init.sh` generates it, the proxy reads it from `mc/velocity/forwarding.secret`, and the backend gets it interpolated into `paper-global.yml` from the `CFG_VELOCITY_SECRET` variable. It is never committed.

> Offline mode means anyone can *claim* any username at the protocol level. The real gate is the in-game auth plugin — this stack ships **AuthMe** (see [Authentication](#authentication)), and `/website` only works after a successful in-game login.

### What lives where

| Path | In git? | Contents |
| --- | --- | --- |
| `mc-config/velocity/velocity.toml` | yes | Proxy config (bind, MOTD, offline mode, forwarding, server list) |
| `mc-config/purpur/config/paper-global.yml` | yes | Backend config; holds the `${CFG_VELOCITY_SECRET}` placeholder |
| `mc-config/purpur/plugins/AuthMe/config.yml` | yes | Hardened AuthMe settings |
| `mc-config/purpur/plugins/SkinsRestorer/config.yml` | yes | Backend-owned skins, Ely.by-first lookup with Mojang fallback |
| `mc-config/purpur/plugins/LinkBridge/config.yml` | yes | `/website` endpoint, token placeholder, cooldown |
| `plugin/` | yes | LinkBridge plugin source — `./scripts/build-plugin.sh` builds it |
| `mc/velocity/` | no | Proxy runtime data, jar, `forwarding.secret`, logs |
| `mc/purpur/` | no | World, plugins, server jar, configs, `authme.db` |

`mc-config/purpur/` mirrors the server directory 1:1 (`config/…`, `plugins/…`) — the container sets `COPY_CONFIG_DEST=/data` so the attach point lands there.

Everything the server *is* (world, plugins, configs, secrets, player accounts) lives under `mc/`, so that directory is what you move to relocate the server.

### Skins (official accounts, Legacy Launcher, TLauncher)

Compose installs [SkinsRestorer 15.12.6](https://github.com/SkinsRestorer/SkinsRestorer/releases/tag/15.12.6) on **Purpur only**. This is an intentional independent backend installation (`server.proxyMode.detection: DISABLED`), suited to this single-backend stack: all player skin commands pass through AuthMe's existing command gate. Do not add `/skin`, `/skins`, `/skull`, or namespaced variants to AuthMe's pre-login allowlist. Do not also install a second copy on Velocity without designing equivalent authentication checks there; proxy commands bypass Bukkit's AuthMe gate.

The configuration template is `mc-config/purpur/plugins/SkinsRestorer/config.yml`; ConfigMe supplies omitted defaults. Local skin selections/cache live under `mc/purpur/plugins/SkinsRestorer/` and travel with `mc/`. Backend proxy API mode is off; no shared SQL database is needed for this backend-owned installation. Offline UUIDs, AuthMe passwords, forwarding, and linked accounts stay unchanged.

`api.elyByEnabled: true` makes the pinned release try Ely.by first, then fall back to Mojang. Legacy Launcher players using Ely.by and official Minecraft accounts can therefore resolve skins by name; where the same name exists on both providers, Ely.by has priority. This is a skin lookup, never proof of account ownership or a reason to skip AuthMe. See the pinned [provider implementation](https://github.com/SkinsRestorer/SkinsRestorer/blob/15.12.6/shared/src/main/java/net/skinsrestorer/shared/connections/MojangAPIImpl.java).

After authenticating in game:

- `/skin set <Minecraft-or-Ely.by-name>` selects a skin; `/skin update` refreshes it; `/skin clear` resets the selection.
- TLauncher has a separate client skin system, which SkinsRestorer cannot auto-detect/import. Run `/skin upload` and follow the upload link, or use [SkinsRestorer's upload page](https://skinsrestorer.net/upload). Upload a standard skin PNG, copy the generated `/skin url "..."` command, and run it in game. The selection persists on the server and is visible to ordinary clients.
- If TLauncher or Legacy Launcher still shows another skin locally, disable its client skin replacement so it renders the server-provided skin. [Launcher overrides](https://skinsrestorer.net/docs/troubleshooting/launcher-issues) can change what that client sees even when the server is correct. HD skins and animated capes are not standard Java skin features.

Apply configuration changes with `docker compose --env-file .env.docker up -d --no-deps purpur` after a Compose change, or `docker compose --env-file .env.docker restart purpur` after editing only the template (brief Minecraft interruption). Run `/sr status` from an operator player or `sr status` in an attached server console; it reports asynchronously, so a short-lived RCON client can disconnect before the results arrive. The check chooses a random official account for all providers: an Ely.by-only failure can mean that sample has no signed Ely.by skin. Test a known Ely.by account before diagnosing an outage. A complete visual check needs a logged-in player and a second unmodified client; service diagnostics alone do not prove every client renders the skin.

The installed release's official asset SHA-256 is `a85b4a370f988741c9a38f4d0498262edacbf3220314790ac1c127461996359c`. Upgrade the pinned Compose URL and verify the new release digest together.

**Player Controls** is one app for up to four linked players. Click the nickname in the title bar to select the account to control. Statistics, Inventory and Skin are isolated by website user and UUID; each player retains its page and mounted contents across switching and hiding. The shared window keeps its geometry, and Marketplace inventory shortcuts and Global Statistics links select the requested player in this same app.

The Skin page shows the latest server-reported texture/model and accepts a 64 × 64 or legacy 64 × 32 PNG up to 256 KiB. Choose Classic or Slim arms, preview the local file, then choose **Save skin**. The current front-facing preview draws the actual `textures.minecraft.net` PNG and outer layer locally. Website heads use the server-reported texture hash through MCHeads, rather than guessing by username. Unknown textures and image failures use the sourced Performance Center artwork. A website upload changes this server's skin selection, not a Microsoft or launcher account.

The panel fully decodes and re-encodes uploads to strip PNG metadata, then sends them to MineSkin as **unlisted** images for signing. Anonymous signing needs no configuration; optionally set `MINESKIN_API_KEY` in `.env.docker`. This is an external service dependency. The durable SQL queue survives restarts, retries network/server errors and rate limits, and fails signing after ten minutes. PNG bytes are discarded after signing succeeds or fails. Each player has a 30-second accepted-upload cooldown; another upload cannot begin while one is pending.

Progress distinguishes queued/signing, prepared and waiting for the game server (`ready`), saved, and failed. LinkBridge 1.5.0 synchronizes every five seconds without overlapping passes, processing up to 25 linked players, oldest checked first. It stores signed selections through the SkinsRestorer API even while a player is offline, and refreshes live players only after AuthMe authentication. **Saved** acknowledges server storage; it does not prove every client rendered the skin. Acknowledgements must match both the upload request and signed texture. Observed skin snapshots survive unlinking; pending uploads are deleted with the link.

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| `GET` | `/api/players/{uuid}/skin` | owning session | `200` latest texture/model and upload state, `Cache-Control: no-store`; `404` if not owned |
| `POST` | `/api/players/{uuid}/skin` | owning session | Multipart `file` + `model` (`classic`/`slim`), with `X-Player-Skin: upload`; `202` queued, `400` invalid input/header, `413` oversized body, `404` not owned, `409` already processing, `429` cooldown |
| `POST` | `/internal/skins/sync` | service token | `200` JSON work batch; blocked by the public proxy |
| `POST` | `/internal/skins/report` | service token | `204` observed texture/saved acknowledgement; `400` malformed texture/UUID, `409` stale acknowledgement; blocked by the public proxy |

### Minecraft dependency downloads

Compose uses Paper's European Maven Central mirror, disables HTTP/2 in the image downloader, and retains server libraries across restarts (`PAPER_DEFAULT_CENTRAL_REPOSITORY`, `FETCH_USE_HTTP2`, `CLEAN_SERVER_LIBRARIES`). AuthMe shares the library directory, so cleaning it causes repeat downloads. These settings still require working access to artifact providers. If a download is interrupted, verify the complete server jar against the provider's checksum before replacing it and restarting; an existing filename alone does not establish a valid jar. See `STATE.md` for the current workstation recovery item.

#### Repeated corrupt Purpur JAR / unreliable download host

If Java reports `Invalid or corrupt jarfile` while the installer says the same
file is already up to date, rebuilding the container keeps reusing that file in
`mc/purpur/`. Pinning a build alone does not repair it.

For this deployment's **26.3 build 2652**, opt into a verified local executable.
Copy the complete recovery JAR from a working machine to the external server
once (for example with `scp`), then run from the external project's directory:

```sh
./scripts/install-local-purpur.sh /path/to/purpur-26.3-2652-verified.jar
```

Add this line to the external server's `.env.docker` (replace an existing
`COMPOSE_FILE` line rather than adding a duplicate):

```dotenv
COMPOSE_FILE=compose.yaml:compose.purpur-local.yaml
```

Then apply it once:

```sh
docker compose --env-file .env.docker up -d --no-deps --force-recreate purpur
docker compose --env-file .env.docker logs --since=1m -f purpur
```

The override uses the image's supported `CUSTOM_SERVER` local-file mode to run
the same Purpur server. It pins Java 25, mounts the executable read-only outside
`/data`, and verifies SHA-256 before launching Java. It never downloads the
Purpur executable on startup. Normal Compose commands and `scripts/deploy.sh`
automatically use this override through `.env.docker`; explicit `-f` arguments
override `COMPOSE_FILE`, so include both files when specifying them manually.
Worlds, AuthMe, skins, forwarding and plugins still use the original `/data` and
config mounts. Plugin downloads/checks and missing Minecraft libraries may
still need network access; this is not a fully offline server.

The installer checks the source and staged copy before atomically replacing the
installed JAR. A failed check preserves the installed copy. Keep
`mc/server-jars/` with `mc/` when moving or exporting the stack. The hash is tied
to build 2652; upgrading requires a separately verified JAR and updating the
override and verifier together. Remove the `COMPOSE_FILE` line and recreate
Purpur to return to the normal downloader.

### Authentication

An offline server is impersonatable by design: anyone can connect using your name. **AuthMe** (pinned to `6.0.1`, Paper jar) is what actually stops that — players register and log in with an in-game password, and nothing else works until they do.

It is configured for a hostile environment out of the box (`allowChat: false`, `allowMovement: false`, commands restricted to `/login`/`/register`/`/email`/`/captcha`/`/2fa`, `ForceSingleSession: true`, `preventOtherCase: true`, premium auto-login **off**). On top of that, `mc-config/purpur/plugins/AuthMe/config.yml` raises the weak defaults:

| Setting | Default | Ours | Why |
| --- | --- | --- | --- |
| `passwordHash` | `SHA256` | `BCRYPT` | SHA-256 is fast; cheap to brute-force if `authme.db` leaks |
| `minPasswordLength` | `5` | `6` | Matches the website minimum for new/changed passwords |
| `maxRegPerIp` | `1` | `4` | Up to four Minecraft registrations from one IP |
| `maxLoginPerIp` / `maxJoinPerIp` | `0` (unlimited) | `4` | Allows those four accounts to join/log in while retaining a per-IP limit |
| `displayOtherAccounts` | `true` | `false` | Otherwise it tells a player which other accounts share their IP |

### Anticheat (GrimAC)

The server runs **GrimAC** (`2.3.75-8baa16f`), an asynchronous, predictive 1:1 physics simulation anticheat powered by PacketEvents.
- **Predictive movement simulation**: Grim resimulates exact client physics ticks off the main thread. Movement hacks (speed, flight, timer, phase/noclip, ground spoof, step, anti-knockback) are immediately cancelled and set back with zero main-thread TPS drop.
- **Combat verification**: reach hacks (> 3.0 blocks eye-to-hitbox), impossible angles, and killaura packets are flagged and blocked.
- **Bedrock / Geyser crossplay exemption**: Bedrock players connecting from Xbox, mobile, or Switch (whose usernames begin with `.` or use Floodgate UUIDs) are automatically granted `grim.exempt` and `grim.nosetback` on join to eliminate false flags caused by Bedrock-to-Java physics translation differences.
- **Operator alerts**: server operators automatically receive `grim.alerts` to monitor flags and potential violations in real time.
- Configuration templates are version-controlled under `mc-config/purpur/plugins/GrimAC/`.

### AntiBot & DDoS Protection

Multi-layered protection secures both the web panel and the Minecraft network against DDoS, automated bots, and connection floods:

1. **Velocity Proxy Hardening & AntiBot**:
   - **Sonar AntiBot** (`v2.1.53` on Velocity): Detects bot join floods via automated attack tracking (`attack-tracker`). When bot waves occur, verification mode (`timing: DURING_ATTACK`) activates, while normal players connect seamlessly during peace time. Bedrock players (`check-geyser-players: false`) bypass verification to preserve frictionless crossplay. Maximum of 3 online players per IP address.
   - **Network & Packet Limiting** (`mc-config/velocity/velocity.toml`): Rapid login attempts from the same IP are throttled (`login-ratelimit = 2000` ms). Connection and read timeouts (5s) prevent slowloris TCP exhaustion. `[packet-limiter]` drops packet-flooding clients (350 packets/s, 1 MB/s wire throughput, 5 MB/s decompression bomb protection).
2. **Backend Server Protection (AuthMe)**:
   - AuthMe anti-bot is enabled (`enableProtection: true`, `enableAntiBot: true`) to throttle the authentication gate during join spikes, and kicks bots issuing instant commands on join (`denyCommandsBeforeMilliseconds: 1000`).
3. **Web Proxy & API Rate Limiting (Caddy & Axum)**:
   - **Caddy**: HTTP timeouts (`read_body 10s`, `read_header 5s`, `write 15s`, `idle 120s`) mitigate Slowloris / slow HTTP attacks. Request bodies are capped at 10MB to block buffer exhaustion attacks. Automated scanner user-agents (sqlmap, nikto, masscan, zgrab, etc.) are immediately rejected with 403 Forbidden.
   - **Axum**: An in-memory sliding-window burst limiter on `/api/*` (`rate_limit_global_api`) enforces a 25 req/sec ceiling per IP, returning 429 Too Many Requests immediately without taxing PostgreSQL.

### Anti-Xray (Engine Mode 2 Obfuscator)

Purpur's native Paper-based asynchronous Anti-Xray engine is enabled with **Engine Mode 2** (`mc-config/purpur/config/paper-world-defaults.yml`).
- **Mode 2 Obfuscation**: Rather than simply hiding ores as stone (which naive raytracers can still bypass), Mode 2 populates unexposed underground stone, deepslate, and netherrack with randomized fake ores in chunk data packets sent to clients. X-ray texture packs, cheat client ESP, and Freecam (Meteor, Wurst, Aristois, etc.) see an impenetrable sea of fake ores everywhere.
- **Dynamic Unveiling**: When a block is legitimately mined or exposed to air or transparent blocks, the server immediately sends the authentic block state within a 2-block radius.
- **Protected Blocks**: Diamonds, ancient debris, emeralds, gold, iron, copper, lapis, redstone, coal, fuel crystals, amethyst clusters, and valuable block entities (chests, trapped chests, ender chests, mob spawners, TNT).
- **Height Bounds**: Active up to Y=180 (`max-block-height: 180`), protecting both deep underground mining (down to Y=-64) and high mountain emerald/coal seams.
- **Zero TPS degradation**: Obfuscation runs asynchronously off the server thread during chunk packet serialization, maintaining 20.0 TPS even during heavy player exploration. Full compatibility with Bedrock (Geyser) clients.

That file is **partial** — AuthMe fills in every other key from its own defaults, so it stays small and survives AuthMe upgrades.

> Two things to know. `ProtectInventoryBeforeLogIn` is silently disabled without the PacketEvents plugin; what actually keeps a registered player out of the world until they log in is AuthMe's Paper **pre-join dialog**. And `/website` must stay **out** of `allowCommands` — that list is the pre-login whitelist, and linking must be impossible before authenticating.

### Linking a Minecraft account

The panel and the game server never share a password. To connect them:

1. On the website, log in and ask for a code (`POST /api/link/start`). It is eight characters and lives for five minutes.
2. On the website, **Copy command** copies `/website link <code>` with the issued code already filled in. Paste it in game after logging in with your Minecraft password. Clipboard failure leaves a selectable command and manual-copy instructions.

The **LinkBridge** plugin (source in `plugin/`) implements step 2. It handles linking, durable activity reports and skin synchronization:

- It declares `depend: [AuthMe, SkinsRestorer]` and refuses the command unless `AuthMeApi.getInstance().isAuthenticated(player)` is true, so the in-game password is always proved first. AuthMe already blocks every command outside `allowCommands` before login and `/website` is deliberately absent from that list; the plugin's own check is the second lock, so neither one alone is load-bearing.
- It POSTs `{code, uuid, username}` to `http://app:8080/internal/link/claim` with `Authorization: Bearer <LINK_SERVICE_TOKEN>`. That endpoint is answered 404 at the proxy, so it is reachable only from inside the Compose network.
- After a player logs in or registers, it asks `POST /internal/link/status` and — **only** on a `404` — tells them in chat that the account is not linked and where to link it. A `200` stays silent, so a linked player is never nagged; `401`/`503` log an operator warning instead, because a token problem is not the player's business. Any other answer, including an unreachable panel, says nothing: a wrong "you are not linked" is worse than no message.
- `/website email` privately shows a masked reminder of the linked website email (for example `d***@gmail.com`). It accepts no other player or email argument. AuthMe must authenticate the player before the request and again before delivering the asynchronous response. It shares the per-player command cooldown with linking, but uses a separate internal lookup so it does not consume the link-claim IP budget. The response contains only the masked address, is not cached, and is never logged or broadcast by LinkBridge. This is an email reminder, not password recovery or email verification. The old standalone `/link` command is no longer registered.
- It also measures in-game activity — play time, blocks placed and broken, mobs killed, deaths, distance, crafting, fishing, damage, logins, enchanting, broken tools, breeding, sleeping and advancements — for authenticated players and reports the growth to the panel, which powers the statistics page. See [Statistics](#statistics).
- It never sees, stores or forwards a password. The panel's `minecraft_accounts` table is the only record of ownership; activity retry reports and SkinsRestorer selections persist separately under `mc/`.

Build it once. Everything runs in containers, so no JDK is needed on the host:

```sh
./scripts/build-plugin.sh          # -> mc/purpur/plugins/LinkBridge-1.4.0.jar
```

The jar is installed into `mc/purpur/plugins/`, so it travels with the server data; only the source is committed. Re-run it after changing anything under `plugin/`.

| `/website` says | Meaning |
| --- | --- |
| Linked! | `200` — done |
| unknown, already used, or expired | `404` — all three are deliberately identical |
| already linked | `409` — that Minecraft account belongs to another panel account |
| four linked accounts | `422` — unlink one on the website, then retry the unconsumed code |
| refused this server's credentials | `401`/`503` — a token problem, so it is an operator's job, not the player's |

The plugin throttles each player to one attempt every three seconds. That is not cosmetic: every player reaches the panel from the same container address, so the panel's per-IP claim budget (`LINK_CLAIM_IP_LIMIT`) is shared by the whole server. Raise it if the server grows.

### First run

```sh
./scripts/mc-init.sh                                  # creates .env.docker, generates the secrets, makes mc/
./scripts/build-plugin.sh                             # builds LinkBridge into mc/purpur/plugins/
docker compose --env-file .env.docker up -d --build   # brings up the whole stack
```

The backend downloads its jar and generates a world on first boot, which takes a minute or two. Watch it with:

```sh
docker compose --env-file .env.docker up -d --build
```

Connect to `localhost:25565`. `MC_VERSION` in `.env.docker` pins the Minecraft version — leave it as `LATEST` for the newest release, or set an exact version (for example `26.3`) so redeploys do not change under you.

### Moving to another server

Copy the whole directory, or use the export script, which also dumps the database:

```sh
./scripts/export.sh                # writes project-export-<timestamp>.tar.gz
```

Export temporarily stops any running `app`, `velocity`, and `purpur` services,
waits for a clean shutdown, then dumps Postgres and archives the Minecraft data.
It restarts only the services that were running beforehand, including on failure.
Expect the website and game to be unavailable during this snapshot. Existing
`.tar.gz` bundles and generated build directories are excluded.

On the new host:

```sh
tar xzf project-export-*.tar.gz
docker login dhi.io
docker compose --env-file .env.docker up -d --build
docker compose --env-file .env.docker exec -T db psql -U postgres -d project_db < db.sql
```

The archive contains the compose file, source, `.env.docker` (secrets), `mc/` (world, plugins, forwarding secret) and `db.sql`. It does **not** include the `pgdata`/`caddy_data` volumes or TLS certificates — Caddy re-issues those on the new host. Make sure the new host's firewall allows `80`, `443`, `25565` (TCP) and `19132` (UDP).

## Everyday commands

```sh
# Start again and rebuild after code changes
docker compose --env-file .env.docker up --build -d

# Tests (the `tests` service uses the `tests` profile, so `up` never runs it)
docker compose --env-file .env.docker run --rm tests

# Export regression tests (fake Docker CLI; no running services affected)
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -v

# Rebuild the LinkBridge plugin after editing plugin/ (installs into mc/purpur/plugins/)
./scripts/build-plugin.sh

# DataBase
docker compose --env-file .env.docker exec db psql -U postgres -d project_db

# Check container status
docker compose --env-file .env.docker ps

# Follow logs
docker compose --env-file .env.docker logs -f proxy app

# Minecraft: logs, and the in-game console (Ctrl+P Ctrl+Q to detach)
docker compose --env-file .env.docker logs -f purpur velocity
docker compose --env-file .env.docker attach purpur

# Minecraft: restart just the game servers
docker compose --env-file .env.docker restart velocity purpur

# Stop and remove the containers; keep the database volume
docker compose --env-file .env.docker down
```

`docker compose --env-file .env.docker down -v` also **deletes the database volume and its data**. Use it only when you want a fresh database.

Sign-in accepts either an email address or a login name, trimmed and case-insensitive. Both share the account’s existing lockout counter. `POST /api/login` takes `{identifier, password}`; the legacy `{email, password}` payload remains supported. If an email exactly matches another account’s login name, the email owner takes precedence; the other account can sign in with its own email.


### Minigame recovery and queue rotation

Minigames is entirely in English. Lucky Chest retains an unresolved spin’s exact request in session storage for the current website user; **Recover spin** retries that same stake, including after reloading the tab. Allow the recovery to finish before placing a new stake. Minesweeper identifies the original paying player when restoring a round and enforces its fifteen-minute deadline on reveal and cash-out as well as state loading. Its classic raised cells support arrow-key navigation.

Migration `0015_market_task_rotation.sql` adds the last-checked time for Marketplace task rotation. Sync still returns only each player’s oldest pending task, but rotates between players so full inventories cannot hold up everyone else’s deliveries.

### Economy simulation

Run `./scripts/simulate-economy.sh` for 3,840 seeded virtual years across controls and six candidate policies without a running
game or database. Add `--strict` to enforce the economic release objectives.
Reports are saved under `reports/economy/`; `comparison.md` compares experimental
issuance budgets, optional services and finite starter materials. [ECONOMY.md](ECONOMY.md#reproducible-virtual-world-simulation-and-ci)
describes assumptions, charts and CI behavior. The production workflow now runs
the strict gate and uploads results even on failure. **Strict acceptance is checked against the implemented rules; candidate success
cannot bypass a failed gate.** The source now implements migrations 0017/0018 and
LinkBridge 1.10.0: bounded daily issuance, newcomer shares, iron-work onboarding,
fishing/farming/hunting objectives, and `/services repair` with a confirmed quote. `/services travel` waits
for private blocks and charges nothing. See ECONOMY.md for startup timing,
legacy promises and rollout requirements; local source changes are not a deployment.
