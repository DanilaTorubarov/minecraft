-- Wider activity statistics, reported by the game server's LinkBridge plugin as
-- deltas and added here, exactly like 0005 and 0007. Every column is something
-- the game server measured; the panel never estimates or backfills it, so the new
-- columns start at zero and existing rows keep the numbers they already have.
--
-- Units follow what the game actually measures:
--   distance_cm            hundredths of a block (1 block = 100), so no walk is
--                          lost to rounding between flushes.
--   damage_dealt/taken     hundredths of a heart (100 = 1 heart, 50 = half a
--                          heart), so partial hits survive as exact integers.
--   everything else        plain counts of events the plugin observed.
ALTER TABLE player_stats
    ADD COLUMN mobs_killed BIGINT NOT NULL DEFAULT 0 CHECK (mobs_killed >= 0),
    ADD COLUMN deaths BIGINT NOT NULL DEFAULT 0 CHECK (deaths >= 0),
    ADD COLUMN distance_cm BIGINT NOT NULL DEFAULT 0 CHECK (distance_cm >= 0),
    ADD COLUMN items_crafted BIGINT NOT NULL DEFAULT 0 CHECK (items_crafted >= 0),
    ADD COLUMN fish_caught BIGINT NOT NULL DEFAULT 0 CHECK (fish_caught >= 0),
    ADD COLUMN damage_dealt BIGINT NOT NULL DEFAULT 0 CHECK (damage_dealt >= 0),
    ADD COLUMN damage_taken BIGINT NOT NULL DEFAULT 0 CHECK (damage_taken >= 0),
    ADD COLUMN logins BIGINT NOT NULL DEFAULT 0 CHECK (logins >= 0),
    ADD COLUMN items_picked_up BIGINT NOT NULL DEFAULT 0 CHECK (items_picked_up >= 0),
    ADD COLUMN items_enchanted BIGINT NOT NULL DEFAULT 0 CHECK (items_enchanted >= 0),
    ADD COLUMN tools_broken BIGINT NOT NULL DEFAULT 0 CHECK (tools_broken >= 0),
    ADD COLUMN animals_bred BIGINT NOT NULL DEFAULT 0 CHECK (animals_bred >= 0),
    ADD COLUMN times_slept BIGINT NOT NULL DEFAULT 0 CHECK (times_slept >= 0),
    ADD COLUMN advancements BIGINT NOT NULL DEFAULT 0 CHECK (advancements >= 0);
