-- 0026_admin_moderation_and_bans.sql
-- Tables for in-game moderation: bans, mutes, and moderation audit logs

CREATE TABLE IF NOT EXISTS player_bans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uuid TEXT,
    username TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT 'Banned by operator',
    banned_by TEXT NOT NULL DEFAULT 'WebAdmin',
    expires_at TIMESTAMPTZ, -- NULL means permanent
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_player_bans_username ON player_bans(lower(username)) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_player_bans_uuid ON player_bans(uuid) WHERE active = true;

CREATE TABLE IF NOT EXISTS player_mutes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uuid TEXT,
    username TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT 'Muted by operator',
    muted_by TEXT NOT NULL DEFAULT 'WebAdmin',
    expires_at TIMESTAMPTZ, -- NULL means permanent
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_player_mutes_uuid ON player_mutes(uuid) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_player_mutes_username ON player_mutes(lower(username)) WHERE active = true;

CREATE TABLE IF NOT EXISTS moderation_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL, -- 'kick', 'ban', 'unban', 'mute', 'unmute', 'command'
    target_uuid TEXT,
    target_username TEXT,
    reason TEXT,
    detail JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_moderation_audit_created ON moderation_audit_log(created_at DESC);
