-- One serialized deletion per linked player; snapshots survive unlinking,
-- but permission to perform queued edits does not.
CREATE TABLE inventory_deletions (
    uuid TEXT PRIMARY KEY REFERENCES minecraft_accounts(uuid) ON DELETE CASCADE,
    request_id TEXT NOT NULL UNIQUE,
    slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 40),
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'deleted', 'conflict')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Rotate offline reads as well as live samples, including inventories reported
-- by older plugin versions that did not carry full-item fingerprints.
ALTER TABLE minecraft_accounts ADD COLUMN inventory_checked_at TIMESTAMPTZ NOT NULL DEFAULT '-infinity';
