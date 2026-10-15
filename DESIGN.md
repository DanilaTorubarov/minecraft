# Design

The panel's look is the game's own. It stands on the Minecraft dirt block, is set
entirely in **Minecraft Rus**, and every box on it is a **Minecraft widget**. None of it
is fetched at runtime; the face and the texture are committed assets, and the widgets are
built from the game's own sprite colours.

## The world: an interface on dirt

Earlier drafts treated the page as a dim, text-led surface. The brief changed twice: the
operator asked for the dirt block as the ground for the whole site and for the game's
font, and then for the boxes on it — the entry band and the form fields — to be *the
game's buttons*. That is the world now, and everything below follows from it.

The reference is the game's **texture and its widgets** — a 16×16 block, a face with no
weights, and a grey beveled button sitting on top of it.

## Ground and material

- The page is `frontend/src/assets/dirt.png`, the game's 16×16 dirt block, tiled at
  **64px** with `image-rendering: pixelated`. At its native 16px it reads as noise; at
  64px it reads as blocks.
- `--dirt-scrim` (`rgba(27, 29, 34, 0.7)`) is painted over it, so the texture shows
  through at 30%. It is tuned against the texture's **brightest speckle**
  (185,135,135), not its average: bone on the raw block is only 1.6:1 there, and at
  45% the dirt became the loudest surface on the page.
- Text sitting *directly* on the dirt carries the game's hard shadow,
  `1px 1px 0 rgba(10, 11, 13, 0.72)`. It is switched off on every widget — `.entry`,
  `.claim`, `.panel`, `.code`, `.field input`, `.btn`, `.note`, `.lamp` — because those
  have their own ground and the game draws its own text plainly.
- The widgets are opaque, so they read as interface windows resting on the material
  rather than as translucent overlays.

## The widgets

Every box is one chrome: a **1px `#000000` outline** with a **2px bevel** inside it. The
2px is the sprite's own 1px bevel at the game's default GUI scale of 2. Two directions,
and the direction is the affordance:

- **Raised** — `.entry`, `.claim`, `.panel`, `.btn`, `.note`. Light top-left, dark
  bottom-right. A thing you press or read.
- **Sunken** — `.field input`, `.code`, `.lamp`. Dark top-left, light bottom-right. A
  well you type into or a slot that holds something.

The colours are **sampled from the 1.20.2 sprites**, not guessed at:

| State | Face | Top-left | Bottom-right | Outline |
| --- | --- | --- | --- | --- |
| `button.png` | `#6f6f6f` | `#aaaaaa` | `#565656` | `#000000` |
| `button_highlighted.png` | `#757575` | `#afafaf` | `#5c5c5c` | `#ffffff` |
| `button_disabled.png` | `#2c2c2c` | `#2b2b2b` | `#292929` | `#000000` |
| the primary action | `#c6c6c6` | `#ffffff` | `#555555` | `#000000` |

- Hover is the **highlighted sprite**, and its white outline — not a lighter fill — is how
  the game says "this one".
- Disabled is the **disabled sprite**, a whole different face, not a faded live button.
- `#373737` and `#555555` are the palette's darker greys; they are the insets.

### The primary action

The game has no primary button, so the panel borrows the one face its palette has that
reads as brighter: **`#c6c6c6`**, the light grey of the container chrome. It keeps the
same outline, the same 2px bevel and the same shape as every other button, and it is the
only widget face light enough to carry **dark type** — which is what makes it read as a
different kind of object rather than a bigger version of its neighbours. An amber primary
was the first attempt and it was wrong: it was the only thing on the page that was not the
game's colour.

### The wood well

The one well that is not a grey is the **code well**. It is not a hole in the page either:
`.code` is the game's own **oak planks**, committed as `frontend/src/assets/wood.png` and
tiled at **32px** — a 16px texture at the game's default GUI scale of 2, the same scale the
widget bevels are drawn at. It keeps the shared sunken chrome, because planks set into a
GUI are a recess, not a button.

The planks are a **mid-tone**, and that is the whole difficulty with them: end to end they
span only **3:1** (`#67502c` to `#c29d62`), so *no* type colour can reach 4.5:1 on the raw
block — white tops out at 2.5:1 and ink at 2.2:1. So the wood gets what the dirt gets, a
**scrim**: `--wood-scrim` at 45% takes the brightest plank down to where white clears it
(6.1:1) and still shows the grain and the plank seams. The expiry wants the page's amber,
which is far too dark for a scrimmed plank, so it takes `--amber-light` — the same hue,
lit for a dark surface (4.6:1).

The wood is for the code itself and nothing else. The `/link <code>` chips around it stay
the `#373737` inset they always were: a command is written on an inset, and the well is for
the one string you copy out of it.

### Colour cannot be type here

`#6f6f6f` sits in the middle of the luminance range: to clear 4.5:1 on it, text has to be
**white** (5.02:1). Nothing dimmer passes, and no colour at all does — `--live` on that
grey is 2.3:1. So the game's own answer applies:

- **Widget text is white.** Hierarchy comes from **size and case**, which is exactly how
  the game does it. The entry band's name is 32px, its message 16px, its state 12px; a
  data row's name is 20px and its metadata 16px.
- **Colour moved into blocks and wells.** The lamp is a coloured block in a dark slot; the
  note's tone is an outlined block; the entry's state is a chip — coloured type on a
  `#373737` inset, where green is 5.5:1 and red 5.2:1.
- **The code well is wood.** `.code` is the one surface that is a **material** rather than a
  grey — the game's own oak planks under a scrim, with white type. It is the honest shape
  for the one string you carry into the game, and the scrim is what buys white the 6.1:1
  the raw planks cannot give it. See "The wood well" above.

