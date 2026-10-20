-- Preserve balances and establish an auditable opening position. No link/user FK:
-- financial history survives unlinking and website-account deletion.
LOCK TABLE player_stats IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE coin_ledger (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid TEXT NOT NULL,
    delta BIGINT NOT NULL,
    balance BIGINT NOT NULL CHECK (balance >= 0),
    reason TEXT NOT NULL,
    reference TEXT NOT NULL,
    transaction_id BIGINT NOT NULL DEFAULT txid_current(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX coin_ledger_player ON coin_ledger(uuid,id);
INSERT INTO coin_ledger(uuid,delta,balance,reason,reference)
SELECT uuid,coins,coins,'opening_balance','migration:0016' FROM player_stats;
CREATE FUNCTION record_coin_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous BIGINT := 0;
BEGIN
    IF TG_OP = 'UPDATE' THEN previous := OLD.coins; END IF;
    IF NEW.coins <> previous THEN
        INSERT INTO coin_ledger(uuid,delta,balance,reason,reference)
        VALUES(NEW.uuid,NEW.coins-previous,NEW.coins,
            coalesce(nullif(current_setting('economy.reason',true),''),'administrative_adjustment'),
            coalesce(current_setting('economy.reference',true),''));
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER coin_change AFTER INSERT OR UPDATE OF coins ON player_stats
FOR EACH ROW EXECUTE FUNCTION record_coin_change();
CREATE FUNCTION immutable_coin_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'coin ledger is append-only'; END $$;
CREATE TRIGGER coin_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON coin_ledger
FOR EACH STATEMENT EXECUTE FUNCTION immutable_coin_ledger();

CREATE TABLE economy_players (
    uuid TEXT PRIMARY KEY,
    starter_granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    quest_earned BIGINT NOT NULL DEFAULT 0 CHECK(quest_earned >= 0)
);
CREATE TABLE economy_reports (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL);
CREATE TABLE economy_activity (
    uuid TEXT NOT NULL, day DATE NOT NULL,
    active_seconds INTEGER NOT NULL CHECK(active_seconds BETWEEN 0 AND 86400),
    PRIMARY KEY(uuid,day)
);
CREATE INDEX economy_activity_day ON economy_activity(day,uuid);
CREATE TABLE economy_policy (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
    level INTEGER NOT NULL DEFAULT 0 CHECK(level BETWEEN -2 AND 2),
    commission_bps INTEGER NOT NULL DEFAULT 200 CHECK(commission_bps BETWEEN 0 AND 500),
    active_ema BIGINT NOT NULL DEFAULT 0,
    money_ema BIGINT NOT NULL DEFAULT 0,
    signal INTEGER NOT NULL DEFAULT 0,
    signal_days INTEGER NOT NULL DEFAULT 0,
    reviewed_day DATE,
    target_per_player BIGINT NOT NULL DEFAULT 70000 CHECK(target_per_player > 0)
);
INSERT INTO economy_policy(singleton) VALUES(true);
CREATE TABLE economy_reviews (
    day DATE PRIMARY KEY, active_players BIGINT NOT NULL, active_money BIGINT NOT NULL,
    active_ema BIGINT NOT NULL, money_ema BIGINT NOT NULL, target BIGINT NOT NULL,
    level INTEGER NOT NULL, commission_bps INTEGER NOT NULL
);
CREATE TABLE economy_contracts (
    id TEXT PRIMARY KEY, uuid TEXT NOT NULL REFERENCES economy_players(uuid),
    target INTEGER NOT NULL CHECK(target > 0), progress INTEGER NOT NULL DEFAULT 0,
    reward BIGINT NOT NULL CHECK(reward > 0), policy_level INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paid','expired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '24 hours'
);
CREATE UNIQUE INDEX economy_contract_active ON economy_contracts(uuid) WHERE status='active';
CREATE INDEX economy_contract_player ON economy_contracts(uuid,created_at);
-- Old listings retain their original zero-fee agreement. New listings explicitly
-- accept and freeze the then-current rate. Cumulative ceiling prevents rounding
-- avoidance through partial purchases or many separate listings.
ALTER TABLE market_listings ADD COLUMN commission_bps INTEGER NOT NULL DEFAULT 0 CHECK(commission_bps BETWEEN 0 AND 500);
ALTER TABLE market_listings ADD COLUMN gross_sold BIGINT NOT NULL DEFAULT 0;
ALTER TABLE market_listings ADD COLUMN fee_paid BIGINT NOT NULL DEFAULT 0;
ALTER TABLE market_orders ADD COLUMN commission BIGINT NOT NULL DEFAULT 0;

-- A deliberate administrative wallet deletion also removes money. Keep its
-- history even when the row no longer exists (including disposable test users).
CREATE FUNCTION record_wallet_removal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.coins > 0 THEN
        INSERT INTO coin_ledger(uuid,delta,balance,reason,reference)
        VALUES(OLD.uuid,-OLD.coins,0,'administrative_wallet_removal','');
    END IF;
    RETURN OLD;
END $$;
CREATE TRIGGER coin_wallet_removal BEFORE DELETE ON player_stats
FOR EACH ROW EXECUTE FUNCTION record_wallet_removal();
