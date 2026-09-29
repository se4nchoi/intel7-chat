-- Direct messages: a DM is a channel of kind 'dm' in a cohort, visible only to its two members.
ALTER TABLE hub_channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'channel' CHECK (kind IN ('channel', 'dm'));
CREATE TABLE hub_dm_members (
    channel_id BIGINT NOT NULL REFERENCES hub_channels(id) ON DELETE CASCADE,
    account_id BIGINT NOT NULL REFERENCES hub_accounts(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, account_id)
);
CREATE INDEX hub_dm_members_account ON hub_dm_members(account_id);
