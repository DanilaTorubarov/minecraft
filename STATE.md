# Project checkpoint — 2026-10-18

This file records the state at this checkpoint. It is historical evidence, not a live health indicator. Read `README.md` for operation, `AGENTS.md` for engineering constraints, and `PRODUCT.md` / `DESIGN.md` for product and visual intent.

## Implemented

- Account registration/login/logout, session security, linking, masked in-game email reminders, and account security/email flows (see `EMAIL.md`). Website passwords require at least six characters; AuthMe's separate in-game policy requires ten.
- Persistent coins: one per authenticated, uncancelled block break; `/bal` and `/balance`; immutable reports with permanent deduplication receipts and durable plugin retry files. Migration `0007` starts balances at zero.
- Expanded server activity counters in migration `0008`, displayed in grouped statistics with real loading/empty/error states.
- Global Statistics combines the current user's linked accounts only. Each nickname/skin-head launcher opens an independent player app with Statistics and Skin pages. Shared statistics refresh every five seconds; each window keeps its own page and geometry during the linked session.
- SkinsRestorer 15.12.6 on Purpur only, AuthMe-gated commands, Ely.by-first/Mojang-fallback skin lookup. TLauncher skins can be imported as standard PNGs; launcher rendering overrides remain client-controlled.
- Owned-player website skin upload: PNG validation and metadata stripping, Classic/Slim preview, durable MineSkin signing queue, and LinkBridge 1.4.0 synchronization into SkinsRestorer. Migration `0009` separates observed textures from link-owned pending uploads. Saved means server storage acknowledged, not a visual guarantee on every client.
- Aero desktop, independent windows, sourced skin heads, Light Asadal / Dark night-park wallpapers, animated wallpaper, music widget beside the dock, and interface sounds. Preserve asset attribution and provenance.

## Deployment observed at checkpoint

- Web app rebuilt successfully through Docker; `https://localhost/` returned HTTP 200.
- App, Caddy, PostgreSQL, Mailpit, and Velocity were running; PostgreSQL, Mailpit, and Velocity reported healthy.
- **Purpur was stopped** after an interrupted download left `mc/purpur/purpur-26.3-2652.jar` incomplete (34,249,194 bytes). Minecraft gameplay and game-to-panel synchronization are unavailable until the backend is restored.
- A recovered full jar was preserved locally at `.plugin-build/purpur-26.3-2652-verified.jar` (58,033,746 bytes). Its MD5 matches the provider metadata: `bbf5d8703bc8ee5aa6c5251e1bbcaa78`; ZIP integrity passed. This generated file is ignored by Git. Recovery remains outstanding: with Purpur stopped, verify/copy this jar over the incomplete runtime jar, start only Purpur, and inspect startup logs and health. Do not delete worlds, AuthMe data, skin selections, or volumes.
- Compose retains AuthMe's shared library cache, uses the European Paper Maven mirror, and disables HTTP/2 for artifact downloads. Network availability is still required.

## Verification evidence

At this checkpoint:

- `cargo check --tests`: passed.
- Frontend ESLint: passed; Node 24 regression tests: **31 passed**.
- Docker production build: TypeScript/Vite and Rust release build passed; HTTPS returned 200.

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

Restore and start Purpur, confirm AuthMe / SkinsRestorer / LinkBridge startup, then verify skin rendering with an authenticated player and an unmodified second client. Check both a known official account and a known Ely.by account. Client skin replacement may affect the result; appearance never changes authentication or offline UUID ownership.
