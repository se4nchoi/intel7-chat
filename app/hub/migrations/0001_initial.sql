-- Baseline: the hub schema as of 2026-09-29. IF NOT EXISTS lets databases
-- created before versioned migrations adopt it without changes.
CREATE TABLE IF NOT EXISTS hub_accounts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username TEXT NOT NULL,
    normalized_username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hub_sessions (
    token_hash TEXT PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES hub_accounts(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_sessions_expires ON hub_sessions(expires_at);
CREATE TABLE IF NOT EXISTS hub_cohorts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hub_memberships (
    cohort_id BIGINT NOT NULL REFERENCES hub_cohorts(id) ON DELETE CASCADE,
    account_id BIGINT NOT NULL REFERENCES hub_accounts(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('instructor', 'student')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (cohort_id, account_id)
);
CREATE TABLE IF NOT EXISTS hub_channels (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cohort_id BIGINT NOT NULL REFERENCES hub_cohorts(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (cohort_id, slug),
    UNIQUE (id, cohort_id)
);
CREATE TABLE IF NOT EXISTS hub_messages (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id BIGINT NOT NULL REFERENCES hub_channels(id) ON DELETE CASCADE,
    author_id BIGINT NOT NULL REFERENCES hub_accounts(id),
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_messages_channel ON hub_messages(channel_id, id);
CREATE TABLE IF NOT EXISTS hub_questions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cohort_id BIGINT NOT NULL REFERENCES hub_cohorts(id) ON DELETE CASCADE,
    author_id BIGINT NOT NULL REFERENCES hub_accounts(id),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_questions_cohort ON hub_questions(cohort_id, id);
CREATE TABLE IF NOT EXISTS hub_answers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    question_id BIGINT NOT NULL REFERENCES hub_questions(id) ON DELETE CASCADE,
    author_id BIGINT NOT NULL REFERENCES hub_accounts(id),
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
    endorsed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hub_files (
    id TEXT PRIMARY KEY,
    cohort_id BIGINT NOT NULL REFERENCES hub_cohorts(id) ON DELETE CASCADE,
    uploader_id BIGINT NOT NULL REFERENCES hub_accounts(id),
    original_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_files_cohort ON hub_files(cohort_id, created_at DESC);
