-- Server-side player statistics, reported by the game server's LinkBridge plugin
-- as deltas and added here. The panel never measures the game itself: a row means
-- "the game server told us this much activity happened", and nothing is displayed
-- that the server did not report.
--
-- Keyed by the offline UUID (the in-game identity) with no foreign key to
-- minecraft_accounts, on purpose: unlinking a player must not erase their history,
-- and re-linking restores it. The rows outlive links, like audit_log outlives users.
CREATE TABLE IF NOT EXISTS player_stats (
    uuid TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    play_seconds BIGINT NOT NULL DEFAULT 0,
    blocks_placed BIGINT NOT NULL DEFAULT 0,
    blocks_broken BIGINT NOT NULL DEFAULT 0,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
