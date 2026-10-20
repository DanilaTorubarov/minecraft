# Coin economy

Migration `0016` replaces test block-break income. Existing balances are preserved;
statistics reports, including reports from older plugins, create **no coins**.
Deploy the API and LinkBridge **1.10.0** together. No balance reset or historical
activity payout is part of this migration.

## Daily issuance and practical quests (migrations 0017/0018)

The implemented package uses a 60-day recovery period, a 20% newcomer allocation,
a mining/smelting starter objective, repeatable hunting/fishing/farming quests,
and voluntary iron repairs. New quests issue coins only; they do not grant iron,
bread or bonus XP. Private-block teleport is
reserved at 25 coins, **unavailable until private blocks exist**; neither the
command nor API charges for it. Existing wallets and accepted contracts keep
all their coins and promised terms.

At the first daily review, the server freezes a coin budget and each eligible
UUID's allowance. Funding is the seven-day EMA of yesterday's signed net removal
(market fees, service payments/refunds and settled game losses/wins), plus the
smoothed target-money gap divided by 60, minus yesterday's starter grants.
The result cannot be negative, changes by at most max(10% of the previous budget,
25 coins per eligible UUID), and cannot exceed 1,200 per eligible UUID. A shrinking
cohort can force a faster cap reduction. No qualifying active population means no
new contract-coin funding; this is not a guarantee of immediate monetary recovery.

Allocation eligibility differs from the stricter population-target qualification:
a known UUID must have been registered before today and have five active minutes
in the previous thirteen completed UTC dates. Offline eligible players retain
their frozen share for the day. Eighty percent is shared across that cohort;
twenty percent is shared across its first-14-day identities (or joins the main
pot when there are none). Rounding priority rotates; shares are capped at 1,200.
Unused funding expires. Logging in first cannot consume somebody else's share.
A newcomer receives 100 coins once and may immediately start the iron-work
objective, even with a zero coin offer. After five active minutes, their coin
allowance starts at the next daily allocation. A zero offer stays zero if that
already-accepted quest finishes later; waiting until a funded day before
accepting can produce a coin reward.

A contract offers min(base reward, remaining personal allowance). Acceptance
reserves that exact amount in its original day's book; later policy changes and
midnight do not change it. Payment moves reserved coins to issued coins once.
Pending promises count in measured supply. Durable plugin reports may arrive
late; explicit contract queries flush the outbox before expiring old work and
releasing its reservation. Legacy contracts without a budget day are honored.
Upgrading after today's old policy review creates a zero budget until tomorrow,
without rewriting the historical review.

New players first accept **iron work**: mine ten iron ore blocks and smelt/extract
ten iron ingots. Both counters must reach ten; buying or holding iron alone is
not progress. Actions count only after acceptance. Mining requires an ore break
that can drop raw iron (not Silk Touch), with drops enabled. New player-placed
ore and piston-moved ore are excluded using persistent chunk markers. Older
placed ores cannot be distinguished from world-generated ore retroactively.
Smelting counts ingots manually extracted from furnace/blast-furnace results;
hopper extraction has no player to credit. The gathered/smelted items remain
ordinary player items; the quest does not add bonus iron, bread or XP. Vanilla
XP from gameplay is unaffected. Completion unlocks repeatable quest selection.

Commands after AuthMe login:

- `/quests`: sync progress and show the accepted quest and fixed reward.
- `/quests start`: accept iron work if onboarding is incomplete, otherwise hunting.
- `/quests start hunting`: kill eligible natural hostile mobs (base ten).
- `/quests start fishing`: catch fish with a rod (base five). Cod, salmon,
  tropical fish and pufferfish count; junk, treasure, pickups and fish kills do not.
- `/quests start farming`: manually break mature wheat, carrots, potatoes or
  beetroot crops (base sixteen blocks). Immature crops and automatic water/piston
  harvests do not count; Fortune yield does not multiply block progress.

