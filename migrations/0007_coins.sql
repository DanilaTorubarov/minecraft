-- Existing activity is not retroactively paid. Balances belong to Minecraft UUIDs.
ALTER TABLE player_stats ADD COLUMN coins BIGINT NOT NULL DEFAULT 0 CHECK (coins >= 0);
-- Keep receipts permanently: delayed retries must never award a second time.
CREATE TABLE stats_reports (
    report_id TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL
);
