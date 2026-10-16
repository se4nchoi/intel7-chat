-- A presenter change moves the audience to a new room generation. Previously
-- issued JWTs cannot publish into the newly selected presenter's broadcast.
ALTER TABLE hub_media_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE hub_presentation_requests (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES hub_media_sessions(id) ON DELETE CASCADE,
    account_id BIGINT NOT NULL REFERENCES hub_accounts(id) ON DELETE CASCADE,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','cancelled','revoked')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, account_id)
);
CREATE UNIQUE INDEX hub_presentation_one_approved ON hub_presentation_requests(session_id) WHERE status='approved';
