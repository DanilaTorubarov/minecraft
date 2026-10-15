-- Fixed-window counters for the per-IP limits on the auth endpoints. One row per
-- (scope, subject). `window_index` is the fixed time bucket (unix_seconds / window)
-- and `count` resets whenever the bucket rolls over.
CREATE TABLE IF NOT EXISTS auth_rate_limits (
    scope TEXT NOT NULL,
    subject TEXT NOT NULL,
    window_index BIGINT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (scope, subject)
);

-- Per-account failed-login state, driving the exponential-backoff lockout. Keyed by
-- the normalized email; a successful login deletes the row. Cascades with the user.
CREATE TABLE IF NOT EXISTS login_failures (
    email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
    failed_count INTEGER NOT NULL,
    first_failed_at TIMESTAMPTZ NOT NULL,
    locked_until TIMESTAMPTZ
);
