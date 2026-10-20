-- Promised rewards remain fixed. Legacy active contracts have no budget_day;
-- they are grandfathered commitments and still count in measured supply.
ALTER TABLE economy_players ADD COLUMN contracts_completed BIGINT NOT NULL DEFAULT 0 CHECK(contracts_completed>=0);
UPDATE economy_players p SET contracts_completed=(SELECT count(*) FROM economy_contracts c WHERE c.uuid=p.uuid AND c.status='paid');
ALTER TABLE economy_policy ADD COLUMN issuance_budget BIGINT NOT NULL DEFAULT 0 CHECK(issuance_budget>=0);
ALTER TABLE economy_policy ADD COLUMN burn_ema BIGINT NOT NULL DEFAULT 0;
CREATE TABLE economy_budgets (
    day DATE PRIMARY KEY,
    budget BIGINT NOT NULL CHECK(budget>=0),
    reserved BIGINT NOT NULL DEFAULT 0 CHECK(reserved>=0),
    issued BIGINT NOT NULL DEFAULT 0 CHECK(issued>=0),
    eligible BIGINT NOT NULL CHECK(eligible>=0),
    previous_grants BIGINT NOT NULL CHECK(previous_grants>=0),
    burn_ema BIGINT NOT NULL,
    CHECK(reserved+issued<=budget)
);
CREATE TABLE economy_allowances (
    day DATE NOT NULL REFERENCES economy_budgets(day),
    uuid TEXT NOT NULL REFERENCES economy_players(uuid),
    allowance BIGINT NOT NULL CHECK(allowance BETWEEN 0 AND 1200),
    reserved BIGINT NOT NULL DEFAULT 0 CHECK(reserved>=0),
    paid BIGINT NOT NULL DEFAULT 0 CHECK(paid>=0),
    newcomer BOOLEAN NOT NULL,
    PRIMARY KEY(day,uuid),
    CHECK(reserved+paid<=allowance)
);
ALTER TABLE economy_contracts DROP CONSTRAINT economy_contracts_reward_check;
ALTER TABLE economy_contracts ADD CONSTRAINT economy_contracts_reward_check CHECK(reward>=0);
ALTER TABLE economy_contracts ADD COLUMN budget_day DATE REFERENCES economy_budgets(day);
ALTER TABLE economy_contracts ADD COLUMN reward_iron INTEGER NOT NULL DEFAULT 0 CHECK(reward_iron BETWEEN 0 AND 8);
ALTER TABLE economy_contracts ADD COLUMN reward_bread INTEGER NOT NULL DEFAULT 0 CHECK(reward_bread BETWEEN 0 AND 16);
ALTER TABLE economy_contracts ADD COLUMN reward_xp INTEGER NOT NULL DEFAULT 0 CHECK(reward_xp BETWEEN 0 AND 5);
CREATE TABLE economy_tasks (
    sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    uuid TEXT NOT NULL REFERENCES economy_players(uuid),
    kind TEXT NOT NULL CHECK(kind IN ('reward','repair')),
    contract_id TEXT UNIQUE REFERENCES economy_contracts(id),
    iron INTEGER NOT NULL DEFAULT 0 CHECK(iron BETWEEN 0 AND 8),
    bread INTEGER NOT NULL DEFAULT 0 CHECK(bread BETWEEN 0 AND 16),
    xp INTEGER NOT NULL DEFAULT 0 CHECK(xp BETWEEN 0 AND 5),
    slot INTEGER CHECK(slot BETWEEN 0 AND 40),
    fingerprint TEXT,
    item_key TEXT,
    damage INTEGER,
    max_damage INTEGER,
    repair_units INTEGER NOT NULL DEFAULT 0 CHECK(repair_units BETWEEN 0 AND 3),
    price BIGINT NOT NULL DEFAULT 0 CHECK(price>=0),
    payload_hash TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','conflict')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_checked_at TIMESTAMPTZ,
    CHECK((kind='reward' AND contract_id IS NOT NULL AND price=0 AND repair_units=0)
       OR (kind='repair' AND contract_id IS NULL AND repair_units>0 AND price=repair_units*10
           AND slot IS NOT NULL AND fingerprint IS NOT NULL AND item_key IS NOT NULL
           AND damage>0 AND max_damage>=damage))
);
CREATE INDEX economy_tasks_pending ON economy_tasks(uuid,sequence) WHERE status='pending';
CREATE UNIQUE INDEX economy_repair_pending ON economy_tasks(uuid) WHERE kind='repair' AND status='pending';
CREATE INDEX coin_ledger_economy_flow ON coin_ledger(created_at,reason);
ALTER TABLE economy_reviews ADD COLUMN issuance_budget BIGINT NOT NULL DEFAULT 0;
ALTER TABLE economy_reviews ADD COLUMN burn_ema BIGINT NOT NULL DEFAULT 0;
ALTER TABLE economy_reviews ADD COLUMN committed_rewards BIGINT NOT NULL DEFAULT 0;
-- A server upgrading after today's old review starts with no new coin promises
-- until the next observation. Do not erase or rewrite that historical review.
INSERT INTO economy_budgets(day,budget,eligible,previous_grants,burn_ema)
SELECT current_date,0,0,0,0 FROM economy_policy WHERE reviewed_day=current_date;
