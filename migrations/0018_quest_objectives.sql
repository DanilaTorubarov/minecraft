-- Existing accepted hunting rewards and their reports remain valid.
ALTER TABLE economy_players ADD COLUMN starter_completed BOOLEAN NOT NULL DEFAULT false;
UPDATE economy_players p SET starter_completed=true
WHERE contracts_completed>0 OR EXISTS(SELECT 1 FROM economy_contracts c WHERE c.uuid=p.uuid);
ALTER TABLE economy_contracts ADD COLUMN kind TEXT NOT NULL DEFAULT 'hunting'
    CHECK(kind IN ('hunting','fishing','farming','starter_iron'));
ALTER TABLE economy_contracts ADD COLUMN secondary_progress INTEGER NOT NULL DEFAULT 0 CHECK(secondary_progress>=0);
