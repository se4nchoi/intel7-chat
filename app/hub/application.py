"""Academy-only ASGI application; never imports the community SQLite app."""
from __future__ import annotations

import asyncio
import re
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.hub import db, routes
from app.hub.settings import allowed_hosts, settings, classrooms


def validate_runtime() -> None:
    """Reject incomplete deployments before creating files or connecting to PostgreSQL."""
    config = settings()
    registry = classrooms()  # Fail closed on malformed operator configuration.
    if not config.database_url:
        raise RuntimeError("MADI_DATABASE_URL is required for the academy app")
    if urlsplit(config.database_url).scheme not in {"postgres", "postgresql"}:
        raise RuntimeError("MADI_DATABASE_URL must be a PostgreSQL URL")
    hosts = allowed_hosts()
    hostname = re.compile(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\Z")
    if not hosts or any(not hostname.fullmatch(host) for host in hosts):
        raise RuntimeError("MADI_ALLOWED_HOSTS must contain explicit host names or IPv4 addresses, without ports")
    media_values = (config.sfu_url, config.livekit_api_key, config.livekit_api_secret)
    if not registry and any(media_values) and not all(media_values):
        raise RuntimeError("Set MADI_SFU_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET together")
    if config.sfu_url and not classrooms():
        url = urlsplit(config.sfu_url)
        if (url.scheme != "wss" or not url.hostname or not hostname.fullmatch(url.hostname) or url.username or url.password
                or url.query or url.fragment or any(c.isspace() for c in config.sfu_url)):
            raise RuntimeError("MADI_SFU_URL must be a browser-reachable wss:// URL without credentials, query or fragment")
        try:
            url.port
        except ValueError:
            raise RuntimeError("MADI_SFU_URL has an invalid port") from None
    if not (routes.FRONTEND_BUILD_DIR / "index.html").is_file():
        raise RuntimeError("Frontend is not built; run npm ci and npm run build in frontend/")


def create_app() -> FastAPI:
    validate_runtime()
    config = settings()

    @asynccontextmanager
    async def lifespan(app):
        try:
            config.file_dir.mkdir(parents=True, exist_ok=True)
            await asyncio.to_thread(db.initialize_schema)
            yield
        finally:
            await asyncio.to_thread(db.close_pools)

    app = FastAPI(title="마디", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=sorted(allowed_hosts() | {"localhost", "127.0.0.1"}))

    connect_sources = ["'self'"]
    if config.sfu_url and not classrooms():
        url = urlsplit(config.sfu_url)
        connect_sources.extend((f"wss://{url.netloc}", f"https://{url.netloc}"))
    for classroom in classrooms().values():
        url = urlsplit(classroom.url)
        connect_sources.extend((f"wss://{url.netloc}", f"https://{url.netloc}"))
    csp = ("default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; "
           "img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; "
           "script-src 'self'; worker-src 'self' blob:; connect-src " + " ".join(connect_sources))

    @app.middleware("http")
    async def response_headers(request, call_next):
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = csp
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "same-origin"
        # Vite assets have content hashes. Pages/API must revalidate after upgrades.
        response.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable"
            if request.url.path.startswith("/hub/assets/") and response.status_code == 200
            else "no-store"
        )
        return response

    @app.get("/", include_in_schema=False)
    async def root():
        return RedirectResponse("/hub")

    @app.get("/health/live", include_in_schema=False)
    async def live():
        return {"status": "ok"}

    app.include_router(routes.router)
    app.mount("/hub/assets", StaticFiles(directory=routes.FRONTEND_BUILD_DIR / "assets"), name="madi-assets")
    return app