### Consequences that are deliberate

- **No placeholders.** On `#6f6f6f` the only placeholder that clears 4.5:1 is white, which
  is indistinguishable from typed text. Rather than ship an empty field that looks filled,
  the email placeholders were removed — and the form is now consistent, since no other
  field ever had one.
- **The entry band is not clickable** even though it wears the button chrome. In the game,
  panels and buttons share the chrome; here the hover outline is what marks the real
  buttons.
- **The data sections sit on a panel too.** The account details and the linked accounts
  rest on the same grey box as the entry and the claim, so nothing floats on the dirt.
  A grey panel cannot dim its own text, so those tables separate label from value by
  **size and case** instead of by tone.

## Type

One face, **Minecraft Rus** (© 2004–2012 BOGDAN Software), self-hosted as a single TTF.

- It is drawn on an **8px em** — a stem is exactly 1/8 em — so every `--step-*` is a
  multiple of 4. That keeps the stems on the grid at both 1× and 2×; an off-grid size
  goes soft and the whole thing reads as a blurred sans. 8px is the size the game
  itself uses and is unreadable here, so the scale starts at 12px.
- There is **one weight**. `font-synthesis: none` stops the browser faking a bold,
  which would smear the pixels, so hierarchy is **size, colour and case** — never
  weight. Nothing may ask for `font-weight: 600`.
- `-webkit-font-smoothing: none` keeps the glyphs snapped.
- Letter-spacing is whole pixels only; a fractional track moves glyph origins off the
  grid.

## Palette

Two palettes, and they do not mix: the **world's** (text on dirt) and the **game's**
(everything inside a widget). The code well is the one place a **block** appears inside
the interface, and it is still governed by the game's palette: white type, and a scrim
standing in for the grey it does not have.

| Token | Value | Job |
| --- | --- | --- |
| `--ground` | `#1b1d22` | the dark the dirt is scrimmed toward |
| `--ground-row`, `--rule`, `--rule-strong` | `#262a31`, `#333841`, `#4a515e` | ruled rows, hairlines, scrollbar |
| `--bone` | `#d8dee9` | text on the dirt, and on dark insets |
| `--bone-dim` | `#a4adbb` | secondary text on the dirt — lifted from `#98a1b0`, which fell under 4.5:1 once it sat on a mid-tone texture instead of flat ground |
| `--live` | `#8fbf4a` | linked — as a block, or as type on a dark inset |
| `--amber` | `#e0a33a` | the focus ring, and selection |
| `--amber-light` | `#f8dca0` | the code's expiry — the same hue, lit for the scrimmed planks |
| `--down` | `#f0937f` | failure text on the dirt, and the **not-linked** state — raised from `#e0705f`, which was 4.08:1 there |
| `--down-deep` | `#a33b2a` | the face a destructive button turns when hovered |
| `--ink` | `#1b1d22` | the dark that light surfaces take — selection, and the primary button |
| `--wood-face`, `--wood-scrim` | `#66502f`, `rgba(28, 18, 8, 0.45)` | the code well: the fallback under the planks, and the scrim that makes white clear 4.5:1 on them |
| `--gui-face` … `--gui-slot-lo` | see the table above | the game's widgets — faces, bevels, outlines, and the `#373737`/`#555555` insets |

Red means **a problem**, and there are exactly two: the account is not linked, or you are
about to destroy something. The state is a traffic light — green is linked, red is
anything else — and only `.btn-danger` (Unlink) turns red as a button, and it turns its
**whole face**, because a destructive action should look different, not just sound
different. Nothing else on the page is red.

## Geometry and motion

- **Square corners everywhere** (`--radius: 0`). A pixel face inside a 12px radius is
  two worlds arguing.
- Elevation is the bevel, never a drop shadow.
- The signature move is the **entry band**: a status lamp, a large in-game name, and a
  two-line message — the shape of a multiplayer server list entry, drawn as the game's
  button. The lamp is a square block, not a circle.
- Motion is a 140ms colour/border transition. Nothing slides, nothing bounces.

## What is deliberately absent

- **No invented server name.** The wordmark is a signal glyph, because the operator
  never named the server and inventing one would be a claim they never made.
- **No statistics.** The panel shows what it knows — `1` linked account — and does not
  fabricate numbers to fill space.
- **No imagery, icon set or illustration.** The texture, the face and the widgets carry
  the world.

## When changing the panel

- A new size must be a multiple of 4, or it will be soft.
- Text on the dirt needs the shadow; text in a widget must not have it.
- **Nothing but white text goes on a `#6f6f6f` face.** If a colour is needed, put it in a
  block or on a dark inset. The one exception is the primary button, which is `#c6c6c6`
  and therefore takes `--ink`.
- A new widget takes the shared chrome from `index.css` and only sets its own face and
  type — never its own `border` or base `box-shadow`, which would override the chrome.
- There is **one primary per screen**, and it is the light grey, never a new colour. If
  everything is emphasised, nothing is.
- Anything that is data rather than an action goes in a `.panel`, so it rests on the
  game's surface instead of the dirt.
- The bar's contents live in `.topbar-inner`, which mirrors `.main`'s `--shell` width.
  Padding on `.topbar` itself puts the wordmark on a different grid from the page — a
  47px offset at 1086px, and 464px at 1920px.
- A new scrim value has to be re-tuned against the texture's brightest speckle, not
  its mean — the dirt's against `(185, 135, 135)`, the planks' against `#c29d62`. The
  planks need it at all because they span only 3:1 end to end: on the raw block white
  is 2.5:1 and ink 2.2:1, so no type colour clears 4.5:1 without the scrim.
- The wood is only for the code. A command goes on a `#373737` inset, as it always did.
