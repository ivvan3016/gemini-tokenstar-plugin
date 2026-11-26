"""Unit tests for the TokenStar MCP App server (tokenstar-mcp)."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import pytest

import tokenstar.config as ts_config
from tokenstar.config import APP_HTML_ENV_VAR, EXPORT_DIR_ENV_VAR
from tokenstar.mcp_server import APP_URI, create_mcp_server, save_png_export
from tokenstar.scanner import TokenStarScanner


def _extract_tool_payload(result: Any) -> dict[str, Any]:
    """Extract structured dict payload from MCPServer call_tool result."""
    if isinstance(result, tuple):
        return result[1]
    if hasattr(result, "structured_content") and result.structured_content is not None:
        return result.structured_content
    if hasattr(result, "content"):
        return json.loads(result.content[0].text)
    return json.loads(result[0].text)


@pytest.mark.asyncio
async def test_open_tokenstar_payload_and_entrypoints(tmp_brain, tmp_path, monkeypatch):
    monkeypatch.delenv(APP_HTML_ENV_VAR, raising=False)
    html_file = tmp_path / "app.html"
    html_file.write_text("<html><body>TokenStar</body></html>", encoding="utf-8")
    tmp_brain.add_conversation(
        "conv-1",
        lines=[
            {
                "type": "USER_INPUT",
                "content": "hello",
                "created_at": "2026-11-25T10:00:00Z",
            }
        ],
    )
    server = create_mcp_server(TokenStarScanner(tmp_brain.root), html_path=html_file)

    tools = await server.list_tools()
    by_name = {t.name: t for t in tools}
    assert set(by_name) == {
        "open_tokenstar",
        "tokenstar_get_sky_data",
        "tokenstar_refresh",
        "tokenstar_save_export",
    }
    assert by_name["open_tokenstar"].meta["ui"]["resourceUri"] == APP_URI
    assert [
        e["type"]
        for e in by_name["open_tokenstar"].meta["com.google.antigravity/ui"][
            "entrypoints"
        ]
    ] == ["global", "aux_pane"]
    assert by_name["tokenstar_get_sky_data"].meta["ui"]["visibility"] == ["app"]
    assert by_name["tokenstar_refresh"].meta["ui"]["visibility"] == ["app"]
    assert by_name["tokenstar_save_export"].meta["ui"]["visibility"] == ["app"]

    resources = await server.list_resources()
    ui_res = next(r for r in resources if str(r.uri) == APP_URI)
    assert ui_res.mime_type == "text/html;profile=mcp-app"
    assert ui_res.model_dump(by_alias=True)["mimeType"] == "text/html;profile=mcp-app"
    assert ui_res.meta["ui"]["prefersBorder"] is False

    read_items = list(await server.read_resource(APP_URI))
    assert len(read_items) == 1
    assert "TokenStar" in read_items[0].content

    # Call open_tokenstar with empty args {} and assert lightweight payload < 10 KB
    open_res = await server.call_tool("open_tokenstar", {})
    serialized = open_res.model_dump(by_alias=True) if hasattr(open_res, "model_dump") else open_res
    assert len(json.dumps(serialized, default=str, ensure_ascii=False).encode("utf-8")) < 10_240
    open_payload = _extract_tool_payload(open_res)
    assert open_payload["status"] == "ready"
    assert open_payload["default_view"] == "sky"

    # Call app-only tool and verify full schema_version 1.0 payload
    raw_sky = await server.call_tool("tokenstar_get_sky_data", {})
    data = _extract_tool_payload(raw_sky)
    assert data["schema_version"] == "1.0"
    assert len(data["conversations"]) == 1


@pytest.mark.asyncio
async def test_env_html_override_placeholder_and_refresh(tmp_brain, tmp_path, monkeypatch):
    explicit_html = tmp_path / "explicit.html"
    explicit_html.write_text("<html><body>Explicit</body></html>", encoding="utf-8")
    env_html = tmp_path / "env_override.html"
    env_html.write_text("<html><body>EnvOverride</body></html>", encoding="utf-8")

    tmp_brain.add_conversation(
        "conv-1",
        lines=[
            {
                "type": "USER_INPUT",
                "content": "first",
                "created_at": "2026-11-25T10:00:00Z",
            }
        ],
    )

    monkeypatch.setenv(APP_HTML_ENV_VAR, str(env_html))
    server = create_mcp_server(TokenStarScanner(tmp_brain.root), html_path=explicit_html)
    read_items = list(await server.read_resource(APP_URI))
    assert "EnvOverride" in read_items[0].content

    # When env var and explicit html_path point to missing files, fallback placeholder HTML is served
    missing_html = tmp_path / "missing.html"
    monkeypatch.setenv(APP_HTML_ENV_VAR, str(missing_html))
    placeholder_items = list(await server.read_resource(APP_URI))
    assert "<html" in placeholder_items[0].content.lower()

    # Verify tokenstar_refresh picks up newly added conversations
    first_sky = _extract_tool_payload(await server.call_tool("tokenstar_get_sky_data", {}))
    assert len(first_sky["conversations"]) == 1

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
    refreshed_sky = _extract_tool_payload(await server.call_tool("tokenstar_refresh", {}))
    assert len(refreshed_sky["conversations"]) == 2


@pytest.mark.asyncio
async def test_save_export_png_and_validation(tmp_brain, tmp_path):
    export_dir = tmp_path / "downloads"
    server = create_mcp_server(TokenStarScanner(tmp_brain.root), export_dir=export_dir)

    raw_png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRdemo-png-payload"
    b64_png = base64.b64encode(raw_png).decode("ascii")
    data_url = f"data:image/png;base64,{b64_png}"

    first = _extract_tool_payload(
        await server.call_tool(
            "tokenstar_save_export",
            {"png_base64": data_url, "filename": "tokenstar-wallpaper-2x.png"},
        )
    )
    assert first["status"] == "saved"
    assert first["filename"] == "tokenstar-wallpaper-2x.png"
    assert first["bytes"] == len(raw_png)
    assert (export_dir / "tokenstar-wallpaper-2x.png").read_bytes() == raw_png

    # Colliding filenames auto-number instead of overwriting
    second = _extract_tool_payload(
        await server.call_tool(
            "tokenstar_save_export",
            {"png_base64": b64_png, "filename": "tokenstar-wallpaper-2x.png"},
        )
    )
    assert second["filename"] == "tokenstar-wallpaper-2x-2.png"
    assert (export_dir / "tokenstar-wallpaper-2x-2.png").read_bytes() == raw_png

    # Path traversal segments are stripped and forced into a .png inside export_dir
    escaped = _extract_tool_payload(
        await server.call_tool(
            "tokenstar_save_export",
            {"png_base64": b64_png, "filename": "../../evil.exe"},
        )
    )
    assert escaped["filename"] == "evil.png"
    assert (export_dir / "evil.png").is_file()
    assert not (tmp_path / "evil.exe").exists()
    assert not (tmp_path / "evil.png").exists()

    # Reject invalid base64 and non-PNG payloads
    with pytest.raises(ValueError):
        save_png_export("not-valid-base64!!!", export_dir=export_dir)
    non_png_b64 = base64.b64encode(b"JPEG-not-a-png").decode("ascii")
    with pytest.raises(ValueError):
        save_png_export(non_png_b64, export_dir=export_dir)


def test_resolve_export_dir_uses_env_and_system_downloads(tmp_path, monkeypatch):
    system_dl = tmp_path / "SystemDownloads"
    env_dl = tmp_path / "EnvDownloads"
    explicit_dl = tmp_path / "ExplicitDownloads"

    monkeypatch.delenv(EXPORT_DIR_ENV_VAR, raising=False)
    monkeypatch.setattr(ts_config, "detect_system_downloads_dir", lambda: system_dl)
    assert ts_config.resolve_export_dir() == system_dl

    monkeypatch.setenv(EXPORT_DIR_ENV_VAR, str(env_dl))
    assert ts_config.resolve_export_dir() == env_dl
    assert ts_config.resolve_export_dir(explicit_dl) == explicit_dl

    parsed = ts_config._parse_xdg_download_dir(
        '# XDG_DOWNLOAD_DIR="$HOME/Ignored"\nXDG_DOWNLOAD_DIR="$HOME/CustomDownloads"\n',
        Path("/home/demo"),
    )
    assert parsed == Path("/home/demo/CustomDownloads")

    monkeypatch.delenv(EXPORT_DIR_ENV_VAR, raising=False)
    raw_png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRrelocated"
    b64_png = base64.b64encode(raw_png).decode("ascii")
    saved = save_png_export(b64_png, filename="tokenstar-wallpaper-2x.png")
    assert saved["status"] == "saved"
    assert Path(saved["path"]) == system_dl / "tokenstar-wallpaper-2x.png"
    assert (system_dl / "tokenstar-wallpaper-2x.png").read_bytes() == raw_png
