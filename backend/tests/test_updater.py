"""Unit tests for on-demand update checking and safe self-update in tokenstar.updater."""

from __future__ import annotations

import io
import json
import subprocess
import urllib.error
import zipfile
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

import tokenstar.updater as ts_updater
from tokenstar.scanner import TokenStarScanner
from tokenstar.updater import (
    LATEST_RELEASE_API_URL,
    apply_plugin_update,
    check_for_update,
    is_newer_version,
    parse_semver,
)
from tokenstar.web_server import create_web_app


class _FakeHttpResponse:
    """Minimal context-managed response stub for urllib opener injection."""

    def __init__(self, body: bytes, headers: dict[str, str] | None = None) -> None:
        self._buf = io.BytesIO(body)
        self.headers = headers or {}

    def read(self, size: int = -1) -> bytes:
        return self._buf.read(size)

    def __enter__(self) -> _FakeHttpResponse:
        return self

    def __exit__(self, *_args: Any) -> None:
        return None


def _build_bundle_zip_bytes(
    *,
    version: str = "0.2.0",
    app_html: str = "<!doctype html><html><body>Updated v0.2.0</body></html>",
    backend_code: str = '"""backend"""\nVALUE = 1\n',
    extra_files: dict[str, bytes] | None = None,
) -> bytes:
    """Create a valid portable plugin zip archive in memory."""
    buf = io.BytesIO()
    manifest = {
        "name": "tokenstar",
        "displayName": "TokenStar",
        "version": version,
    }
    mcp_cfg = {
        "mcpServers": {
            "tokenstar": {
                "command": "uv",
                "args": ["run", "--project", "${PLUGIN_ROOT}/server", "tokenstar-mcp"],
                "env": {
                    "TOKENSTAR_APP_HTML": "${PLUGIN_ROOT}/dist/app.html",
                    "TOKENSTAR_PLUGIN_ROOT": "${PLUGIN_ROOT}",
                },
            }
        }
    }
    entries: dict[str, bytes] = {
        "plugin.json": json.dumps(manifest).encode("utf-8"),
        "mcp_config.json": json.dumps(mcp_cfg).encode("utf-8"),
        "assets/logo.svg": b"<svg></svg>",
        "dist/app.html": app_html.encode("utf-8"),
        "server/pyproject.toml": b'[project]\nname = "tokenstar"\nversion = "0.2.0"\n',
        "server/uv.lock": b"# lock v1\n",
        "server/src/tokenstar/__init__.py": backend_code.encode("utf-8"),
    }
    if extra_files:
        entries.update(extra_files)

    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for arcname, content in entries.items():
            zf.writestr(arcname, content)
    return buf.getvalue()