All objectives require authenticated Survival play. One quest is active per UUID;
choosing another type resumes the accepted quest instead of replacing it.
There are four acceptances/day shared across types, including expired attempts,
and a 24-hour deadline. Expired unfinished starters can be tried again but do
not bank progress into the next attempt. Repeatable targets scale using lifetime
quest earnings: hunting uses the formula below; fishing uses ceil(hunting/2),
farming ceil(hunting*16/10). Iron work always requires ten of each action. The
coin reward uses the same base curve and personal funding share for every type.
No funded reward means no new repeatable offer; a zero-coin starter still serves
as onboarding and shows that exact offer before work.

Existing players with an accepted/completed quest at migration are treated as
onboarded. Existing hunting quests keep their objective, coin promise and any
already-promised iron/bread/XP. Their ordered durable delivery still waits for
AuthMe and storage space and saves a player-file receipt with inventory/XP before
acknowledgement. Lost responses replay safely; full inventories wait without
dropping or overwriting items. New quests never create these item/XP tasks.
Do not delete legacy tasks or receipts. Missing new report counters default to
zero and serialize exactly like old reports, preserving immutable receipt hashes.

`/services repair` quotes the held damaged iron tool, weapon or armor item.
`/services repair confirm` accepts that quote within 60 seconds. Each unit costs
10 coins and restores ceil(maximum durability / 4), up to three units per UTC day;
payment must leave at least 1,000 coins. The exact request is saved before sending
and retried with the same ID. A changed/moved item conflicts and refunds once;
a pending request reserves its daily units, and a conflict releases them.
Repairs preserve item components and create no ingots. The quote is read-only.

Operator inspection (run through the Compose database shell):

```sql
SELECT day, budget, reserved, issued, budget-reserved-issued AS uncommitted,
       eligible, previous_grants, burn_ema
FROM economy_budgets ORDER BY day DESC LIMIT 14;
SELECT day, active_players, active_money, committed_rewards, target,
       issuance_budget, commission_bps
FROM economy_reviews ORDER BY day DESC LIMIT 14;
SELECT kind, status, count(*), min(created_at) AS oldest
FROM economy_tasks GROUP BY kind,status ORDER BY kind,status;
```

Uncommitted budget is not a wallet or a claimable public pool. Long-waiting tasks
need an authenticated player with space; retrying must retain their original IDs.

This policy controls coin issuance and supports starter access. It does not
create advanced crafting restrictions: the simulation's mining-progression gate
is diagnostic only. Rich players can still buy anything other players offer.

## Accounting

`player_stats.coins` remains the wallet used by `/bal`, Marketplace and Minigames.
PostgreSQL triggers append every insert/update that changes coins to `coin_ledger`.
Existing wallets get an opening entry. Deliberate wallet deletion records removal.
Updates, deletes and truncation of the ledger are rejected. It has no link/user
foreign key and survives unlinking or website-account deletion. Rows contain the
UUID, delta, resulting balance, reason, operation reference, database transaction
ID and timestamp. Ordinary SQL balance adjustments are labeled administrative;
application operations set their reason/reference transaction-locally.

Market purchases create a buyer debit, seller gross credit and separate commission
debit in one transaction. Minigames record stake and payout separately, referencing
the round. A stake in an unfinished field remains committed money for policy
measurement. Grants and contract rewards are issuance; fees and settled game net
losses remove money; trading between players does not create money.

Receipts for statistics, economy reports, grants, orders and rounds must not be
pruned without a replacement deduplication protocol. Never reset a grant by
unlinking or deleting its website account. Ledger reconciliation per UUID:

```sql
SELECT uuid, sum(delta) AS ledger_balance FROM coin_ledger GROUP BY uuid;
```

## Starter grant and quest contracts

The plugin sends a durable economy report after AuthMe authentication, including
an otherwise idle login. The first economy registration of a Minecraft UUID
credits 100 coins once, transactionally with its permanent `economy_players` row.
Existing players also receive this one grant on their first authenticated visit
after upgrading. Relogging, report replay and relinking cannot repeat it. This is
per UUID, not a claim that different accounts represent different humans.

- `/quests`: sync pending progress and show the latest personal contract.
- `/quests start`: accept/resume the starter objective or a repeatable quest. There are at most four
  acceptances per UTC day per UUID, including abandoned/expired contracts.
- `/bal` or `/balance`: sync reports and return the same database wallet the site
  shows. No stale balance is substituted if synchronization fails.

