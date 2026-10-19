ALTER TABLE hub_questions ADD COLUMN resolved_at TIMESTAMPTZ;
ALTER TABLE hub_questions ADD COLUMN resolved_by BIGINT REFERENCES hub_accounts(id);
CREATE TABLE hub_question_files (
    question_id BIGINT NOT NULL REFERENCES hub_questions(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES hub_files(id),
    PRIMARY KEY (question_id, file_id)
);
