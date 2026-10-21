-- Migration 0029: Expand economy quest kinds for 4-step starter questline and track starter step
ALTER TABLE economy_contracts DROP CONSTRAINT IF EXISTS economy_contracts_kind_check;
ALTER TABLE economy_contracts ADD CONSTRAINT economy_contracts_kind_check
    CHECK (kind = ANY (ARRAY[
        'hunting'::text,
        'fishing'::text,
        'farming'::text,
        'mining'::text,
        'starter_wood'::text,
        'starter_bed'::text,
        'starter_iron'::text,
        'starter_private'::text
    ]));

ALTER TABLE economy_players ADD COLUMN IF NOT EXISTS starter_step INTEGER NOT NULL DEFAULT 1 CHECK(starter_step BETWEEN 1 AND 5);
UPDATE economy_players SET starter_step=5 WHERE starter_completed=true;