Contracts last 24 hours and automatically pay their fixed reward when complete.
For hunting quests, only naturally spawned `Monster` entities killed by an authenticated Survival
player count. The plugin marks natural spawns persistently; mobs already present
before this plugin version first marks them do not qualify. Spawner/command/bred
mobs do not count. The player must have moved or interacted within the preceding
60 seconds, credited kills must be at least two seconds apart and their locations
at least eight blocks apart (or in different worlds). These are bounded farming
checks, not proof that a person is playing without automation.

After iron-work onboarding, a hunting quest starts at ten mobs. Its base reward
is 250 coins, capped by the frozen allowance. The hunting target count is:

```text
min(2000, 10 + floor(lifetime quest earnings / 5000)
              + floor(max(0, lifetime quest earnings - 100000)^2 / 1000000000))
```

The 100,000 milestone is soft; it does not cap balances. Difficulty uses lifetime
quest earnings, so buying items or moving coins cannot reset it. The first 10,000
quest coins retain the 250 base reward regardless of economic conditions;
the actual offer remains bounded by the personal allowance. Later
contracts pay 300/275/250/225/200 coins at levels -2/-1/0/1/2. Terms are fixed at
acceptance; existing contracts are not repriced. Contract reporting and payment
lock the permanent player row and commit with the report receipt.

The plugin keeps an independent `pending-economy.json` immutable outbox. A saved
report is replayed exactly after restart; the panel commits its activity,
contract progress and reward with its receipt. A hard crash can lose activity
not yet written into an outgoing report, as with the statistics reporter.

## Active economy and gradual policy

All boundaries are UTC. Daily qualifying time is measured independently from
ordinary play-time statistics. The plugin samples ten seconds only for an
authenticated Survival player with movement/block interaction in the last minute;
AFK time stops qualifying after that grace period. Lag does not award extra time.
Daily counts are capped at 86,400 seconds. Historical statistics are never
reinterpreted as qualifying activity.

A UUID qualifies over the current and previous thirteen UTC dates with:

- At least 7,200 qualifying seconds in total.
- At least three days containing at least 300 qualifying seconds each.

Configuration (API environment, defaults shown):

```dotenv
ECONOMY_ACTIVE_SECONDS=7200
ECONOMY_ACTIVE_DAYS=3
ECONOMY_ACTIVE_DAY_SECONDS=300
ECONOMY_AUTOMATION=true
```

The worker checks every minute and records at most one observation per UTC day.
It measures wallets of qualifying UUIDs, their accepted unpaid contract rewards,
and their unfinished, unexpired minigame stakes,
whether linked or unlinked. Inactive wallets remain untouched and are excluded
from that measurement. Population and money are smoothed with 75% yesterday +
25% today; population keeps thousandths so small servers still smooth. The first
observation initializes from measured values. Downtime does not invent missed
observations.

The target is **70,000 coins × smoothed active population**. A +/-10% neutral band
prevents corrections to small fluctuations. Two consecutive observed days on the
same side permit a one-level daily move, bounded to -2 through 2. Zero qualifying
players produces no shortage/surplus signal. Within the band, the current level
is held. Levels describe monetary pressure, not a measured inflation rate.

| Level | Later quest reward | Commission destination | Chest return |
| --- | ---: | ---: | ---: |
| -2 | 300 | 0% | 92.79% |
| -1 | 275 | 1% | 92.29% |
| 0 | 250 | 2% | 91.80% |
| 1 | 225 | 3.5% | 91.30% |
| 2 | 200 | 5% | 90.81% |

Commission moves toward its destination by at most 0.25 percentage points per
observed day, including days when the level stays unchanged. Integer published
returns truncate fractional basis points. All probabilities and money use
integers. Set `ECONOMY_AUTOMATION=false` and recreate the API container to freeze
level, commission and budget-size adjustment while still recording daily reviews,
allocating the frozen budget under the cohort cap, and honoring accepted work. The target is
stored in `economy_policy.target_per_player`, initially 70,000.

