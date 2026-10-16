"""Media joins stay scoped to a classroom and independent across browser tabs."""
import jwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.hub import db, routes

SECRET = "test-media-secret-long-enough-for-hs256"
URL = "/hub/api/cohorts/12/channels/34/media-token"


@pytest.fixture
def media(monkeypatch):
    monkeypatch.setenv("MADI_SFU_URL", "wss://academy.local/media")
    monkeypatch.setenv("LIVEKIT_API_KEY", "classroom-test")
    monkeypatch.setenv("LIVEKIT_API_SECRET", SECRET)
    account = {"id": 5, "username": "student", "display_name": "Student"}
    cohort = {"id": 12, "role": "student", "archived": False}
    channel = {"id": 34, "kind": "channel"}
    monkeypatch.setattr(db, "session_account", lambda _: account)
    monkeypatch.setattr(db, "access", lambda *args: cohort)
    monkeypatch.setattr(db, "channel", lambda *args: channel)
    app = FastAPI()
    app.include_router(routes.router)
    return TestClient(app, base_url="https://academy.local"), cohort, channel


def decode(response):
    assert response.status_code == 200
    return jwt.decode(response.json()["token"], SECRET, algorithms=["HS256"], issuer="classroom-test")


def test_multiple_tabs_get_distinct_identities_in_same_scoped_room(media):
    client, _, _ = media
    first = decode(client.post(URL))
    second = decode(client.post(URL))
    assert first["sub"] != second["sub"]
    assert first["video"]["room"] == second["video"]["room"] == "hub-12-34"
    assert first["exp"] - first["iat"] == 300


@pytest.mark.parametrize("role,publish", [("student", False), ("instructor", True), ("admin", True)])
def test_publish_permissions_are_server_controlled(media, role, publish):
    client, cohort, _ = media
    cohort["role"] = role
    grant = decode(client.post(URL))["video"]
    assert grant["canPublish"] is publish
    assert grant["canSubscribe"] is True
    assert grant["canPublishData"] is False
    if publish:
        assert grant["canPublishSources"] == ["screen_share"]


def test_unassigned_cohort_cannot_mint_media_token(media, monkeypatch):
    client, _, _ = media
    monkeypatch.setattr(db, "access", lambda *args: None)
    assert client.post(URL).status_code == 403


def test_dm_channel_cannot_be_used_for_media(media):
    client, _, channel = media
    channel["kind"] = "dm"
    assert client.post(URL).status_code == 404


def test_archived_class_and_foreign_origin_cannot_mint_tokens(media):
    client, cohort, _ = media
    assert client.post(URL, headers={"origin": "https://foreign.example"}).status_code == 403
    cohort["archived"] = True
    assert client.post(URL).status_code == 403
