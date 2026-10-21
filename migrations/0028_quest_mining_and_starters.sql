-- Migration 0028: Expand economy quest kinds to support mining contracts and starter quest systems
ALTER TABLE economy_contracts DROP CONSTRAINT IF EXISTS economy_contracts_kind_check;
ALTER TABLE economy_contracts ADD CONSTRAINT economy_contracts_kind_check
    CHECK (kind = ANY (ARRAY['hunting'::text, 'fishing'::text, 'farming'::text, 'mining'::text, 'starter_iron'::text]));
