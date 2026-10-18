-- Observed skins outlive links, like activity. Pending uploads do not.
CREATE TABLE player_skins (
    uuid TEXT PRIMARY KEY,
    texture_hash TEXT,
    model TEXT NOT NULL DEFAULT 'classic' CHECK (model IN ('classic', 'slim')),
    observed_at TIMESTAMPTZ,
    checked_at TIMESTAMPTZ
);
CREATE TABLE skin_uploads (
    uuid TEXT PRIMARY KEY REFERENCES minecraft_accounts(uuid) ON DELETE CASCADE,
    request_id TEXT NOT NULL UNIQUE,
    png BYTEA,
    model TEXT NOT NULL CHECK (model IN ('classic', 'slim')),
    job_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'signing', 'ready', 'saved', 'failed')),
    value TEXT,
    signature TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
