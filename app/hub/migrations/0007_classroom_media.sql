-- Only temporary media routing refers to classrooms. Cohort data never moves.
CREATE TABLE hub_media_sessions (
    id TEXT PRIMARY KEY,
    cohort_id BIGINT NOT NULL,
    channel_id BIGINT NOT NULL UNIQUE,
    classroom_id TEXT NOT NULL UNIQUE,
    owner_id BIGINT NOT NULL REFERENCES hub_accounts(id) ON DELETE CASCADE,
    control_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (channel_id, cohort_id) REFERENCES hub_channels(id, cohort_id) ON DELETE CASCADE
);
