-- Minigames stake real coins, so the server owns every outcome: a round fixes its
-- bet and its hidden board when it starts, and this table is the only place the
-- browser can learn a cell from. Coins live in player_stats.coins — the balance
-- the game server reports into and `/bal` reads — keyed by Minecraft UUID with no
-- link foreign key, exactly like player_stats: a balance outlives an unlink.
--
-- Numbered 0014 rather than 0012 so the marketplace migrations on the other line
-- of work keep their numbers; sqlx only needs versions to be unique and ordered.
CREATE TABLE minigame_rounds (
    id UUID PRIMARY KEY,
    -- A browser retrying a lost response sends the same id and must never be
    -- charged twice. Minesweeper rounds have none: the server names those.
    client_id UUID,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The payer. Deliberately not a foreign key to minecraft_accounts: the coins
    -- are in player_stats and survive the account being unlinked.
    uuid TEXT NOT NULL,
    game TEXT NOT NULL CHECK (game IN ('lucky_chest', 'minesweeper')),
    bet BIGINT NOT NULL CHECK (bet > 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled')),
    payout BIGINT NOT NULL DEFAULT 0 CHECK (payout >= 0),
    -- Why it settled. 'expired' means the player walked away and forfeited the
    -- stake; see MINIGAME_ROUND_TTL_SECONDS in the app.
    outcome TEXT CHECK (outcome IN ('paid', 'lost', 'expired')),
    -- The whole round, including Minefield positions the browser must not see yet.
    state JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ,
    UNIQUE (user_id, client_id)
);

-- One live round per game per user: two tabs must not hold two stakes out of a
-- balance that only covers one. Settled rows are unconstrained (history stays).
CREATE UNIQUE INDEX minigame_rounds_active
    ON minigame_rounds (user_id, game) WHERE status = 'active';
CREATE INDEX minigame_rounds_player ON minigame_rounds (uuid, created_at DESC);
