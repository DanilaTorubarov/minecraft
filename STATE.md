# Project checkpoint — 2026-10-18

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
