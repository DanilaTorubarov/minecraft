-- 0020_private_blocks_and_mining.sql
-- Private blocks ownership, state, and mining expedition cooldown tracking

CREATE TABLE private_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uuid TEXT NOT NULL REFERENCES economy_players(uuid) ON DELETE CASCADE,
    block_index INTEGER NOT NULL CHECK (block_index BETWEEN 1 AND 3),
    world TEXT NOT NULL DEFAULT 'world',
    x INTEGER NOT NULL DEFAULT 0,
    y INTEGER NOT NULL DEFAULT 0,
    z INTEGER NOT NULL DEFAULT 0,
    placed BOOLEAN NOT NULL DEFAULT false,
    radius INTEGER NOT NULL DEFAULT 1 CHECK (radius IN (1, 3, 5, 7)),
    fuel_seconds BIGINT NOT NULL DEFAULT 0 CHECK (fuel_seconds >= 0),
    fuel_tier INTEGER NOT NULL DEFAULT 1 CHECK (fuel_tier BETWEEN 1 AND 4),
    members JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (uuid, block_index)
);

CREATE INDEX private_blocks_uuid ON private_blocks(uuid);
CREATE INDEX private_blocks_coords ON private_blocks(world, x, z) WHERE placed = true;

CREATE TABLE mine_expeditions (
    uuid TEXT PRIMARY KEY REFERENCES economy_players(uuid) ON DELETE CASCADE,
    last_entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expedition_count BIGINT NOT NULL DEFAULT 1 CHECK (expedition_count >= 1)
);
