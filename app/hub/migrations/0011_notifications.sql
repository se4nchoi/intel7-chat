CREATE TABLE hub_question_follows (
    question_id BIGINT NOT NULL REFERENCES hub_questions(id) ON DELETE CASCADE,
    account_id BIGINT NOT NULL REFERENCES hub_accounts(id) ON DELETE CASCADE,
    following BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY(question_id, account_id)
);
-- Existing authors and participants follow their questions, without historical alerts.
INSERT INTO hub_question_follows(question_id,account_id)
SELECT id,author_id FROM hub_questions WHERE deleted_at IS NULL
UNION
SELECT a.question_id,a.author_id FROM hub_answers a JOIN hub_questions q ON q.id=a.question_id
WHERE a.deleted_at IS NULL AND q.deleted_at IS NULL;
CREATE TABLE hub_notifications (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES hub_accounts(id) ON DELETE CASCADE,
    actor_id BIGINT NOT NULL REFERENCES hub_accounts(id),
    cohort_id BIGINT NOT NULL REFERENCES hub_cohorts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('answer','mention')),
    question_id BIGINT REFERENCES hub_questions(id) ON DELETE CASCADE,
    answer_id BIGINT REFERENCES hub_answers(id) ON DELETE CASCADE,
    message_id BIGINT REFERENCES hub_messages(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at TIMESTAMPTZ,
    CHECK ((kind='answer' AND question_id IS NOT NULL AND answer_id IS NOT NULL AND message_id IS NULL)
        OR (kind='mention' AND question_id IS NULL AND answer_id IS NULL AND message_id IS NOT NULL)),
    UNIQUE(account_id,answer_id),
    UNIQUE(account_id,message_id)
);
CREATE INDEX hub_notifications_account ON hub_notifications(account_id,id DESC);
CREATE INDEX hub_notifications_unread ON hub_notifications(account_id,id DESC) WHERE read_at IS NULL;
