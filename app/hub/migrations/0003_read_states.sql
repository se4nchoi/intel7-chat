-- Unread tracking: the newest message each account has seen per channel.
CREATE TABLE hub_read_states (
    account_id BIGINT NOT NULL REFERENCES hub_accounts(id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL REFERENCES hub_channels(id) ON DELETE CASCADE,
    last_read_id BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, channel_id)
);
