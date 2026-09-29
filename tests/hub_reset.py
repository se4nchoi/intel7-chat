"""Shared reset for tests that use the disposable MADI_TEST_DATABASE_URL database."""


def drop_hub_tables(db) -> None:
    """Drop every hub_* table, so new migrations never leave a table behind."""
    with db.connect() as conn:
        names = [r["tablename"] for r in conn.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'hub\\_%'")]
        if names:
            conn.execute("DROP TABLE IF EXISTS " + ", ".join(f'"{n}"' for n in names) + " CASCADE")
