-- 0027_clans_and_factions.sql
-- Clans and factions system with shared treasury, diplomacy, and private territory integration

CREATE TABLE IF NOT EXISTS clans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tag TEXT UNIQUE NOT NULL,
    name TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    leader_uuid TEXT NOT NULL,
    leader_username TEXT NOT NULL,
    coins BIGINT NOT NULL DEFAULT 0 CHECK (coins >= 0),
    home_world TEXT,
    home_x DOUBLE PRECISION,
    home_y DOUBLE PRECISION,
    home_z DOUBLE PRECISION,
    home_yaw REAL,
    home_pitch REAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clan_members (
    clan_id UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    uuid TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('leader', 'officer', 'member')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (clan_id, uuid)
);

CREATE TABLE IF NOT EXISTS clan_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clan_id UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    inviter_uuid TEXT NOT NULL,
    invited_uuid TEXT NOT NULL,
    invited_username TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 day'),
    UNIQUE (clan_id, invited_uuid)
);

CREATE TABLE IF NOT EXISTS clan_relations (
    clan_id_1 UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    clan_id_2 UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('ally', 'truce', 'war')),
    initiated_by UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (clan_id_1, clan_id_2),
    CHECK (clan_id_1 < clan_id_2)
);

CREATE TABLE IF NOT EXISTS clan_treasury_log (
    id BIGSERIAL PRIMARY KEY,
    clan_id UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    player_uuid TEXT NOT NULL,
    player_username TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('deposit', 'withdraw')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    balance_after BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clan_members_uuid ON clan_members(uuid);
CREATE INDEX IF NOT EXISTS idx_clan_invites_invited ON clan_invites(invited_uuid);
CREATE INDEX IF NOT EXISTS idx_clan_treasury_clan ON clan_treasury_log(clan_id, id DESC);
