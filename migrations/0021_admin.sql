-- Admin privileges for panel operators
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Grant admin rights to the initial user account
UPDATE users SET is_admin = TRUE WHERE id = (SELECT id FROM users ORDER BY id ASC LIMIT 1);
