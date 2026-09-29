-- Editing: posts record when they were last edited, and every previous
-- version is kept, like deletions, for the record.
ALTER TABLE hub_messages ADD COLUMN edited_at TIMESTAMPTZ;
ALTER TABLE hub_questions ADD COLUMN edited_at TIMESTAMPTZ;
ALTER TABLE hub_answers ADD COLUMN edited_at TIMESTAMPTZ;
CREATE TABLE hub_edit_history (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('message', 'question', 'answer')),
    item_id BIGINT NOT NULL,
    previous_title TEXT,
    previous_body TEXT NOT NULL,
    edited_by BIGINT NOT NULL REFERENCES hub_accounts(id),
    edited_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX hub_edit_history_item ON hub_edit_history(kind, item_id);
