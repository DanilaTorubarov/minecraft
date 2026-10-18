-- The latest inventory snapshot per in-game UUID, like activity: no foreign key,
-- so it survives unlinking and re-linking restores it.
-- slots is the 41-slot snapshot (hotbar 0-8, main 9-35, armor 36-39, off-hand 40);
-- a null entry is an empty slot.
CREATE TABLE player_inventory (
    uuid TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    slots JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Item icons, one row per item key. The LinkBridge plugin sends the exact
-- texture bytes from the running server jar (Mojang's own assets); the panel
-- keeps the first upload for a key and serves it as a data URL.
CREATE TABLE item_icons (
    key TEXT PRIMARY KEY,
    data_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
