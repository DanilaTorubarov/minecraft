-- Mirrors the table historically created by hand from the README.
-- IF NOT EXISTS keeps this a no-op on databases that already have it.
CREATE TABLE IF NOT EXISTS users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    surname TEXT NOT NULL,
    login TEXT NOT NULL UNIQUE,
    login_displayed TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
);
