-- 0023_offline_mail_and_territory_alerts.sql
-- Offline mail & delivery parcel system and automated territory defense alerts

CREATE TABLE IF NOT EXISTS mail_parcels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    sender_uuid TEXT NOT NULL,
    sender_username TEXT NOT NULL,
    recipient_uuid TEXT NOT NULL,
    recipient_username TEXT NOT NULL,
    coins BIGINT NOT NULL DEFAULT 0 CHECK (coins >= 0),
    item JSONB,
    item_bytes TEXT,
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'cancelled')),
    source TEXT NOT NULL DEFAULT 'inventory' CHECK (source IN ('inventory', 'marketplace', 'direct')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at TIMESTAMPTZ,
    CHECK (coins > 0 OR quantity > 0)
);

CREATE INDEX IF NOT EXISTS mail_parcels_recipient_pending ON mail_parcels(recipient_uuid, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS mail_parcels_sender ON mail_parcels(sender_uuid, created_at DESC);
CREATE INDEX IF NOT EXISTS mail_parcels_recipient ON mail_parcels(recipient_uuid, created_at DESC);

CREATE TABLE IF NOT EXISTS territory_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uuid TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('breach', 'fuel_low')),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    block_index INTEGER,
    world TEXT,
    x INTEGER,
    y INTEGER,
    z INTEGER,
    read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS territory_alerts_uuid_created ON territory_alerts(uuid, created_at DESC);
CREATE INDEX IF NOT EXISTS territory_alerts_unread ON territory_alerts(uuid) WHERE read = false;
