-- One-time codes that link a web account to a Minecraft account. Only the SHA-256 of
-- the code is stored, never the code itself; codes are single-use and expire quickly.
CREATE TABLE IF NOT EXISTS link_codes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS link_codes_user_id_idx ON link_codes (user_id);

-- Linked Minecraft accounts. The UUID is the identity (derived from the username in
-- offline mode); a UUID can belong to at most one web account.
CREATE TABLE IF NOT EXISTS minecraft_accounts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    uuid TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS minecraft_accounts_user_id_idx ON minecraft_accounts (user_id);

-- Append-only trail of security-relevant events.
CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT now(),
    event TEXT NOT NULL,
    user_id BIGINT,
    detail TEXT,
    ip TEXT
);