`economy_reviews` stores each measurement, smoothed values, target, level and fee.
`GET /api/economy` publishes only rules (level, fee, target, budget/reward/service constants), not private
wallets. There is no automatic confiscation or lump-sum mint to reach the target.
Starter affordability, trade prices and wealth distribution need separate
measurement/tuning; this controller does not guarantee stable prices by itself.

## Marketplace commission

`POST /api/marketplace/quote` (session) accepts quantity and optional unit/lot
prices and returns current commission plus server-calculated gross, fee and
proceeds for selling the full selected quantity under either price option.
The inventory form displays these before submission. Listing creation now
requires `expected_commission_bps`; a changed rate returns **412**, without
withdrawing items. Review the refreshed quote and submit again.

New listings permanently pin the accepted fee, including while pending server
withdrawal. Existing pre-migration listings keep their original zero fee. A global
rate change affects future listings only; buyers continue to pay the quoted
price. Commission is charged only on completed sales, and a returned unsold item
has no commission.

For each listing, charge the difference between `ceil(cumulative gross × rate)`
before and after a purchase. Partial-sale splitting cannot avoid fees. Separate
listings each round up, so splitting listings cannot lower the fee either. At
small prices the first rounding coin can exceed the nominal percentage; the
seller preview includes it. `market_orders.commission`, listing cumulative gross
and fee totals, and the ledger all commit with the order/delivery receipt.

## Minigames

Rules are public and identical for everyone. Lucky Chest changes only the lone-diamond
category by 33 rolls per level out of 10,000; triples/pairs and payouts
remain unchanged. Minesweeper keeps the declared TNT count and per-ore rewards:
at negative levels it has a 10%/20% chance to replace one iron with gold; at
positive levels, one gold with iron. This changes ore probabilities slightly,
not the layout after it has been dealt. Published expected returns are calculated
from those same distributions and remain below 100% at every level.

Config responses include `economy.level`. New chest/mines starts send
`economy_level` to accept that published setting. A stale setting returns **412**
without charging; the UI reloads the paytable. Omitted settings mean baseline 0
for old clients, so they can only start while baseline is actually current.

Every round stores its economic level and its reels/board. Minesweeper restore,
reveal and cash-out keep the original board and return rate even across policy
changes. Old stored rounds default to baseline 0. Chest receipt recovery happens
before quote validation, so an already-paid spin is recoverable under its
original request after a policy change or unlinking. A different rule setting
never silently buys another spin.

## Internal protocol and rollout

All `/internal/economy/*` endpoints require the existing service token, fail
closed, and are blocked by Caddy's existing `/internal/*` rule. UUIDs belong to
the authenticated player the plugin observes, never a target supplied in chat.

- `POST /internal/economy/session {uuid, username}`: idempotent starter registration.
- `POST /internal/economy/report {id, uuid, username, days}`: immutable report;
  each day carries ISO `day`, `active_seconds`, `kills`, optional `contract_id`,
  and default-zero `fish_caught`, `crops_harvested`, `iron_mined`, `iron_smelted`.
  The server credits only counters relevant to that contract's persisted kind.
  Exact replay is 200; conflicting ID reuse is 409; invalid/future dates or
  counters reject the whole transaction. Progress for an unrelated contract is
  ignored. Only kills tagged to an accepted contract advance it.
- `POST /internal/economy/contract {uuid, username, start, kind}`: latest contract or
  null; `start: true` accepts/resumes, with 429 on the daily limit and 402 when
  no repeatable coin reward remains. `kind` is hunting/fishing/farming, default
  hunting; the backend chooses starter_iron while onboarding is incomplete.
- `/internal/economy/repair/quote` and `/repair`: token-protected quote and purchase.
  Repair IDs are immutable; 412 means stale terms, 402 means protected reserve,
  409 means conflicting/pending request. Exact retries recover before expiry.
- `/internal/economy/tasks/sync` and `/tasks/report`: token-protected ordered
  delivery and acknowledgement (`done`, or repair-only refundable `conflict`).
- `/internal/economy/travel`: token-protected 503 until private blocks exist.

