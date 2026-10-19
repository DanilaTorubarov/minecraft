---
name: Oasis Aero
description: An old Mac desktop with Frutiger Aero glass over the supplied Asadal landscape.
colors:
  text: "#173c50"
  muted: "#355467"
  link: "#09658f"
  surface: "#f8fcff"
  surface-soft: "#eaf3f8"
  field: "#fff"
  line: "#bfd2df"
  frame: "#b5d3df"
  chrome-top: "rgb(247 253 255 / 72%)"
  chrome-bottom: "rgb(162 208 230 / 35%)"
  glass: "rgb(243 250 255 / 75%)"
  workspace-glass: "rgb(235 247 255 / 25%)"
  content-glass: "rgb(248 252 255 / 88%)"
  panel-glass: "rgb(244 251 255 / 70%)"
  glass-edge: "rgb(255 255 255 / 72%)"
  reflection: "rgb(255 255 255 / 44%)"
  primary-top: "#1875a4"
  primary-bottom: "#086699"
  primary-edge: "#075c8b"
  primary-text: "#fff"
  success: "#247141"
  success-bg: "#e4f4e6"
  danger: "#a9342b"
  danger-bg: "#fff0e9"
  focus: "#006da6"
  backdrop: "#9dcbdc"
  dark-text: "#e4f4fb"
  dark-muted: "#a6c3d2"
  dark-link: "#86d7fb"
  dark-surface: "#172d3c"
  dark-surface-soft: "#1d3849"
  dark-field: "#102534"
  dark-line: "#3d5a6c"
  dark-frame: "#466477"
  dark-chrome-top: "rgb(107 149 174 / 48%)"
  dark-chrome-bottom: "rgb(15 39 59 / 28%)"
  dark-glass: "rgb(12 35 53 / 78%)"
  dark-workspace-glass: "rgb(12 31 48 / 24%)"
  dark-content-glass: "rgb(14 34 51 / 90%)"
  dark-panel-glass: "rgb(38 65 84 / 54%)"
  dark-glass-edge: "rgb(185 226 255 / 28%)"
  dark-reflection: "rgb(205 238 255 / 12%)"
  dark-primary-top: "#1875a4"
  dark-primary-bottom: "#13658e"
  dark-primary-edge: "#56b9df"
  dark-primary-text: "#fff"
  dark-success: "#9ee4ad"
  dark-success-bg: "#1a4235"
  dark-danger: "#ffb4a2"
  dark-danger-bg: "#492e30"
  dark-focus: "#7bdcff"
  dark-backdrop: "#071521"
typography:
  display:
    fontFamily: "'Open Sans', 'Segoe UI', sans-serif"
    fontSize: "24px"
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: "-.5px"
  headline:
    fontFamily: "'Open Sans', 'Segoe UI', sans-serif"
    fontSize: "29px"
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: "-.7px"
  title:
    fontFamily: "'Open Sans', 'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 600
    letterSpacing: "-.2px"
  body:
    fontFamily: "'Open Sans', 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "'Open Sans', 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 600
  code:
    fontFamily: "'Consolas', monospace"
    fontSize: "clamp(25px, 3vw, 34px)"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "2px"
rounded:
  field: "5px"
  control: "5px"
  note: "6px"
  claim: "7px"
  entry: "8px"
  dock: "15px"
  window: "12px"
spacing:
  button: "8px 17px"
  field: "9px 11px"
  note: "13px 16px"
  claim: "21px"
  entry: "23px"
  main: "28px 32px 32px"
  settings: "28px"
components:
  button-primary:
    backgroundColor: "linear-gradient(var(--primary-top), #176c98 49%, var(--primary-bottom) 50%, #126b99)"
    textColor: "{colors.primary-text}"
    rounded: "{rounded.control}"
    padding: "{spacing.button}"
  button-secondary:
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "{spacing.button}"
  button-danger:
    textColor: "{colors.danger}"
    rounded: "{rounded.control}"
  field:
    backgroundColor: "{colors.field}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "{spacing.field}"
  claim:
    backgroundColor: "linear-gradient(var(--reflection), transparent 55%), var(--panel-glass)"
    rounded: "{rounded.claim}"
    padding: "{spacing.claim}"
  entry:
    backgroundColor: "linear-gradient(110deg, var(--reflection), transparent 60%), var(--panel-glass)"
    rounded: "{rounded.entry}"
    padding: "{spacing.entry}"
  note:
    backgroundColor: "{colors.surface-soft}"
    rounded: "{rounded.note}"
    padding: "{spacing.note}"
  aero-card:
    backgroundColor: "linear-gradient(135deg, var(--reflection), transparent 55%), var(--panel-glass)"
    textColor: "{colors.text}"
    rounded: "{rounded.window}"
    padding: "22px"
