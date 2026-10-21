# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Players of a public Minecraft server, arriving either from the game or from a link someone shared. Most are strangers to the site. They play on a cracked (offline-mode) server, so their only identity in game is a username anyone could have typed, and they come to the panel to do one job: tie a website account to their in-game name so the server knows who they are.

A second user is the operator, whoever runs the server and the Compose stack. They are an owner-role inside the panel: the first registered account is an administrator, and further operators are granted by configuration. They also work through the database and the container logs when the panel has no control for something.

## Product Purpose

The panel gives a Minecraft server the account system it cannot have on its own. An offline-mode server has no way to verify that the player typing a username is that player. The panel is where a person links an authenticated in-game name to a website account, then views activity and manages that player’s server skin. AuthMe still authenticates every in-game session; a website link does not replace that gate. Success is a player who can link once and manage their linked players without sharing a game password.

## Positioning

The panel never sees or stores a Minecraft password. In-game authentication stays inside the game server, and the panel holds only the claim "this website account owns this in-game name" — established by a single-use code redeemed from inside the game, by a player who has already authenticated there. A panel that asked players to type their game password into a website could not truthfully make that claim.

## Operating Context

- The whole stack is self-hosted in Docker and is meant to be moved to another host by copying files. Ownership and activity are stored locally; skin signing uses MineSkin and previews/heads use external image services.
- Players reach the panel over HTTPS at the operator's own domain, or at `https://localhost` during local development.
- The in-game half is a small Java plugin. When a player authenticates in game, it tells them in chat that their account is not linked, and where to link it.
- Linking is a two-sided ritual: ask the site for a short code, then type `/website link <code>` in game. Both halves are required, and neither one alone proves anything.
- The server renders a live map of its world with BlueMap, served on the same host under `/map/` and shown inside a desktop window; the panel does not render or store any part of the map itself.
- The game server and the website share one chat channel: the plugin relays in-game chat to the panel, and a message sent from the panel is broadcast in game.
- The server is cracked, so an in-game account is a username rather than a Mojang-verified identity. The panel's link is what gives that username a real owner.

## Capabilities and Constraints

