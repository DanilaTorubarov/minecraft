# Minecraft panel frontend

React 19, TypeScript 6, Vite 8, and React Router. This directory is the website UI served by the Rust API. Read the root [README](../README.md), [AGENTS.md](../AGENTS.md), [PRODUCT.md](../PRODUCT.md), and [DESIGN.md](../DESIGN.md) before changing it. The dated checkpoint is [STATE.md](../STATE.md).

## Applications

`Shell.tsx` provides the desktop menu, dock, and independent windows. Account contains registration, login, cabinet, and security flows. Global Statistics combines only the signed-in user's linked Minecraft accounts. **Player Controls** is one window with a native player picker and Statistics, Inventory, and Skin pages. Minigames and Marketplace have their own windows. Settings contains appearance and interface-sound preferences. The music player is a separate widget beside the dock.

`PlayerApp.tsx` owns each player's page selection. `lib/useStatistics.ts` supplies the shared five-second account/statistics snapshot. `pages/SkinPage.tsx` manages current-skin loading, PNG preview/upload, and progress; `SkinFigure.tsx` draws the real skin texture. All account data comes from the API. Preserve loading, empty, failure, ownership, keyboard, reduced-motion, and responsive states.

## Build and checks

Build the deployed frontend through Docker from the repository root:

```sh
docker compose --env-file .env.docker up --build -d app proxy
```

The image runs `npm ci` and `npm run build` (`tsc -b && vite build`). `frontend/dist` is generated and ignored. API requests use relative `/api/...`; Vite has no backend proxy, so `npm run dev` alone cannot provide a working account application.

Run checks using Node 24 in Docker:

```sh
docker run --rm -v "$PWD/frontend:/app" -w /app dhi.io/node:24-alpine-dev sh -c 'npm ci && npm run lint && npm test'
```

Run from the repository root. Node's built-in test runner loads TypeScript tests from `tests/`. Test imports must stay asset-free; keep pure helpers separate from browser modules importing artwork/audio. Rebuild the app image to verify TypeScript and production bundling after UI changes.

## Visual system and assets

Use the semantic tokens in `src/index.css` and the authoritative root design guide. Light uses the supplied Asadal landscape; Dark uses the user-supplied night park. Preserve all artwork, icon, cursor, font, and audio provenance/license files. Native buttons expose the player page selection with `aria-current="page"`. Player page contents remain independent per linked user/UUID; Player Controls shares one window geometry.