---
# Design System: Oasis Aero

## Overview

**Creative North Star: "Old Mac desktop / Frutiger Aero"**

The website name is **Oasis Aero**. The menu pairs the sourced Search Globe with an Open Sans wordmark, with Aero in the semantic link blue. The welcome panel, browser title and Account footer use the same name. Minecraft remains the term for game accounts and activity. Bubble rim colors use soft radial patches instead of conic gradients to avoid axis seams when the pointer animates the wallpaper underneath.

Account linking lives in a small desktop: a pearl menu bar, a bottom dock, independent glass windows for Account, Global Statistics, Minigames, Marketplace, Player Controls and Settings, and a quiet animated music player beside the dock. Aqua traffic lights and glossy blue controls bring the old Mac silhouette into the user-approved Frutiger Aero world. Light is the fresh-browser default and carries the supplied Asadal landscape; optional Dark uses smoked blue over a user-supplied night park scene.

The supplied Asadal landscape is decorative, never a depiction of the real server. The portal still has one practical job: register, sign in, and link an in-game identity. Window controls support that work without changing authentication state.

**Key Characteristics:**

- A menu bar and dock launch Account, Global Statistics, Minigames, Settings, and each linked player app; an animated dock-side music player supplies quiet background music.
- Readable pearl or smoked glass, reflective edges, sourced Vista artwork.
- Truthful account status, explicit controls, keyboard access, and responsive windows.

## Colors

The frontmatter records actual semantic CSS values: unprefixed entries are Light; `dark-` entries are Dark counterparts. `frontend/src/index.css` overrides the same roles under `data-theme='dark'`.

- **Primary:** `primary-top`, `primary-bottom`, `primary-edge`, and `primary-text` create reflective blue actions; `link` colors text links.
- **Neutral:** `text` and `muted` separate facts and supporting copy. `surface`, `surface-soft`, and `field` provide readable grounds. `line` and `frame` define boundaries. `glass`, `content-glass`, `panel-glass`, `chrome-top`, `chrome-bottom`, `reflection`, and `glass-edge` build the desktop materials; `backdrop` is the wallpaper fallback.
- **Semantic:** success marks confirmed links; danger marks errors and destructive actions. Sourced Firewall On/Off/Warning artwork accompanies explicit state text. These symbols describe account states, never actual firewall monitoring. `focus` identifies keyboard focus.

## Typography

Open Sans is self-hosted from `frontend/src/assets/fonts/open-sans.ttf`, with Segoe UI and sans-serif fallbacks, weights 300–800, and `font-display: swap`. Preserve its SIL Open Font License. Body copy uses 14px/1.6, labels and actions 600 weight, and the neutral Minecraft menu label 700. Page headings use 29px/1.25 at weight 400; the welcome heading uses 24px/1.25. Window titles are 13px/600; menu controls 12px; dock labels 11px; window footer text 10px.

Code uses Consolas and monospace fallbacks, spaced characters and tabular expiry numerals. Mobile inputs use 16px, page headings 26px, and code 24px with 1px tracking. Long usernames and UUIDs wrap.

## Layout

The desktop has a 40px menu bar and a stage `calc(100dvh - 148px)` high, with a 280px minimum. The dock is fixed bottom-center, 16px above the viewport edge. A single full-viewport wallpaper uses cover sizing: the Asadal scene in Light sits 130px below center, while the user-supplied night park in Dark stays centered in both WebGL and the static fallback to avoid stretching its top edge. There is no floating tagline or second wallpaper in the authentication sidebar.

Account initially opens centered horizontally at y=20px, up to 1000×650px, constrained by the available stage. Global Statistics, Player Controls and Marketplace initially open centered at y=42px, up to 900×560px. Minigames initially opens centered at y=36px, up to 880×580px. Settings initially opens at 440×410px, offset toward the right at y=62px. Desktop windows have minimum widths of 520px (Account, Global Statistics, Minigames, Player Controls and Marketplace) and 380px (Settings), a 240px minimum height, and fit within 12px horizontal / 8px vertical stage gutters. Small stages take precedence over minimum sizes. The active window sits above the other. Contents scroll within each window between title bar and footer. The music player is fixed to the bottom-right at 360px wide and exactly the dock's height: both share a 94px desktop / 84px mobile token. It stays aligned with the dock on wide screens and lifts above it at ≤1100px to prevent overlap. At ≤760px it fits within 8px viewport gutters, with transport, volume, and seeking always visible.

