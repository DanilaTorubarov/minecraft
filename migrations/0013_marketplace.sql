-- Escrow outlives individual links. Unlink is blocked while items or deliveries
-- remain, so a queued operation never changes ownership midway through a trade.
CREATE TABLE market_listings (
    id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    uuid TEXT NOT NULL,
    username TEXT NOT NULL,
    item JSONB NOT NULL,
    item_bytes TEXT,
    quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 230),
    remaining INTEGER NOT NULL CHECK (remaining BETWEEN 0 AND quantity),
    unit_price BIGINT CHECK (unit_price BETWEEN 1 AND 1000000000),
    lot_price BIGINT CHECK (lot_price BETWEEN 1 AND 1000000000),
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'conflict', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (unit_price IS NOT NULL OR lot_price IS NOT NULL)
);
CREATE INDEX market_listings_active ON market_listings(created_at DESC) WHERE status='active';
CREATE INDEX market_listings_owner ON market_listings(user_id, created_at DESC);
CREATE TABLE market_tasks (
    sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    listing_id TEXT NOT NULL REFERENCES market_listings(id),
    uuid TEXT NOT NULL,
    username TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('withdraw', 'deliver')),
    quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 230),
    slot INTEGER CHECK (slot BETWEEN 0 AND 40),
    fingerprint TEXT,
    item_bytes TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'conflict')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX market_tasks_pending ON market_tasks(uuid, sequence) WHERE status='pending';
CREATE TABLE market_orders (
    id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    payload_hash TEXT NOT NULL,
    listing_id TEXT NOT NULL REFERENCES market_listings(id),
    buyer_uuid TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    total BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
