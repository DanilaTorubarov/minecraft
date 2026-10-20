ALTER TABLE economy_tasks DROP CONSTRAINT economy_tasks_check;
ALTER TABLE economy_tasks ADD CONSTRAINT economy_tasks_check CHECK (
    ((kind = 'reward') AND (contract_id IS NOT NULL) AND (price = 0) AND (repair_units = 0))
    OR ((kind = 'repair') AND (contract_id IS NULL) AND (repair_units > 0) AND (price > 0)
        AND (slot IS NOT NULL) AND (fingerprint IS NOT NULL) AND (item_key IS NOT NULL)
        AND (damage > 0) AND (max_damage >= damage))
);
