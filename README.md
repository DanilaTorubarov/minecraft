# Rust, React, and PostgreSQL with Docker

A web panel for a Minecraft server: an account system with server-side sessions and account linking, plus the game stack itself.

The `proxy` container runs Caddy and terminates HTTPS — it is the only web service exposed to the outside (ports 80 and 443). The `app` container runs the Rust server on port 8080 and serves the built React frontend; it is reachable only through the proxy. The `db` container runs PostgreSQL 18. PostgreSQL data is stored in the `pgdata` Docker volume, separately from the PostgreSQL installation on your Mac. The `velocity` and `purpur` containers run the Minecraft proxy and backend (see [Minecraft server](#minecraft-server)), with **AuthMe** doing in-game authentication and the **LinkBridge** plugin (source in `plugin/`) bridging `/website` to the panel.

## What is in this repository

| Path | What it is |
| --- | --- |
| `src/main.rs` | The entire Rust API — register/login/logout, sessions, rate limiting, account linking |
| `migrations/` | The SQL schema, applied by sqlx automatically on startup |
| `frontend/` | The React 19 + Vite app — `/register`, `/login`, and the `/cabinet` account page |
| `Dockerfile` | Multi-stage build: npm build → cargo build → slim runtime image |
| `compose.yaml` | The whole stack — `proxy`, `app`, `db`, `velocity`, `purpur`, and a `tests` profile |
| `Caddyfile` | TLS termination, security headers, and the `/internal/*` block |
| `mc-config/` | Minecraft config templates, committed — mirrors the server directory 1:1 |
| `plugin/` | The LinkBridge Java plugin source, built by `./scripts/build-plugin.sh` |
| `scripts/` | `mc-init.sh` (first-run setup), `build-plugin.sh`, `export.sh` (move to another host) |

`mc/` (the Minecraft world, plugins, secrets and player accounts), `target/`, `frontend/dist/`, `.plugin-build/` and `plugin/build/` are all generated locally and never committed.

## Before starting

Start Docker Desktop and sign in to Docker Hardened Images:

```sh
docker login dhi.io
```

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
| `POST` | `/api/link/start` | session cookie | `200` `{code, expires_in}` |
| `GET` | `/api/link` | session cookie | `200` `{accounts: [...]}` |
| `DELETE` | `/api/link/{uuid}` | session cookie | `204`, or `404` if not yours |
| `POST` | `/internal/link/claim` | service token | `200`, `404` bad/used/expired code, `409` UUID already linked, `401` bad token, `503` not configured |
| `POST` | `/internal/link/status` | service token | `200` linked, `404` not linked, `400` malformed UUID, `401` bad token, `503` not configured |
| `POST` | `/internal/link/email` | service token | `200` plain-text masked email, `Cache-Control: no-store`; `404` unlinked, `400` malformed UUID, `401` bad token, `503` not configured |

Details:

- Codes are **single-use**, expire after `LINK_CODE_TTL_SECONDS` (default 300), and only the newest code per user stays valid. Only the code's SHA-256 is stored, never the code.
- The alphabet omits characters that are easy to misread in-game (`I`, `L`, `O`, `U`, `0`, `1`).
- `/internal/*` is **blocked at the proxy** (it answers `404` to the internet) and additionally requires the service token. `scripts/mc-init.sh` generates `LINK_SERVICE_TOKEN` in `.env.docker` (the plugin sends it as a bearer token); with it unset the endpoint answers `503`.
- Both `/internal` endpoints answer with **bare status codes and no body**, so the plugin never parses JSON.
- An unknown, used, or expired code all return the same `404`, so codes cannot be probed.
- Linking a UUID that is already linked returns `409` and does **not** consume the code, so the player can retry.

The knobs, overridable in `.env.docker`:

```dotenv
LINK_CODE_TTL_SECONDS=300         # how long a code stays valid
LINK_CLAIM_IP_LIMIT=30            # claim requests per IP per window
LINK_CLAIM_IP_WINDOW_SECONDS=60
```

Every in-game claim arrives from the game server's single container address, so `LINK_CLAIM_IP_LIMIT` is effectively a **server-wide** budget for Minecraft linking rather than a per-player one. The plugin's own per-player cooldown protects it.

## Statistics

The game server measures what it can see in game — how long an authenticated player is online, and how many blocks they place or break — and reports the growth to the panel. The panel stores it per in-game UUID and shows it, per linked account and in total, in the **Statistics** window (launched from the menu bar or the dock). The panel never measures the game itself; it only shows what the server reported.

```
authenticated player in game      LinkBridge plugin             panel
──────────────────────────        ───────────────               ─────
time online, blocks placed/broken
                                  every few minutes, on quit,
                                  and on shutdown:
                                  POST /internal/stats/report
                                  Authorization: Bearer <LINK_SERVICE_TOKEN>
                                  { players: [{ uuid, username,
                                    play_seconds, blocks_placed,
                                    blocks_broken }, ...] }
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

- Reports carry **deltas since the last accepted report** — the plugin's counters restart with the server, so the panel just adds. A crash loses at most one flush; a delta is counted twice only if its response is lost after the panel committed (rare on the Compose network).
- Activity only counts after a player has authenticated with AuthMe — standing at the login gate is not playing.
- `first_seen_at` / `last_seen_at` are when the panel first heard, and last heard, from the game server about a UUID; they are not in-game timestamps.
- The report endpoint is **not** rate limited, for the same reason as `link_status`: at most one batched request per flush, from the game server's single container address.
- Statistics survive unlinking: the rows are keyed by UUID with no foreign key, so unlinking hides them and re-linking the same in-game name restores them.
- `stats-report-seconds` (default `300`) in `mc-config/purpur/plugins/LinkBridge/config.yml` sets the flush interval.

## The web panel

Three client-rendered pages: `/register`, `/login`, and `/cabinet` — the account page, where the link state, the link code, and the linked accounts live. Deep links work because the server hands back the built `index.html` for any path that is not a real file. A path that *does* name a file keeps its `404`, so a stale page pointing at a chunk that no longer exists fails loudly instead of returning HTML where JavaScript was expected.

The panel uses an **old Mac desktop with Frutiger Aero glass**: a 40px menu bar and bottom dock launch Account, Statistics, and Settings windows. On desktop, drag or resize windows, minimize/close and reopen them from the dock, maximize/restore, or Reset their geometry. Focus the title bar to move with arrow keys, or the resize grip to resize; Shift changes the step from 10px to 40px. Closing a window keeps the session and form state. Windows stack on mobile, and each launch focuses and scrolls to the selected window. A small animated **music player** sits beside the bottom dock at the same height, keeps skip/play/pause/stop/volume controls visible, and plays quiet background music with animated level bars (sourced, attributed tracks, its own volume, always starting paused); small interface sounds play on window and button actions and can be turned off in Settings → Sound. [DESIGN.md](DESIGN.md) documents the visual system.

Account contains the existing registration, login and cabinet routes. The cabinet puts link status first, with linking beside account details when its window has enough room. Authentication pairs a sourced-icon welcome sidebar with the form; narrower windows hide the sidebar. The user-selected Asadal wallpaper sits lower behind the desktop and appears once. It is decorative artwork, never an image of the real server. Both themes share it, with CSS dimming in Dark.

Open **Settings → Appearance** for **Light, Dark, and System**. Fresh browsers, invalid preferences and unavailable storage default to Light. Explicit choices persist locally as `minecraft-theme`; System follows the operating system and changes synchronize across tabs. Storage failure still allows selection for the current page. Open Sans is self-hosted with its license. Confirmed links use the supplied green Vista shield; unlinked accounts use its red Off shield and explicit text. Notices use the supplied Warning shield. Search Globe marks Account and the favicon; Personalization marks Settings. CSS draws the traffic-light window controls. Windows flex with a damped wobbly-glass effect, and the sourced Asadal image becomes a WebGL live wallpaper with ambient water movement, pointer/touch ripples, rising bubbles, sweeping sunbeams, and traveling glints. Its ambient animation stems loop without a visible cut; all motion falls back to still presentation under Reduced Motion, and the wallpaper also falls back when WebGL is unavailable. No new raster artwork was generated. The panel displays only account and link data the server knows. Green Aero arrow, hand, text and disabled cursors retain native fallbacks and unchanged touch/forced-color behavior. Asset sources remain in `frontend/src/assets/icons/SOURCES.md` and `cursors/SOURCES.md`.

| Asset | Source | Notes |
| --- | --- | --- |
| `frontend/src/assets/fonts/open-sans.ttf` | Open Sans, SIL Open Font License | Self-hosted variable font; license in `fonts/open-sans-LICENSE.txt`. |
| `frontend/src/assets/asadal-stock-18.webp` | User-supplied Asadal image, from [Frutiger Aero Archive](https://frutigeraeroarchive.org/wallpapers) | Shared Light/Dark wallpaper; the adjacent `.webp.json` records its source, conversion, and archive rights notice. |

See `frontend/src/assets/ARTWORK.md` for artwork provenance and the archive’s rights notice. The previous generated day/night scenery has been removed from project assets. The former Minecraft font, dirt, and wood files remain as unused historical assets.

Its checks are `npm run build` (`tsc -b && vite build`), `npm run lint`, and
`npm test` (Node 24's built-in test runner). The image build runs the build check;
run lint and tests separately in the Node container used by the Dockerfile.
The 10 frontend tests cover successful logout, server errors, connection failures, theme preference parsing and storage fallback, System resolution, early-boot theme parity, and window geometry/bounds. Pointer, keyboard, focus and responsive window behavior also require browser verification.

## Minecraft server

The stack runs a **Velocity** proxy and a **Purpur** backend (a Paper fork; Paper plugins run unchanged). It is an offline ("cracked") server: players authenticate with an in-game password, not a Mojang account.

```
internet ──▶ velocity :25565 ──▶ purpur :25565   (internal only, no published port)
             (only public MC port)
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
| `mc-config/purpur/plugins/LinkBridge/config.yml` | yes | `/website` endpoint, token placeholder, cooldown |
| `plugin/` | yes | LinkBridge plugin source — `./scripts/build-plugin.sh` builds it |
| `mc/velocity/` | no | Proxy runtime data, jar, `forwarding.secret`, logs |
| `mc/purpur/` | no | World, plugins, server jar, configs, `authme.db` |

`mc-config/purpur/` mirrors the server directory 1:1 (`config/…`, `plugins/…`) — the container sets `COPY_CONFIG_DEST=/data` so the attach point lands there.

Everything the server *is* (world, plugins, configs, secrets, player accounts) lives under `mc/`, so that directory is what you move to relocate the server.

### Authentication

An offline server is impersonatable by design: anyone can connect using your name. **AuthMe** (pinned to `6.0.1`, Paper jar) is what actually stops that — players register and log in with an in-game password, and nothing else works until they do.

It is configured for a hostile environment out of the box (`allowChat: false`, `allowMovement: false`, commands restricted to `/login`/`/register`/`/email`/`/captcha`/`/2fa`, `ForceSingleSession: true`, `preventOtherCase: true`, premium auto-login **off**). On top of that, `mc-config/purpur/plugins/AuthMe/config.yml` raises the weak defaults:

| Setting | Default | Ours | Why |
| --- | --- | --- | --- |
| `passwordHash` | `SHA256` | `BCRYPT` | SHA-256 is fast; cheap to brute-force if `authme.db` leaks |
| `minPasswordLength` | `5` | `10` | This password is the only gate on an offline server |
| `maxLoginPerIp` / `maxJoinPerIp` | `0` (unlimited) | `3` | Stops one host running a credential-stuffing run |
| `displayOtherAccounts` | `true` | `false` | Otherwise it tells a player which other accounts share their IP |

That file is **partial** — AuthMe fills in every other key from its own defaults, so it stays small and survives AuthMe upgrades.

> Two things to know. `ProtectInventoryBeforeLogIn` is silently disabled without the PacketEvents plugin; what actually keeps a registered player out of the world until they log in is AuthMe's Paper **pre-join dialog**. And `/website` must stay **out** of `allowCommands` — that list is the pre-login whitelist, and linking must be impossible before authenticating.

### Linking a Minecraft account

The panel and the game server never share a password. To connect them:

1. On the website, log in and ask for a code (`POST /api/link/start`). It is eight characters and lives for five minutes.
2. On the website, **Copy command** copies `/website link <code>` with the issued code already filled in. Paste it in game after logging in with your Minecraft password. Clipboard failure leaves a selectable command and manual-copy instructions.

The **LinkBridge** plugin (source in `plugin/`) implements step 2. It is deliberately tiny and holds no state:

- It declares `depend: [AuthMe]` and refuses the command unless `AuthMeApi.getInstance().isAuthenticated(player)` is true, so the in-game password is always proved first. AuthMe already blocks every command outside `allowCommands` before login and `/website` is deliberately absent from that list; the plugin's own check is the second lock, so neither one alone is load-bearing.
- It POSTs `{code, uuid, username}` to `http://app:8080/internal/link/claim` with `Authorization: Bearer <LINK_SERVICE_TOKEN>`. That endpoint is answered 404 at the proxy, so it is reachable only from inside the Compose network.
- After a player logs in or registers, it asks `POST /internal/link/status` and — **only** on a `404` — tells them in chat that the account is not linked and where to link it. A `200` stays silent, so a linked player is never nagged; `401`/`503` log an operator warning instead, because a token problem is not the player's business. Any other answer, including an unreachable panel, says nothing: a wrong "you are not linked" is worse than no message.
- `/website email` privately shows a masked reminder of the linked website email (for example `d***@gmail.com`). It accepts no other player or email argument. AuthMe must authenticate the player before the request and again before delivering the asynchronous response. It shares the per-player command cooldown with linking, but uses a separate internal lookup so it does not consume the link-claim IP budget. The response contains only the masked address, is not cached, and is never logged or broadcast by LinkBridge. This is an email reminder, not password recovery or email verification. The old standalone `/link` command is no longer registered.
- It also measures in-game activity — time online, blocks placed and broken — for authenticated players and reports the growth to the panel, which powers the statistics page. See [Statistics](#statistics).
- It never sees, stores or forwards a password, and it does not remember the outcome — the panel's `minecraft_accounts` table is the only record.

Build it once. Everything runs in containers, so no JDK is needed on the host:

```sh
./scripts/build-plugin.sh          # -> mc/purpur/plugins/LinkBridge-1.1.0.jar
```

The jar is installed into `mc/purpur/plugins/`, so it travels with the server data; only the source is committed. Re-run it after changing anything under `plugin/`.

| `/website` says | Meaning |
| --- | --- |
| Linked! | `200` — done |
| unknown, already used, or expired | `404` — all three are deliberately identical |
| already linked | `409` — that Minecraft account belongs to another panel account |
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

The archive contains the compose file, source, `.env.docker` (secrets), `mc/` (world, plugins, forwarding secret) and `db.sql`. It does **not** include the `pgdata`/`caddy_data` volumes or TLS certificates — Caddy re-issues those on the new host. Make sure the new host's firewall allows `80`, `443` and `25565`.

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
