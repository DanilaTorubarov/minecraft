-- 0030_user_bank_balance.sql
-- Adds web account bank balance to users table.
-- Pocket money lives in player_stats.coins per Minecraft player UUID (for trading, marketplace, in-game use).
-- Bank money lives in users.bank_coins per website account (for playing minigames).
-- Money can be transferred between any linked player's pocket money and the user's web bank balance.

ALTER TABLE users ADD COLUMN bank_coins BIGINT NOT NULL DEFAULT 0 CHECK (bank_coins >= 0);

CREATE TABLE IF NOT EXISTS bank_ledger (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    player_uuid TEXT,
    delta BIGINT NOT NULL,
    balance BIGINT NOT NULL CHECK (balance >= 0),
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bank_ledger_user ON bank_ledger(user_id, created_at DESC);
