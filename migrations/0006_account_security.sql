ALTER TABLE users ADD COLUMN displayed_nickname TEXT;
UPDATE users SET displayed_nickname = trim(name || ' ' || surname);
ALTER TABLE users ALTER COLUMN displayed_nickname SET NOT NULL;
ALTER TABLE users DROP COLUMN name;
ALTER TABLE users DROP COLUMN surname;
ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;

CREATE TABLE account_email_tokens (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    current_email TEXT NOT NULL,
    target_email TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id)
);
