# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Players of a public Minecraft server, arriving either from the game or from a link someone shared. Most are strangers to the site. They play on a cracked (offline-mode) server, so their only identity in game is a username anyone could have typed, and they come to the panel to do one job: tie a website account to their in-game name so the server knows who they are.

A second user is the operator, whoever runs the server and the Compose stack. They are not a designed-for role on the site; they administer through the database and the container logs.

## Product Purpose

The panel gives a Minecraft server the account system it cannot have on its own. An offline-mode server has no way to verify that the player typing a username is that player. The panel is where a person proves they own an in-game name, once, so that every later session can be trusted. Success is a player who registers, links, and never has to think about it again.

## Positioning

The panel never sees or stores a Minecraft password. In-game authentication stays inside the game server, and the panel holds only the claim "this website account owns this in-game name" — established by a single-use code redeemed from inside the game, by a player who has already authenticated there. A panel that asked players to type their game password into a website could not truthfully make that claim.

## Operating Context

- The whole stack is self-hosted in Docker and is meant to be moved to another host by copying files. There is no managed service behind it.
- Players reach the panel over HTTPS at the operator's own domain, or at `https://localhost` during local development.
- The in-game half is a small Java plugin. When a player authenticates in game, it tells them in chat that their account is not linked, and where to link it.
- Linking is a two-sided ritual: ask the site for a short code, then type `/website link <code>` in game. Both halves are required, and neither one alone proves anything.
- The server is cracked, so an in-game account is a username rather than a Mojang-verified identity. The panel's link is what gives that username a real owner.

## Capabilities and Constraints

Confirmed:
- Register, log in, log out, and a session that lasts 24 hours, absolute.
- One website account may own one or more linked Minecraft accounts, and can unlink them.
- After in-game authentication, `/website email` privately reminds the player of their linked website email using a masked address. It does not verify the email or reset a password.
- A link code is single-use, valid for five minutes, and only the newest one per account works.
- The cabinet shows the account's link state, and can mint a code to redeem in game while unlinked.
- Rate limiting and account lockout are enforced server-side, and a locked account is indistinguishable from a wrong password.
- The statistics window shows, per linked account, play time (time online after in-game login), blocks placed, blocks broken, first-seen and last-active, and a summary across all of the user's linked accounts. The numbers are measured by the game server's plugin and reported to the panel; the panel never measures or invents them, and shows an honest empty state until the server has reported activity.
- The corner music player plays only sourced, attributed audio (Creative Commons tracks credited on-screen, plus the archive's own ambience loop); it starts paused, keeps its own quiet volume, and the interface-sound toggle in Settings is persisted per browser. No audio or artwork is generated; everything carries a provenance sidecar.

Planned, not implemented:
- A server map and player trading with an in-game currency are user-confirmed future directions. Their data sources, mechanics, and interface are not implemented; do not show a map, market, balance, or related navigation as available today.

Deliberately undecided:
- The server's name. The panel's copy stays neutral until there is one.

## Brand Commitments

None. There is no name, logo, or established voice yet, and copy stays plain and neutral. Nothing may claim a brand the operator has not chosen.

## Evidence on Hand

Real material the panel can show: the account's own name, surname, login, and email; whether it is linked; the linked account's Minecraft username and UUID; when the link happened; and, for linked accounts, the play time, blocks placed, blocks broken, first-seen and last-active that the game server reported. There are no testimonials, player counts, or benchmarks, and none may be fabricated.

## Product Principles

- Prove, don't ask for trust. The panel's authority comes from a code redeemed inside the game, never from a password typed into a browser.
- One job per screen. A player arrives to link an account, and the interface should make that the obvious next act.
- Never show a number the server does not know. An honest empty state beats a plausible-looking placeholder.
- The panel explains the game, not the other way round. A stranger must be able to read the instructions and act without asking anyone.
- The stack must survive being copied to a new host. Nothing may depend on a machine the operator does not control.

## Accessibility & Inclusion

No product-specific requirement was established beyond the web baseline. Keyboard focus, contrast, and reduced-motion respect are expected defaults.