Deploy the matching API and plugin together during a maintenance window. Build
with the normal Dockerfile and `./scripts/build-plugin.sh`; recreate app/proxy
and restart Purpur using the operator commands in README. Older plugins still
report statistics but do not provide the new grants/contracts/activity protocol.
Keep old pending statistics receipts/outboxes so their replays remain safe. Do
not downgrade to source missing migrations 0016/0017/0018 after applying it. No production
rollout, balance reset or long-term economic calibration is implied by a build.

## Reproducible virtual-world simulation and CI

No real players or Minecraft clients are needed to run the simulator:

```sh
./scripts/simulate-economy.sh
./scripts/simulate-economy.sh --strict
```

Both commands run **960 control years** (5 assumption sets × 12 scenarios × 8
seeds × 2 policies), plus **2,880 experimental years** (six candidates × the same
5 × 12 × 8 matrix), totaling **3,840 virtual years** in the separate `compose.economy-sim.yaml` service. They never
load `.env.docker`, start Minecraft/Postgres, or join the production Compose
network. Hardened-image login is needed as for the normal project build. The
Rust dependency cache uses a dedicated Docker volume; generated data goes to
ignored `reports/economy/`. `cargo test` runs a short reproducibility/hoarding/AFK
regression; the full year test is explicitly ignored unless invoked by the runner.

The adaptive run now uses the implemented coin budget and iron-work onboarding, including
prior-day eligibility/grants and disabled teleport. The frozen neutral control
retains the historical unlimited-issuance behavior. Shared production helpers
provide budget arithmetic, fair allocation, controller
transitions, activity defaults, contract terms, fees and chest/mine deals. Production wrappers still use OS randomness; deterministic seeded
randomness exists only under `cfg(test)` and cannot be enabled on a live route.
No balances or policy settings in the running stack are touched.

Scenarios cover stable population, growth 5→20, half departing, wealthy returnees,
weekly/low trading, heavy minigames, hoarding, short-lived alternate accounts,
item scarcity, AFK identities, threefold goods supply, and lower item demand.
Three regulars retire and three newcomers replace them on day 300. Inactive
wallets remain intact and age out of the fourteen-day activity measurement. Each
adaptive run is paired with a frozen neutral-policy run from the same starting
seed. Identity traits, attendance and productivity use separate deterministic
streams, so gameplay choices cannot shift those exogenous draws. Game branches
can still consume draws differently; this is not a controlled causal estimate
of the controller's isolated effect.

Money and goods must reconcile after every simulated day. Negative wallets,
repeated grants, excessive contract completion, out-of-range policy settings,
and daily fee changes exceeding 25 basis points fail the invariant checks.
Existing SQL tests remain responsible for transaction atomicity, ownership,
concurrent requests, replay safety, and persisted policy/round state.

### What is assumed, rather than measured

The simulator uses an **uncalibrated sensitivity envelope**, not a best guess
presented as real Minecraft data. No production policy parameters were tuned:

| Assumption set | Iron/hour | Food bundles/hour | Eligible kills/minute | Replacement iron/active hour |
|---|---:|---:|---:|---:|
| reference | 24 | 12 | 2 | 2 |
| constrained_supply | 6 | 3 | 2 | 2 |
| productive_supply | 72 | 36 | 2 | 2 |
| slow_combat | 24 | 12 | 1 | 2 |
| high_wear | 24 | 12 | 2 | 6 |

These are separate gathering rates: one minute can produce **one** good or count
toward a quest, never both. Agents have 75–125% persistent skill, traders have
150% productivity and daily productivity varies 80–120%. Fractional yields carry
between sessions (including during the eightfold scarcity shock). Food use is
one bundle per active hour; established iron demand follows play time instead
of an unconditional daily purchase. Unfilled replacement needs are capped at
12 iron/3 food. Existing lower-demand and abundant-supply scenarios remain.

Agents compare quest reward/minute with gathering value using their posted
reservation prices, personal needs and the prior day's observed sell-through
(smoothed 75% old/25% new, initially 25%). Sale value includes commission; self-use
can remain valuable with no buyers. This simple local choice replaces mandatory
quest-first behavior. It is not a perfect optimizer: it has no future price
knowledge, Minecraft navigation or measured player preferences. The full play
budget is asserted to equal quest minutes plus gathering minutes each day.