Motion is the old window manager filtered through early-2000s desktop effects: windows flex on opening, deform subtly from drag velocity, and settle through a damped wobbly-glass oscillation when released. Maximize, restore, and Reset use a fast decelerating glide without positional overshoot. Drags follow the pointer 1:1 with no geometry transition; hover and content changes ease in softly. Small concentric click waves expand around pointer clicks (or the activated control for keyboard clicks), above the UI without intercepting input. They are bounded to eight transient elements and cleaned up on completion, hidden tabs, or preference changes. All spatial motion is disabled by `prefers-reduced-motion`.

The active scene is also the live wallpaper. A small dependency-free WebGL shader preserves the sourced image while adding layered ambient movement in the water, autonomous ripple rings, brighter caustic light, cursor parallax, localized RGB refraction, Vista-like lens bloom, and expanding pointer/touch ripples. Large translucent bubbles rise at varied depths with refracted rims, curved highlights, internal reflections, and soft colored shadows, while sunbeams and traveling glints shimmer above the image. The shader's ambient stem and every decorative CSS layer return to their starting state on exact seamless loops, so there is no visible hard cut. It pauses while the page is hidden, caps its pixel budget for stable frame times, swaps its texture between the Light and Dark scenes with the theme, dims and desaturates only the daylight scene in Dark, and falls back to the unmodified static CSS wallpaper if WebGL is unavailable. Reduced Motion always receives the static wallpaper.

