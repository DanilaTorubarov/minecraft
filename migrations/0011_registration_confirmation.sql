-- Pending signups cannot authenticate or reserve a permanent account.
CREATE TABLE pending_registrations (
    email TEXT PRIMARY KEY,
    challenge_hash TEXT NOT NULL UNIQUE,
    code_hash TEXT NOT NULL,
    displayed_nickname TEXT NOT NULL,
    login TEXT NOT NULL,
    login_displayed TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5)
);
CREATE INDEX pending_registrations_expiry ON pending_registrations (expires_at);