Initial asking prices are 8–16 coins per iron and 15–30 per food bundle. Sellers
adjust to sales/stock rather than the monetary target. Agents use their own
reserves before offering goods, and only buy unmet needs from others. Goods sold
or self-used leave tradable inventory and are reconciled as consumed, including
abstract crafting/equipment; actual Minecraft crafting and durability are not
simulated. A market purchase is an immediately filled new listing, not a
long-lived listing with a historically pinned commission.

Equipment progression is **3 iron for an axe**, then **27 total iron plus one
food bundle** for an axe and armor. Common sticks, stone tools and access to
resources are assumed available. Purchases and self-gathering both count; a
player can acquire pieces over several sessions. Starting and day-301 cohorts
report axe/full-kit completion, calendar days and active session minutes.
Unfinished players are retained in completion denominators, and completion-only
quantiles are explicitly labeled. Timing includes the entire completion
session, so it is a conservative session-granularity estimate.

A full market quote is sampled **after production/self-use, before purchases**,
avoiding the old bias of pricing only leftovers after everybody has shopped.
Private hoards and closed weekly-trading days do not create market offers.
Missing complete baskets remain unknown. The original quest-funded beginner
probe is retained: real grant/progression, today's fixed price/level and at most
1,460 contracts. Its sixty-minute objective is unchanged and is distinct from
actual mixed-route equipment acquisition. A market quote can fail that objective
even when newcomers equip themselves by gathering. Neither outcome is hidden.

Before tuning policy, calibrate these assumptions with short controlled play
sessions: record authenticated active minutes, net iron/food gathered after
personal use, eligible quest kills/travel time, replacement consumption and actual
orders. Sample beginners and experienced players, ordinary/spawner-excluded
combat and different resource conditions; keep individual ranges rather than
only a pooled average. Existing aggregate statistics cannot identify which
minutes were spent mining versus fighting. No live data is fabricated or
silently substituted for these assumptions. Wider joint-factor sweeps, observed
market-listing lifetimes, equipment durability and behavior calibrated from real
sessions remain future model work.

### Acceptance and deployment

Report mode exits successfully if accounting/model invariants pass, while
recording economic acceptance failures. `--strict` also fails unless **every seed
of the stable-population and growth scenarios across all five assumption sets** meets both predeclared objectives
over the last ninety days:

- Mean coins per qualifying player between 0.5× and 1.5×70,000. This is an initial
  convergence acceptance range, distinct from the controller's ±10% neutral band.
- A full starter basket quoted on at least 80% of days, with its 90th-percentile
  fresh-player earning time no more than sixty active minutes.

Stress scenarios are always reported and checked for accounting correctness;
not every adversarial behavior is asserted to reach the monetary target.
Thresholds are model assumptions that require product/operator review, not proof
of real-world economic stability. Do not relax them merely to make a release pass.

The existing **Test and deploy** workflow runs strict mode after the normal
backend, frontend, production-image and plugin checks. The deployment job depends
on that test job. Reports are rendered and uploaded even when economic acceptance
fails. The improved model still fails money and/or market-affordability objectives
in normal-population cases across the assumption sets, so **the new CI gate intentionally blocks deployment until the policy,
goods model or explicitly reviewed acceptance requirements are addressed**. No
production policy or thresholds were tuned merely to turn these failures green.

### Reports and charts

- `summary.md`: per-assumption seed pass counts, aggregate totals, sensitivity comparison and newcomer examples.
- `manifest.json`: defaults, behavioral assumptions, seeds and SHA-256 of the
  compiled backend/simulation source.
- `acceptance.json`: release verdict and failing seeds.
- `runs.json` and `daily.csv`: current/frozen-control traces, including coin flows, wealth
  concentration, active population, item prices/availability and earning time.

Optional plotting dependencies are isolated from the application:

```sh
python3 -m venv .plugin-build/economy-report-venv
.plugin-build/economy-report-venv/bin/python -m pip install -r scripts/economy/requirements.txt
.plugin-build/economy-report-venv/bin/python scripts/economy/render.py
```