Bubble optics use CSS approximations of Fresnel reflection (a bright grazing-angle rim fading into a clear center), thin-film interference (cyan/magenta/gold bands that shift as the film rotates), and sharp white specular reflections. Visual references: [UNSW Physclips soap bubbles](https://animations.physics.unsw.edu.au/jw/light/soap-bubbles.htm) and [Pksois23's macro photograph](https://commons.wikimedia.org/wiki/File:Thin_Film_Interference_Soap_Bubble.jpg). These are references only; no bubble photographs, generated images, or other raster assets are embedded.

Background and inventory bubbles share one CSS glass material: clear centers, cyan lower caustics, restrained thin-film rims and small, softly fading upper-rim glints. Omit closed inner oval outlines that read as a second bubble inside the sphere. Background bubbles retain their existing rise, drift, depth blur and rotating rim film; both themes use the same material roles as inventory.

Account contains a route toolbar and workspace. Authentication uses a 32% welcome sidebar and remaining form column; the sidebar contains sourced icons and explanatory copy. The cabinet places status first across both columns, then linking beside a 285px account-details column with a 28px gap. Registration places name/surname side by side. Main padding is 28px 32px 32px.

At window container widths ≤740px, cabinet content stacks in DOM order, the authentication sidebar hides, and main padding becomes 25px 22px. At viewport widths ≤760px, the menu bar sticks to the top, windows stack at full available width with 10px gutters, and page content scrolls naturally above the fixed dock. Dragging/resizing and maximize/reset controls are disabled or hidden there. Each menu/dock activation focuses its title bar and scrolls the selected mobile window into view, including repeated activation. At ≤380px, registration fields also stack. The HTML minimum width is 320px.

## Elevation & Depth

Window glass is 75% in Light and 78% in Dark; content glass is 88%/90%, and panel glass 70%/54%. Readable content wells sit inside diagonal reflection gradients and bright edges. Window, dock and menu materials use 24px backdrop blur with 145% saturation. Light and Dark window shadows are recorded in the sidecar from `--shadow`. Unsupported backdrop filtering uses solid theme surfaces.

Buttons carry inset highlights and small external shadows; active controls press inward. The dock rises 5px on hover over 180ms; buttons brighten over 140ms. Reduced motion removes transitions, animation, and smooth scrolling.

## Shapes

Windows use 12px corners, the dock 15px, status entries 8px, linking containers 7px, and panels/notices 6px. Buttons and fields use 5px corners. Borders are generally 1px. Traffic-light buttons have 24×28px targets with 14px circular CSS lights; they are native labeled buttons, not raster icons. The supplied status shields render at 48px.

## Components

- **Desktop navigation:** menu and dock launch Account, Global Statistics, Minigames, Marketplace, Player Controls and Settings. Player Controls has a single launcher; its centered native title-bar select chooses among linked accounts, showing the selected nickname and skin head. The Globe is the Account icon; Performance Center marks Global Statistics; the sourced Vista console icon marks Minigames; Personalization marks Settings; a server-reported skin head marks the current Player Controls selection, with Performance Center as its fallback. The six menu and dock launchers scroll horizontally when they exceed the available width. Dock dots indicate open windows. Dock buttons hide their app only when it is open and focused; an open app behind another is raised and focused, and a hidden app reopens. Menu entries continue to raise and focus their app. Closing or minimizing shrinks and fades the glass over 180ms before hiding it, with immediate focus return and inert contents during the exit. Reopening interrupts the exit; Reduced Motion hides immediately. Closing or minimizing hides a window, retains its mounted contents and geometry, and returns focus to its dock control; reopening raises and focuses it. Closing Account never logs out. Logout remains a separate menu action with failure feedback in Account.
- **Music player:** a horizontal transport beside the bottom dock, matching its height. Track selection, previous / play-pause / stop / next, mute, volume (default 30%), looping, and seek with time readout remain visible. Stop pauses and rewinds to zero. Skipping preserves playback intent. Small level bars animate only during playback while the page is visible; controls press gently on activation. No decorative disc or new image assets are used. It starts paused and remembers track/volume/mute. On mobile (≤760px), a centered 44px Music button above the dock reveals or hides the centered transport; controls start collapsed, playback stays mounted, and Escape closes the transport with focus returned to the button. A labeled Credits button opens the full track, artist, and Creative Commons attribution above the strip, dismissible outside or with Escape.
- **Window controls:** drag a title bar or focus it and use arrow keys to move in 10px increments, Shift for 40px. The lower-right grip supports pointer or arrow-key resizing with the same steps. Double-click the title bar or use the green control to maximize/restore; Reset restores initial geometry. Bounds are clamped after changes and viewport resizing. Close, minimize, maximize/restore and Reset have explicit accessible names.
- **Account navigation:** React Router links in `.account-toolbar` use compact `.btn-quiet` chrome and a focus-colored current-route border. A skip link opens Account and focuses main content.
- **Settings:** Appearance contains the visible Color theme label and native Light / Dark / System select. `minecraft-theme` persists explicit preferences. New, invalid, missing or unavailable storage defaults to System; existing Light/Dark/System choices remain valid. System follows OS changes, and storage events synchronize tabs. The early HTML script and `lib/theme.ts` must agree to avoid a theme flash. Storage failure still permits a current-page selection.
- **Player Controls:** one window contains all linked players’ features, with a centered, keyboard-accessible native account selector labeled Player account. Selecting a nickname never drags, moves or maximizes the window. The dock and menu use the fixed name Player Controls; the title-bar picker and dock head reflect the selected account. Statistics, Inventory and Skin toolbar buttons use `aria-current="page"`. Each user/UUID’s selected page, mounted contents, inventory inspection and skin preview survive switching and hiding/reopening; only the selected account refreshes player-specific data. Shared geometry belongs to the window. Empty, loading, sign-in and retry states stay explicit. Skin retains the existing front-facing texture canvas, upload/preview flow and server-acknowledged progress. Account shows the linked count out of four and suppresses further code creation at the limit.
- **Interface sounds:** one delegated system provides a quiet click for buttons and links (including keyboard activation) and for discrete selection changes. Opening/closing use their own lower gains; successful copy uses the short click rather than the download chime. Completion cues follow confirmed success. Only one effect may play at once; typing, focus, dragging, and continuous sliders remain silent. The Sound setting immediately stops effects when disabled and synchronizes playback across tabs. Music keeps its independent volume. Sources and gain details are recorded in `frontend/src/assets/sounds/SOURCES.md`.
- **Minigames:** one desktop window (the sourced Vista console icon) holding both games as cards — Lucky Chest and Minesweeper. A coin pill names the paying linked account and shows that account's server-reported balance, never a sum, with a native select when several accounts are linked. The payer choice is remembered per browser. The window displays the paytable the server publishes — return rate, stake limits and table presets — and draws each round purely from the server's answer: reels, multiplier and payout for the chest; opened cells, current multiplier and cash-out value for the field. Idle, in-flight, refused (not enough coins) and connection-failure states are explicit text with a real retry, a stake is validated before the control enables, an unopened field is never drawn, and a settled round shows the whole field. Reels and ores are named in plain language beside their sourced item rendering; no payout or balance is computed in the browser.
- **Buttons and fields:** reflective 38px-minimum buttons, 33px compact actions, and 42px-minimum fields keep visible labels and semantic error text. Primary buttons use blue chrome and white text; destructive controls use danger roles. Disabled controls reduce opacity/saturation and retain a semantic cursor. Focus is a 3px outline with 3px offset; the title bar draws it inside its frame.
- **Status and linking:** original Vista shields accompany explicit linked/not-linked text. Failed loading offers retry rather than inventing an unlinked state. Code issuance, selectable code, expiry, link polling, account details and Unlink retain their real server-backed states. **Copy command** copies the full `/website link <displayed-code>` command, confirms success accessibly, and leaves a selectable command with manual-copy instructions when clipboard access fails. Panels use ruled rows and definition lists.
- **Notices:** semantic error/success surfaces pair sourced shields with text. Validation, loading failures and logout errors stay readable; failed logout keeps the session state visible.
- **Sourced artwork and audio:** preserve `frontend/src/assets/icons/SOURCES.md`, `cursors/SOURCES.md`, `sounds/SOURCES.md`, `music/SOURCES.md`, font licensing, `ARTWORK.md`, and the wallpaper `.webp.json` provenance/rights sidecar. The original Search Globe, Performance Center, Personalization and Firewall PNGs remain sourced, never generated or redrawn; the music and interface sounds are original archive files, byte-for-byte as served, with the Kevin MacLeod tracks licensed Creative Commons Attribution 3.0 and credited in the player. Green Aero CUR files retain native hotspots and semantic fallbacks, apply only to hover/fine pointers outside forced colors, and leave touch native. Both themes keep a `.webp.json` provenance/rights sidecar. Light uses the sourced `asadal-stock-18.webp`; Dark uses the user-supplied `night-park.webp` at `brightness(.94) saturate(.95)`. No raster or audio was generated for the desktop by this project. Previous generated scenery is removed; former Minecraft font, dirt and wood are unused historical assets.

## Do's and Don'ts

- Do use semantic tokens in both themes and preserve the readable glass opacity hierarchy.
- Do keep window gestures, keyboard alternatives, bounds, focus return and mobile activation together.
- Do preserve theme persistence, early-boot parity, cross-tab updates and OS-following System.
- Do keep labels, semantic states, reduced motion, clipboard fallback, polling and error feedback.
- Do keep live-wallpaper effects subtle enough that the readable glass windows remain the focus, and retain the static-image fallback.
- Don't present wallpaper as a real server view or introduce fake counts, balances, activity or unimplemented features. Marketplace uses real confirmed escrow and existing coin balances.
- Don't roll a die, compute a payout, or keep a balance in the browser: Minigames renders the server's round and the server's balance, and a stake is only ever placed through the API.
- Don't reintroduce pixel-font, dirt, wood or Minecraft sprite chrome, duplicate the wallpaper in Account, or generate replacement artwork.

Statistics includes the database-backed coin balance for each linked Minecraft account and their combined total, plus the full activity set the game server reports: play time, distance traveled, logins, blocks placed/broken, items crafted and picked up, mobs killed, deaths, damage dealt/taken, fish caught, animals bred, items enchanted, tools broken, times slept and advancements. Global Statistics combines only the current user’s linked accounts, never the whole server. Player Controls shows only the selected account’s details, with its nickname and skin head in the title-bar picker and heading. One close/minimize/reopen state and geometry belong to the app; player contents and page choices stay isolated and mounted while linked. Its title-bar account selector changes the controlled player, and statistics share one server snapshot refreshed every five seconds while visible. Metrics render in grouped stat grids (Play & travel, Building, Combat, The wild) reusing the section heading, count, and tabular stat cards; the per-account list keeps its compact cells, and an account's name selects it in Player Controls. Player Controls can also raise Global Statistics. Skin heads use the server-reported texture hash through [MCHeads](https://mc-heads.net/). Missing textures and image failures use original Performance Center artwork. The Skin page draws the actual texture locally with the reported Classic/Slim model; selected uploads have a separate local preview. Appearance never verifies ownership. Requests use `referrerPolicy="no-referrer"`. Distance displays as blocks under 1 km and kilometres beyond; damage as hearts. Earnings copy states 1 coin per authenticated block break and names `/bal` / `/balance`.

Inventory shows what one player is carrying — armor, off hand, hotbar and main inventory — exactly as the game server last reported it, and invents nothing: until a snapshot arrives the page says so instead of drawing an empty bag. Every slot is a gently bobbing bubble: the same clear glass, grazing rim, diagonal highlight and thin-film rim bands as the wallpaper bubbles, held in a compact grid. Inside sits the item's official Minecraft texture packaged for the server version, so a picture always matches the version that reported it; a light pill carries the amount, a thin bar carries wear (green → amber → red) only for a damaged item, and an enchanted item's bubble takes a soft violet aura. Empty slots stay as dimmer, quieter bubbles, so the grid still reads as an inventory rather than a scatter of objects. Bubbles are inspectable surfaces: hovering, keyboard focus or touch reveals an immediate, opaque, theme-aware tooltip with the name, amount, durability and enchantments; Escape dismisses it, and screen readers receive the same description, and sections keep the game's own layout (Equipment with Helmet / Chestplate / Leggings / Boots / Off hand labels, Hotbar, Main inventory) in nine-column grids that shrink with the window. An unknown item texture falls back to the sourced Performance Center artwork with the item name; no icon is generated. The page refreshes every five seconds while visible, shows real loading, empty and error-with-retry states, and all bubble motion is removed under reduced motion.

Inventory bubbles use a clear center, a crisp Fresnel rim, restrained thin-film color, small soft upper-rim glints and a cyan lower caustic. Empty slots retain quieter reflections. Tooltips render in a viewport-bounded portal so window scrolling cannot clip names. Armor maps Bukkit slots 39 → helmet, 38 → chestplate, 37 → leggings, 36 → boots.

Bubble highlights must fade directly into the sphere: no broad filled oval or sharply bounded reflection patch across the upper hemisphere.

Inventory bubbles bob by just 3px vertically and 1px horizontally on staggered 5–6.4 second loops, pausing on cell hover or keyboard focus. Nine-column grids cap at 568px and equipment at 312px, with 8px gaps (6px in narrow windows), so wide windows do not spread bubbles apart.

Registration uses the existing form/notice styles in two steps: account details and then mailbox confirmation. The confirmation step shows the destination email, one labeled six-digit code field with one-time-code autocomplete, a server-derived expiry countdown, confirm/create and resend actions, and a way to change details. Failed/expired codes and delivery failures remain explicit. Mailpit preview mode explains local delivery and links to its inbox; real SMTP mode omits that notice. Passwords/challenges remain in memory for this flow, and account creation is followed by sign-in or a clear login fallback.

The sign-in form labels its identity field “Email or login,” accepts plain text with username autocomplete, and uses the same generic credential error for either identifier.

Filled inventory bubbles are native buttons: click, touch or keyboard activation opens inline inspection with **Send to Marketplace** and **Cancel**. The form names the stack, lets its owner choose a quantity and independent per-item / whole-lot prices in coins, and explains server-confirmed removal and unsold-item returns. At least one price is required. Dismissal restores focus to the bubble. Pending, confirmed transfer, changed-stack and request-error feedback stays explicit; old snapshots without fingerprints explain that the player must close details and reselect after the server refresh.

**Marketplace** is an Operate surface inside the existing desktop: independent menu/dock launcher, sourced Search Globe artwork, statistics-sized draggable/resizable window, focus return, retained mounted content and responsive stacking. No new visual identity or assets. Browse and My listings use reflective native buttons; search and cursor pagination stay labeled. Listings sit in ruled rows with the very same ItemBubble component as inventory (official texture, count, wear, enchantment glow, portal tooltip and reduced motion), plus item name, seller, real remaining quantity and both offered prices. Clicking the name or bubble opens inline details. Buyers choose their linked player, quantity or whole lot, review the total and confirm. Pending and unsuccessful transfers remain private to the seller. Successful purchase/cancellation shows delivery feedback; Deliveries & returns distinguishes queued from server-acknowledged completion and explains storage-space waits. Selling fields stack in narrow windows and both themes use the existing semantic tokens.

Item inspection and Marketplace details unfold down from their top edge over 240ms using a clipped glass reveal and a small vertical expansion. Selecting another item restarts the reveal; controls and focus are immediately usable. Reduced Motion shows the panel immediately.
