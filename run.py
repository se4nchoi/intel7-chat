"""Hardened classroom server entry point."""

import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        ws_max_size=8192,
        ws_max_queue=16,
        ws_per_message_deflate=False,
        limit_concurrency=60,
        server_header=False,
    )