This adds `comparison.png/svg`, `comparison-money.png/svg`, `money.png/svg`, `affordability.png/svg`, `sensitivity.png/svg` and an offline `index.html`.
The first two charts use reference assumptions; the sensitivity chart compares
all five sets and separates market affordability from actual kit completion.
Shaded bands show the full range across eight seeds, not statistical confidence
intervals. Missing market quotes and beyond-horizon probes remain gaps.

Earlier quest-first simulation findings (historical; rerun the improved model for current results): the normal mixed-player model can approach the
money target while starter prices/availability still fail; hoarding/low turnover
continues to accumulate money, and heavy minigames drains it. More goods can keep
starter equipment cheap while the money target still fails. These are reasons to
review issuance budgets, optional sinks and starter-item supply before rollout;
they are not grounds for claiming that the live server's prices were measured.


### Experimental issuance budgets and voluntary services

The six historical candidates remain test-only parameter comparisons. Current
now means the implemented package above and is the strict release gate; a successful hypothetical variant cannot
make an unimplemented production policy pass CI. The same run emits comparisons
and uploads all candidate traces before enforcing that gate.

| Candidate | Supply recovery period | Service willingness/day | Starter contract materials |
|---|---:|---:|---|
| budget_30 | 30 days | 0% | none |
| budget_60 | 60 days | 0% | none |
| budget_120 | 120 days | 0% | none |
| services_35 | 60 days | 35% | none |
| services_70 | 60 days | 70% | none |
| starter_materials | 60 days | 35% | 3/8/8/8 iron + one initial food bundle |

Daily candidate funding is recent **signed net** coins removed (commission,
services and stakes minus payouts; seven-day EMA) plus the smoothed target/supply
gap divided by the recovery period, less new starter grants. It is nonnegative,
capped at 1,200 per eligible identity and changes by at most the larger of 10%
of yesterday's budget or 25 coins per eligible player. Population/capacity
constraints may force faster reductions. No qualifying population
means no quest-coin funding. The budget does not confiscate existing wallets or
promise to eliminate every supply shock immediately.

Funding is allocated before simulated work. Eligibility uses present identities
with observed recent activity, plus new arrivals; it does not secretly exclude
alts using simulator-only knowledge. Twenty percent is reserved for first-14-day
identities; the rest is divided among all eligible players. Rounding priority
rotates daily. Grants and alt churn remain explicit stress-test inflows. Caps and
unused allocations can leave some budget unspent. Coins offered per contract
are the lesser of baseline reward and that player's remaining allowance; the
quoted reward is fixed before work. This model settles each accepted contract
within the day; durable multi-day reservations are implemented and SQL-tested, but are not
represented in the agent model; unused daily entitlements are not banked. Lifetime coin earnings still drive the production
quest-difficulty curve.

Travel costs 25 coins and saves two quest-travel minutes. Repair costs 10 per
iron-equivalent unit of current wear demand, at most three/day; it creates no
tradable iron. A player needs to retain a 1,000-coin reserve and perceive economic
benefit to buy. Willingness is a separate deterministic daily draw, never forced
spending. Hoarders refuse both services. Zero adoption is explicitly represented
by budget_60. These prices, preferences and utility estimates are hypotheses,
not measured behavior. Production has the bounded durability repair service;
its modeled iron-equivalent benefit is an approximation. Teleport remains disabled
in the implemented run; candidate travel is an historical hypothetical service.

The starter-material candidate grants at most 27 iron and one food per identity
through its first four completed contracts, only while still unequipped. Alternate
identities still have their own entitlements; actual resale/funneling of equipped
items is not modeled. Production also bounds materials per UUID; alternate-account
funneling remains a calibration and abuse-monitoring risk. These
are finite NPC-created goods, recorded separately from mining production; they
are not free market inventory or new coins. This tests an explicit resource
subsidy and its tradeoffs, rather than claiming currency control creates iron.
Candidates value the first ten nontransferable contract progress points at an
assumed five coins each. A diagnostic advanced-crafting gate requires ten
contracts and 120 personal iron-gathering minutes. Advanced recipes/trading and
player desire for them are not modeled; this gate does not prove rich players
will choose to mine.

