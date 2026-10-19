-- A full inventory must not monopolize the global sync batch forever.
-- Keep per-player FIFO while rotating eligible queue heads between polls.
ALTER TABLE market_tasks ADD COLUMN last_checked_at TIMESTAMPTZ;
