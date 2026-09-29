-- Moderation: posts are hidden rather than erased, recording who removed them.
ALTER TABLE hub_messages ADD COLUMN deleted_at TIMESTAMPTZ, ADD COLUMN deleted_by BIGINT REFERENCES hub_accounts(id);
ALTER TABLE hub_questions ADD COLUMN deleted_at TIMESTAMPTZ, ADD COLUMN deleted_by BIGINT REFERENCES hub_accounts(id);
ALTER TABLE hub_answers ADD COLUMN deleted_at TIMESTAMPTZ, ADD COLUMN deleted_by BIGINT REFERENCES hub_accounts(id);