The original market affordability objective is unchanged. Candidate probes use
the candidate's actual daily funding share for a hypothetical new entrant,
held fixed with the day's quote/policy. The implemented run includes a one-day
coin-allocation onboarding delay. It does not assume zero income forever just
because a hypothetical entrant arrived today. Zero funding cannot become unlimited
probe income. Material rewards, self-gathering and useful service benefits show
up in actual cohorts, separate from that coin-only probe. A further diagnostic
reports the number of late newcomers finishing equipment within sixty active
session minutes, including unfinished players in the denominator.

Reports:

- `comparison.md`: per-model normal-population pass counts and declared rules.
- `flows-comparison.md`: actual modeled coin creation/removal and finite NPC resources, including voluntary-service spending.
- `stress-comparison.md`: every candidate/stress scenario, including nonparticipation, scarcity and returning wealth, with monetary ranges and unfinished newcomers.
- `comparison.json`: all candidate/current scenario summaries, complete accounting,
  censored cohorts and reference-case monetary curves.
- `experiment-acceptance.json`: candidate pass/fail counts under the original goals.
- `experiments/<candidate>/runs.json`: full daily traces for each of six candidates.
- `comparison.png/svg`: monetary, market and actual newcomer progress side by side.
- `comparison-money.png/svg`: reference/stable-population money paths across all variants.

Every candidate checks coin/goods conservation, labor budgets, nonnegative
wallets and actual issuance ≤ allocated funding every day. Services and material
rewards have their own accounting. Unit regressions cover allocation fairness,
zero population, zero newcomer funding, finite materials, optional service use,
reproducibility and the personal progression gate. The selected package now has production reservations and delivery tests.
Deployment still depends on the unchanged strict goals and real gameplay
calibration; passing accounting alone does not prove price stability.


Historical candidate findings (2026-10-19, before prior-day allocation and disabled travel): every candidate meets the monetary objective
in all 80 normal-population runs. Joint money/market pass counts are 7/80 for
current rules; 62/80, 65/80 and 66/80 for 30/60/120-day budgets; 65/80 and 66/80
with 35%/70% service willingness; and 70/80 with finite starter materials. That
last package equips all 240 late newcomers within sixty active session minutes,
versus 155/240 under current rules. Its ten market failures are all constrained
supply cases: actual equipment access and full-market-basket affordability are
still distinct goals. Returning wealth and heavy minigames remain stress
limitations. No candidate satisfies every original normal-case objective, so no
candidate is declared ready for production. The full matrix took about fifteen
minutes on this local machine; ordinary regression tests stay separate.


### Historical budget/material policy verification (before migration 0018)

The adaptive run now tests the actual prior-day budget and finite-reward package
with private-block teleport disabled. Across the 80 normal-population runs,
money passes 80/80 and market affordability 70/80; all 240 late newcomers
obtain kits within sixty active minutes. Heavy-minigame and wealthy-return
monetary targets still fail in all forty stress runs each. The ten normal-case failures
all use constrained supply, so strict CI remains red; no objective was relaxed.
Earlier candidate counts above describe their historical timing and travel
assumptions. These synthetic results cannot verify real Minecraft delivery or
price stability. Backend/receipt tests pass, but live client interaction remains
an operator rollout check. No production migration or runtime restart was made.


### Quest-model scope after migration 0018

Current simulation agents mine ten iron through their shared gathering budget,
then spend five assumed smelting minutes, before taking the hunting repeatable
route. Their first-day accepted onboarding offer remains zero coins. Current
agents receive no NPC material rewards or bonus XP; those remain only in the
six historical candidates. Smelting time is synthetic, the resource model treats
raw iron/ingots as one good, furnace parallelism and starter expiry are not
emulated, and fishing/farming production rates are not calibrated. API and plugin
regressions cover all objective counters, but this hunting-route benchmark does
not predict the effect of automatic farms or real fishing/crop yields. Keep the
strict goals unchanged and collect real gameplay data before tuning rewards.

Current hunting-route benchmark after removing free materials: money passes
80/80 normal runs; market affordability 64/80; late kits eventually 240/240,
with 195/240 within sixty active minutes. Sixteen release failures keep strict
CI red. These results supersede the material-grant policy's faster onboarding;
they are synthetic sensitivity outcomes, not live measurements.