def _create_installed_plugin_dir(
    root: Path,
    *,
    version: str = "0.1.1",
    backend_code: str = '"""backend"""\nVALUE = 1\n',
) -> Path:
    """Populate a realistic installed plugin layout including server/.venv sentinel."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "plugin.json").write_text(
        json.dumps({"name": "tokenstar", "version": version}),
        encoding="utf-8",
    )
    (root / "mcp_config.json").write_text(
        json.dumps({"mcpServers": {"tokenstar": {"command": "uv"}}}),
        encoding="utf-8",
    )
    (root / "assets").mkdir(parents=True, exist_ok=True)
    (root / "assets" / "logo.svg").write_text("<svg></svg>", encoding="utf-8")
    (root / "dist").mkdir(parents=True, exist_ok=True)
    (root / "dist" / "app.html").write_text(
        "<!doctype html><html><body>Old v0.1.1</body></html>",
        encoding="utf-8",
    )

    server = root / "server"
    (server / "src" / "tokenstar").mkdir(parents=True, exist_ok=True)
    (server / "pyproject.toml").write_bytes(
        b'[project]\nname = "tokenstar"\nversion = "0.2.0"\n'
    )
    (server / "uv.lock").write_bytes(b"# lock v1\n")
    (server / "src" / "tokenstar" / "__init__.py").write_bytes(
        backend_code.encode("utf-8")
    )

    venv_py = server / ".venv" / "Scripts" / "python.exe"
    venv_py.parent.mkdir(parents=True, exist_ok=True)
    venv_py.write_bytes(b"venv-sentinel")
    return root


def test_parse_semver_and_is_newer_version():
    assert parse_semver("v0.1.1") == ((0, 1, 1), True, "")
    assert parse_semver("1.2.3-beta.1") == ((1, 2, 3), False, "beta.1")

    with pytest.raises(ValueError):
        parse_semver("not-a-version")

    assert is_newer_version("v0.2.0", "0.1.1") is True
    assert is_newer_version("1.0.0", "0.9.9") is True
    assert is_newer_version("0.1.2", "0.1.1") is True
    assert is_newer_version("0.2.0", "0.2.0-rc.1") is True
    assert is_newer_version("0.2.0-beta.2", "0.2.0-beta.1") is True

    assert is_newer_version("0.1.1", "v0.1.1") is False
    assert is_newer_version("0.1.0", "0.1.1") is False
    assert is_newer_version("0.2.0-beta.1", "0.2.0") is False
    assert is_newer_version("invalid", "0.1.1") is False


def test_check_for_update_release_states_dev_guard_and_network_error(tmp_path):
    installed = _create_installed_plugin_dir(tmp_path / "installed-plugin", version="0.1.1")

    release_payload = {
        "tag_name": "v0.2.0",
        "html_url": "https://github.com/ivvan3016/gemini-tokenstar-plugin/releases/tag/v0.2.0",
        "published_at": "2026-11-27T10:00:00Z",
        "body": "### Highlights\n- Added self-updater",
        "assets": [{"name": "tokenstar-plugin.zip"}],
    }

    def ok_opener(req, timeout=10.0):
        assert req.full_url == LATEST_RELEASE_API_URL
        return _FakeHttpResponse(json.dumps(release_payload).encode("utf-8"))

    result = check_for_update(plugin_root=installed, opener=ok_opener)
    assert result["status"] == "ok"
    assert result["current_version"] == "0.1.1"
    assert result["latest_version"] == "0.2.0"
    assert result["tag_name"] == "v0.2.0"
    assert result["has_update"] is True
    assert result["can_self_update"] is True
    assert result["has_bundle_asset"] is True
    assert result["release_url"] == release_payload["html_url"]
    assert "Added self-updater" in result["release_notes"]

    # Same version -> has_update False
    same_payload = {**release_payload, "tag_name": "v0.1.1"}
    same_res = check_for_update(
        plugin_root=installed,
        opener=lambda _req, timeout=10.0: _FakeHttpResponse(
            json.dumps(same_payload).encode("utf-8")
        ),
    )
    assert same_res["status"] == "ok"
    assert same_res["has_update"] is False

    # Dev git checkout -> can_self_update False even when asset exists
    dev_repo = _create_installed_plugin_dir(tmp_path / "dev-repo", version="0.1.1")
    (dev_repo / ".git").mkdir()
    dev_res = check_for_update(plugin_root=dev_repo, opener=ok_opener)
    assert dev_res["status"] == "ok"
    assert dev_res["has_update"] is True
    assert dev_res["can_self_update"] is False

    # Network error -> structured error status with current_version intact
    def failing_opener(_req, timeout=10.0):
        raise urllib.error.URLError("offline")

    err_res = check_for_update(plugin_root=installed, opener=failing_opener)
    assert err_res["status"] == "error"
    assert err_res["current_version"] == "0.1.1"
    assert err_res["has_update"] is False
    assert err_res["can_self_update"] is False
    assert err_res["error"]


def test_apply_plugin_update_frontend_only_and_backend_changed(tmp_path, monkeypatch):
    # 1. Frontend-only update: backend identical, .venv preserved, sync not called
    fe_root = _create_installed_plugin_dir(tmp_path / "fe-plugin", version="0.1.1")
    fe_zip = _build_bundle_zip_bytes(
        version="0.1.2",
        app_html="<!doctype html><html><body>UI 0.1.2</body></html>",
    )
    sync_calls: list[Path] = []

    res_fe = apply_plugin_update(
        tag="v0.1.2",
        plugin_root=fe_root,
        opener=lambda req, timeout=30.0: _FakeHttpResponse(fe_zip),
        run_sync=lambda server_dir: (sync_calls.append(server_dir) or True, False, ""),
    )
    assert res_fe["status"] == "updated"
    assert res_fe["previous_version"] == "0.1.1"
    assert res_fe["updated_version"] == "0.1.2"
    assert res_fe["backend_changed"] is False
    assert res_fe["restart_required"] is False
    assert res_fe["sync_deferred"] is False
    assert sync_calls == []
    assert "UI 0.1.2" in (fe_root / "dist" / "app.html").read_text(encoding="utf-8")
    assert (fe_root / "server" / ".venv" / "Scripts" / "python.exe").read_bytes() == b"venv-sentinel"

    # 2. Backend-changed update + sync succeeds -> restart_required True
    be_root = _create_installed_plugin_dir(tmp_path / "be-plugin", version="0.1.1")
    be_zip = _build_bundle_zip_bytes(
        version="0.2.0",
        app_html="<!doctype html><html><body>UI 0.2.0</body></html>",
        backend_code='"""backend"""\nVALUE = 2\n',
    )
    res_be = apply_plugin_update(
        tag="v0.2.0",
        plugin_root=be_root,
        opener=lambda req, timeout=30.0: _FakeHttpResponse(be_zip),
        run_sync=lambda server_dir: (sync_calls.append(server_dir) or True, False, ""),
    )
    assert sync_calls == [be_root / "server"]
    assert res_be["backend_changed"] is True
    assert res_be["restart_required"] is True
    assert res_be["sync_deferred"] is False
    assert "关闭并重新打开 Antigravity" in res_be["message"]
    assert "VALUE = 2" in (
        be_root / "server" / "src" / "tokenstar" / "__init__.py"
    ).read_text(encoding="utf-8")
    assert (be_root / "server" / ".venv" / "Scripts" / "python.exe").read_bytes() == b"venv-sentinel"

    # 3. Backend-changed update + Windows os error 32 file lock during default uv sync
    lock_root = _create_installed_plugin_dir(tmp_path / "lock-plugin", version="0.1.1")
    monkeypatch.setattr(ts_updater.shutil, "which", lambda _name: "uv")
    monkeypatch.setattr(
        ts_updater.subprocess,
        "run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess(
            args=["uv"],
            returncode=1,
            stdout="",
            stderr="error: failed to remove file tokenstar-mcp.exe: Access is denied. (os error 32)",
        ),
    )
    res_locked = apply_plugin_update(
        tag="v0.2.0",
        plugin_root=lock_root,
        opener=lambda req, timeout=30.0: _FakeHttpResponse(be_zip),
    )
    assert res_locked["status"] == "updated"
    assert res_locked["backend_changed"] is True
    assert res_locked["restart_required"] is True
    assert res_locked["sync_deferred"] is True
    assert "关闭并重新打开 Antigravity" in res_locked["message"]
    assert "VALUE = 2" in (
        lock_root / "server" / "src" / "tokenstar" / "__init__.py"
    ).read_text(encoding="utf-8")


def test_apply_plugin_update_security_guards_and_rollback(tmp_path, monkeypatch):
    # Reject git dev checkout
    dev_repo = _create_installed_plugin_dir(tmp_path / "git-checkout")
    (dev_repo / ".git").mkdir()
    with pytest.raises(RuntimeError, match="不支持插件内自动更新"):
        apply_plugin_update(plugin_root=dev_repo)

    installed = _create_installed_plugin_dir(tmp_path / "safe-plugin", version="0.1.1")

    # Reject unsafe tag strings
    with pytest.raises(ValueError, match="Invalid release tag"):
        apply_plugin_update(tag="../evil", plugin_root=installed)

    # Reject Zip Slip member
    slip_buf = io.BytesIO()
    with zipfile.ZipFile(slip_buf, "w") as zf:
        zf.writestr("../../pwn.txt", b"boom")
    with pytest.raises(ValueError, match="Unsafe parent traversal"):
        apply_plugin_update(
            plugin_root=installed,
            opener=lambda _req, timeout=30.0: _FakeHttpResponse(slip_buf.getvalue()),
        )

    # Reject external URL inside dist/app.html
    ext_zip = _build_bundle_zip_bytes(
        app_html='<html><script src="https://evil.test/x.js"></script></html>'
    )
    with pytest.raises(ValueError, match="external URLs"):
        apply_plugin_update(
            plugin_root=installed,
            opener=lambda _req, timeout=30.0: _FakeHttpResponse(ext_zip),
        )
    # Original dist/app.html remains untouched after validation rejection
    assert "Old v0.1.1" in (installed / "dist" / "app.html").read_text(encoding="utf-8")

    # Automatic rollback on mid-write failure
    valid_zip = _build_bundle_zip_bytes(version="0.2.0")
    orig_write_bytes = Path.write_bytes
    write_count = 0

    def failing_write_bytes(self: Path, data: bytes) -> int:
        nonlocal write_count
        if self.name == "app.html":
            write_count += 1
            if write_count == 1:
                raise OSError("Simulated disk full during app.html write")
        return orig_write_bytes(self, data)

    monkeypatch.setattr(Path, "write_bytes", failing_write_bytes)
    with pytest.raises(OSError, match="Simulated disk full"):
        apply_plugin_update(
            plugin_root=installed,
            opener=lambda _req, timeout=30.0: _FakeHttpResponse(valid_zip),
        )
    assert json.loads((installed / "plugin.json").read_text(encoding="utf-8"))["version"] == "0.1.1"
    assert "Old v0.1.1" in (installed / "dist" / "app.html").read_text(encoding="utf-8")


def test_web_server_update_endpoints(tmp_brain, tmp_path, monkeypatch):
    repo_root = _create_installed_plugin_dir(tmp_path / "repo")
    (repo_root / ".git").mkdir()

    monkeypatch.setattr(
        ts_updater,
        "_open_url",
        lambda req, opener, timeout: _FakeHttpResponse(
            json.dumps(
                {
                    "tag_name": "v0.3.0",
                    "html_url": "https://github.com/ivvan3016/gemini-tokenstar-plugin/releases/tag/v0.3.0",
                    "published_at": "2026-11-27T12:00:00Z",
                    "body": "Release notes",
                    "assets": [{"name": "tokenstar-plugin.zip"}],
                }
            ).encode("utf-8")
        ),
    )

    app = create_web_app(
        TokenStarScanner(tmp_brain.root),
        html_path=repo_root / "dist" / "app.html",
        plugin_root=repo_root,
    )
    client = TestClient(app)

    check_resp = client.get("/api/check-update")
    assert check_resp.status_code == 200
    body = check_resp.json()
    assert body["status"] == "ok"
    assert body["latest_version"] == "0.3.0"
    assert body["has_update"] is True
    assert body["can_self_update"] is False

    apply_resp = client.post("/api/apply-update", json={"tag": "v0.3.0"})
    assert apply_resp.status_code == 400
    assert "不支持" in apply_resp.json()["error"]
