-- 0024_expand_private_block_radius.sql
-- Expand private block radius to chunk-scale tiers: 2x2, 5x5, 10x10, 16x16 chunks (16, 40, 80, 128 blocks)

ALTER TABLE private_blocks DROP CONSTRAINT IF EXISTS private_blocks_radius_check;

UPDATE private_blocks SET radius = CASE radius
    WHEN 1 THEN 16
    WHEN 3 THEN 40
    WHEN 5 THEN 80
    WHEN 7 THEN 128
    ELSE 16
END;

ALTER TABLE private_blocks ADD CONSTRAINT private_blocks_radius_check CHECK (radius IN (16, 40, 80, 128));
ALTER TABLE private_blocks ALTER COLUMN radius SET DEFAULT 16;
