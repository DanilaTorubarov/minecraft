-- Direct messages and group conversations on top of the global realm chat.
-- Global messages keep chat_messages.conversation_id NULL and stay the only
-- messages that are bridged to the Minecraft server.
CREATE TABLE IF NOT EXISTS chat_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
    name TEXT,
    -- Canonical "smaller_id:larger_id" pair keeps one DM per user pair.
    dm_key TEXT UNIQUE,
    created_by BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chat_conversations_shape CHECK (
        (kind = 'dm' AND dm_key IS NOT NULL AND name IS NULL) OR
        (kind = 'group' AND dm_key IS NULL AND name IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS chat_participants (
    conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_read_message_id BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS chat_participants_user_idx ON chat_participants(user_id);

ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES chat_conversations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx
    ON chat_messages(conversation_id, id);

-- A conversation nobody is a member of is unreachable history: drop it (and its
-- messages) as soon as its last participant leaves or their account is deleted.
CREATE OR REPLACE FUNCTION prune_empty_chat_conversation() RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM chat_conversations c
    WHERE c.id = OLD.conversation_id
      AND NOT EXISTS (
          SELECT 1 FROM chat_participants p WHERE p.conversation_id = OLD.conversation_id
      );
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chat_conversation_prune ON chat_participants;
CREATE TRIGGER chat_conversation_prune
    AFTER DELETE ON chat_participants
    FOR EACH ROW EXECUTE FUNCTION prune_empty_chat_conversation();