Confirmed:
- Daily contract coin issuance is budgeted over a 60-day recovery period with frozen fair shares and a newcomer reserve. New players complete a mining/smelting objective, then choose hunting, fishing or farming; new quests give coins without bonus iron or XP, while already-accepted rewards remain fixed; voluntary equipment repairs (iron equipment, golden/diamond/netherite armor) use confirmed quotes, tiered pricing, and protected wallet reserves. Private-block teleport is planned and currently unavailable without charge. This does not enforce a personal mining requirement for advanced crafting.
- Private block protection system: players can buy up to 3 Private Blocks with coins (1st: 500, 2nd: 20,000, 3rd: 50,000 coins). Cores are fueled exclusively with custom crystal items (Ember Shard, Cobalt Crystal, Crimson Core, Astral Void Crystal) harvested in the 5-minute Mining Dimension (4-hour cooldown), providing tiered protection areas from 3×3 up to 15×15. Mined nodes in the mine automatically regenerate from bedrock on a cooldown. Prospector Pickaxes (Tiers 1–4) are purchased through the Miner's Shop (/minershop) with coins.
- The economy targets 70,000 coins per qualifying active UUID, with daily smoothing, a neutral band and bounded gradual changes to quest rewards, seller fees and game probabilities. One policy applies to everyone; prices are not inferred from money supply. See ECONOMY.md for precise rules and limits.
- Each Minecraft UUID owns a coin balance shared between the game and website. After AuthMe login, a UUID receives one 100-coin starter grant and can accept bounded mining, fishing, farming or hunting contracts with `/quests start`; test block income is removed. `/bal` and `/balance` show the player's own balance; Statistics shows each linked account and their combined total. Existing balances are preserved; historical activity is not retroactively rewarded. A permanent ledger records coin changes. Balances survive unlinking.
- Register with a six-digit email confirmation code valid for 15 minutes, log in, log out, and a session that lasts 24 hours, absolute. The account is created only after mailbox confirmation; code resends and attempts are limited. Existing accounts retain login access.
- A website account is identified by a **displayed nickname** and a separate unique login, plus a verified email address. There is no first/last name; the nickname is what the panel and website chat show.
- The **Security** page changes the account's own website password and email. A password change signs out every website session and cancels pending email changes. A new email address only replaces the old one after that mailbox confirms within 15 minutes; until then the current address stays active.
- One website account may link up to four Minecraft accounts and can unlink them. AuthMe permits up to four in-game registrations per IP address; existing links and registrations are preserved.
- The **Minigames** window spends and returns the very same coin balance `/bal` reports, in two games: Lucky Chest (three reels) and Minesweeper (a 5×5 field with TNT and ores). Coins live on one UUID, so one linked account pays, chosen by the player when several are linked. Every round is created, charged and resolved on the server — the browser sends a stake or a cell and is told the outcome — and every coin change is one guarded update to the balance the game server reports into. Baseline returns are 91.8% for Lucky Chest and 92.6–92.8% for Minesweeper, with small public economic adjustments fixed per round, one round per game is live at a time, and a round nobody returns to forfeits its stake after fifteen minutes. With no linked account there is no play and no simulated one.
- One website account may own one or more linked Minecraft accounts, and can unlink them.
- After in-game authentication, `/website email` privately reminds the player of their linked website email using a masked address. It does not verify the email or reset a password.
- A link code is single-use, valid for five minutes, and only the newest one per account works.
- The cabinet shows the account's link state, and can mint a code to redeem in game while unlinked.
- Rate limiting and account lockout are enforced server-side, and a locked account is indistinguishable from a wrong password.
- Global Statistics combines only the current website user’s linked accounts, never the whole server. **Player Controls** is one independent app for managing a selected linked Minecraft account, chosen from its native title-bar account picker. Its Statistics, Inventory, Skin and Privates pages remain isolated by user/UUID and retain each player’s page and mounted contents while switching, hiding and reopening. The window keeps one shared geometry; the dock and menu have one Player Controls launcher instead of one launcher per nickname. All statistics use one user-scoped server snapshot refreshed every five seconds while visible. The panel never measures or invents activity and shows honest empty states until the game server reports it.
- The **Inventory** page in a player app shows that player's own carrying — armor, off hand, hotbar and main inventory — as the game server last reported it: per slot the item, its amount, wear, custom name and enchantments. The game server measures and reports the whole 41-slot layout; the panel keeps the latest snapshot and the website invents nothing — no item, no amount, no filled-in empty slot — and says so until the server has reported one. Item pictures come from the official Minecraft client textures packaged for the server version and are stored once per item key; an item with no readable texture shows sourced Performance Center artwork beside its name. One player's inventory is visible only to the website account that linked it. Selecting a stack lets its owner send a chosen quantity to Marketplace, online or offline. Pending work is durable, stale stacks are rejected, and items become available for sale only after the game server acknowledges removal. Offline snapshots come from the saved player file, and never imply that the player is online.
- **Player Controls** contains all player features: Statistics, Inventory, Skin and Privates. Choosing another linked player changes the controlled account without mixing their inventories, uploads, private blocks or balances. Global Statistics account links and Marketplace inventory shortcuts open this same app with the requested account selected.
- The **Privates** page lists the selected player's own Private Blocks with their placement, protected area, remaining fuel and trusted members, and lets the owner deposit a fuel crystal from that player's inventory. The page shows only what the game server reported; a block's protection still runs in game.
- **Offline Mail & Delivery Parcel System**: Players can send items or currency (coins) to offline players directly from the website marketplace or inventory, or from the Mail tab in Player Controls. Sent parcels are held safely in escrow. When the recipient logs into Minecraft, they receive an alert: `You received a delivery from [Player]! Type /mail claim.` Typing `/mail claim` delivers their items and credits coins in game, dropping overflow items safely if inventory space is constrained.
- **Territory Alerts**: Automated web alerts notify players when a private protection core's fuel drops below 2 hours or when a siege breach charge is detonated on their base. Alerts appear in the desktop stage, in the menubar with warning badges, and inside the Privates defense panel with one-click navigation to the affected core.
- The **Hall of Fame & Leaderboards** window ranks the server's players by wealth, play time, mob kills, blocks broken, blocks placed, distance travelled and advancements unlocked. Every row is a UUID the game server has reported on, with a server-reported skin head; the window never mixes a website user's accounts with a server-wide ranking.
- The **Chat** window shows the one shared channel between the website and the game. The message history needs no session at the API, though the window itself sits in the signed-in desktop; posting needs an account, and the message appears under that account's displayed nickname. Messages sent from the website are broadcast in game, and in-game chat arrives in the same window.
- The **Live Map** window embeds the BlueMap render of the server world served from the same host. It offers the same world as a 3D perspective or free-flight camera, or as a flat 2D top-down plan, and the panel controls only the window and camera around it — it never draws a map of its own or invents a waypoint.
- The **Admin Panel** is operator-only, shown to accounts granted administrator status (the first registered account, `users.is_admin`, or configured operator emails/logins). An operator can inspect player accounts and set, add or subtract a player's coins; every adjustment is written to the permanent ledger and audited, so no admin change is invisible to the economy's accounting.
- The Skin page shows the server-reported texture/model and accepts a standard PNG upload for an owned player, with Classic/Slim choice and a local preview. MineSkin signs the cleaned image as unlisted; the game server stores it through SkinsRestorer even while the player is offline. Progress distinguishes preparation, waiting for the server, saved and failed. Saved acknowledges server storage, not verified rendering on every client. Uploads affect this server only, and pending work survives app restarts.
- Player app heads use the server-reported texture hash through [MCHeads](https://mc-heads.net/), with sourced Performance Center artwork until a texture is known or if loading fails. The body preview draws the actual texture from `textures.minecraft.net`. Appearance does not verify identity; client skin mods can override what a player sees.
- The corner music player plays only sourced, attributed audio (Creative Commons tracks credited on-screen, plus the archive's own ambience loop); it starts paused, keeps its own quiet volume, and the interface-sound toggle in Settings is persisted per browser. No audio or artwork is generated; everything carries a provenance sidecar.

- **Marketplace** is an independent desktop app using the same inventory bubbles. Sellers choose a quantity and optional per-item and whole-lot coin prices (at least one required); both prices may differ. Listings can be created either on the website from the Inventory page or directly in-game using `/sell <price> [price for stack]` while holding an item or block stack in the primary hand (if omitted, the stack price defaults to `price * quantity`). Players can also browse, search and buy items directly in Minecraft via `/market` (or `/ah`), which opens a chest auction-house GUI showing authentic items, seller names, prices, pagination, and player coin balances; purchasing in-game or on the web debits the buyer, credits the seller minus commission, and queues immediate delivery into inventory space. Items listed in-game are escrowed through the same transactional receipt task pipeline and become active on the shared marketplace. Other website accounts can buy a quantity at the unit price or all remaining items at the lot price. After partial sales, the whole-lot price scales proportionally from the original offer, rounded up to a coin. Purchases debit the selected linked player and credit the seller minus the accepted 0–5% commission in one transaction, with permanent order receipts for safe retries. Lossless item data stays in escrow; deliveries and unsold-item returns wait for storage space, online or offline. Each player can have at most five pending delivery items queued in escrow waiting for inventory space; further purchases and listing cancellations are rejected with a capacity error until pending items are delivered into the player's inventory. Unlinking is blocked while that player has active listings or pending transfers/deliveries. No real-money payments are involved.

Planned, not implemented:
- Coins are earned in game and staked in the two minigames. Nothing else in the panel trades, bets or converts them.

Deliberately undecided:
- The server's name. The panel's copy stays neutral until there is one.

## Brand Commitments

The website is named **Oasis Aero**, chosen by the user. Its wordmark pairs the sourced Search Globe with the name in Open Sans and a blue Aero accent. Preserve the old Mac / Frutiger Aero desktop and plain, practical copy; keep Minecraft terminology for game accounts and activity.

## Evidence on Hand

Real material the panel can show: the account's own displayed nickname, login, and email; whether it is linked; the linked account's Minecraft username and UUID; when the link happened; and, for linked accounts, the play time, blocks placed, blocks broken, first-seen and last-active that the game server reported. Server-wide leaderboards reuse those reported activity and balance numbers, and the chat window shows real messages from the game and the site. There are no testimonials, player counts, or benchmarks, and none may be fabricated.

## Product Principles

- Prove, don't ask for trust. The panel's authority comes from a code redeemed inside the game, never from a password typed into a browser.
- One job per screen. A player arrives to link an account, and the interface should make that the obvious next act.
- Never show a number the server does not know. An honest empty state beats a plausible-looking placeholder.
- The panel explains the game, not the other way round. A stranger must be able to read the instructions and act without asking anyone.
- The stack must survive being copied to a new host. Local state must travel with it; external signing and image services remain explicit dependencies.

## Accessibility & Inclusion

No product-specific requirement was established beyond the web baseline. Keyboard focus, contrast, and reduced-motion respect are expected defaults.
