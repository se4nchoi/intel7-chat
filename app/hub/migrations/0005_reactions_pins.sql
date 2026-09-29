-- Emoji reactions on chat messages, and instructor-pinned messages per channel.
CREATE TABLE hub_reactions (
    message_id BIGINT NOT NULL REFERENCES hub_messages(id) ON DELETE CASCADE,
    account_id BIGINT NOT NULL REFERENCES hub_accounts(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, account_id, emoji)
);
ALTER TABLE hub_messages ADD COLUMN pinned_at TIMESTAMPTZ, ADD COLUMN pinned_by BIGINT REFERENCES hub_accounts(id);
CREATE INDEX hub_messages_pinned ON hub_messages(channel_id, pinned_at) WHERE pinned_at IS NOT NULL;
