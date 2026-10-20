-- Live two-way chat integration between website and Minecraft server
CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sender_name TEXT NOT NULL,
    sender_uuid TEXT,
    user_id BIGINT,
    text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('game', 'web', 'system')),
    broadcasted_in_game BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_id_idx ON chat_messages(id);
CREATE INDEX IF NOT EXISTS chat_messages_pending_game ON chat_messages(id) WHERE (source = 'web' AND broadcasted_in_game = FALSE);
