"""Unit tests for the standalone local TokenStar Web server (tokenstar-web)."""

from __future__ import annotations

import socket

import pytest
from httpx import ASGITransport, AsyncClient

from tokenstar.config import APP_HTML_ENV_VAR
from tokenstar.scanner import TokenStarScanner
from tokenstar.web_server import create_web_app, find_available_port


@pytest.mark.asyncio
async def test_web_routes_and_port_fallback(tmp_brain, tmp_path, monkeypatch):
    monkeypatch.delenv(APP_HTML_ENV_VAR, raising=False)
    html_file = tmp_path / "app.html"
    html_file.write_text("<html><body>TokenStar Web</body></html>", encoding="utf-8")
    tmp_brain.add_conversation(
        "conv-1",
        lines=[
            {
                "type": "USER_INPUT",
                "content": "hi",
                "created_at": "2026-11-25T10:00:00Z",
            }
        ],
    )
    app = create_web_app(TokenStarScanner(tmp_brain.root), html_path=html_file)

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://127.0.0.1"
    ) as client:
        r_html = await client.get("/")
        assert r_html.status_code == 200 and "TokenStar Web" in r_html.text
        assert "text/html" in r_html.headers["content-type"]

        r_data = await client.get("/api/sky-data")
        assert r_data.status_code == 200 and r_data.json()["schema_version"] == "1.0"
        assert len(r_data.json()["conversations"]) == 1

        tmp_brain.add_conversation(
            "conv-2",
            lines=[
                {
                    "type": "USER_INPUT",
                    "content": "second",
                    "created_at": "2026-11-25T11:00:00Z",
                }
            ],
        )
        r_ref = await client.post("/api/refresh")
        assert r_ref.status_code == 200 and len(r_ref.json()["conversations"]) == 2

        r_health = await client.get("/api/health")
        assert r_health.status_code == 200
        health = r_health.json()
        assert health["status"] == "ok"
        assert health["brain_dir"] == str(tmp_brain.root)

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        busy_port = sock.getsockname()[1]
        available = find_available_port("127.0.0.1", busy_port, max_attempts=5)
        assert available != busy_port
        assert busy_port < available < busy_port + 5

        with pytest.raises(RuntimeError):
            find_available_port("127.0.0.1", busy_port, max_attempts=1)


@pytest.mark.asyncio
async def test_web_placeholder_html_when_missing(tmp_brain, tmp_path, monkeypatch):
    monkeypatch.delenv(APP_HTML_ENV_VAR, raising=False)
    missing = tmp_path / "nonexistent.html"
    app = create_web_app(TokenStarScanner(tmp_brain.root), html_path=missing)

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://127.0.0.1"
    ) as client:
        resp = await client.get("/")
        assert resp.status_code == 200
        assert "TokenStar Frontend Not Built" in resp.text
