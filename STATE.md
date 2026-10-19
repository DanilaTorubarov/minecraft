# Project checkpoint — 2026-10-18

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
