-- 0025_private_block_fuel_queue.sql
-- Add per-tier queued fuel counters to private_blocks for sequential tier consumption and withdrawal

ALTER TABLE private_blocks
    ADD COLUMN IF NOT EXISTS tier_1_seconds BIGINT NOT NULL DEFAULT 0 CHECK (tier_1_seconds >= 0),
    ADD COLUMN IF NOT EXISTS tier_2_seconds BIGINT NOT NULL DEFAULT 0 CHECK (tier_2_seconds >= 0),
    ADD COLUMN IF NOT EXISTS tier_3_seconds BIGINT NOT NULL DEFAULT 0 CHECK (tier_3_seconds >= 0),
    ADD COLUMN IF NOT EXISTS tier_4_seconds BIGINT NOT NULL DEFAULT 0 CHECK (tier_4_seconds >= 0);

UPDATE private_blocks SET
    tier_1_seconds = CASE WHEN fuel_tier = 1 THEN fuel_seconds ELSE 0 END,
    tier_2_seconds = CASE WHEN fuel_tier = 2 THEN fuel_seconds ELSE 0 END,
    tier_3_seconds = CASE WHEN fuel_tier = 3 THEN fuel_seconds ELSE 0 END,
    tier_4_seconds = CASE WHEN fuel_tier = 4 THEN fuel_seconds ELSE 0 END
WHERE tier_1_seconds = 0 AND tier_2_seconds = 0 AND tier_3_seconds = 0 AND tier_4_seconds = 0 AND fuel_seconds > 0;
