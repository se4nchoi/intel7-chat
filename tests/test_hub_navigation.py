from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from app.hub import routes

@pytest.fixture
def client(tmp_path, monkeypatch):
    (tmp_path / 'index.html').write_text('<html>edu shell</html>', encoding='utf-8')
    monkeypatch.setattr(routes, 'FRONTEND_BUILD_DIR', tmp_path)
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as client:
        yield client

@pytest.mark.parametrize('path', ['/hub', '/hub/cohorts/demo-2026/chat', '/hub/cohorts/demo-2026/board'])
def test_direct_space_links_serve_ui(client, path):
    response = client.get(path)
    assert response.status_code == 200
    assert response.text == '<html>edu shell</html>'
    assert response.headers['content-type'].startswith('text/html')

@pytest.mark.parametrize('path', ['/hub/api/unknown', '/hub/assets/missing.js', '/hub/cohorts/demo-2026/unknown'])
def test_ui_routes_do_not_swallow_other_paths(client, path):
    assert client.get(path).status_code == 404
