"""Antigravity MCP App server (tokenstar-mcp) for TokenStar."""

from __future__ import annotations

import argparse
import base64
import binascii
import os
import re
import threading
from pathlib import Path
from typing import Any, Literal

from mcp.server.mcpserver import MCPServer

from tokenstar.config import APP_HTML_ENV_VAR, resolve_export_dir
from tokenstar.scanner import TokenStarScanner
from tokenstar.updater import apply_plugin_update, check_for_update

FastMCP = MCPServer

APP_URI = "ui://tokenstar/app.html"
APP_RESOURCE_MIME = "text/html;profile=mcp-app"
MAX_EXPORT_PNG_BYTES = 20 * 1024 * 1024
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_DATA_URL_PREFIX_RE = re.compile(r"^data:image/png;base64,\s*", re.IGNORECASE)
_UNSAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]+")

_PLACEHOLDER_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TokenStar</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #040712;
      color: #dbe7ff;
      font-family: system-ui, -apple-system, sans-serif;
    }
    main {
      max-width: 480px;
      padding: 24px;
      border: 1px solid rgba(158, 203, 255, 0.2);
      border-radius: 12px;
      background: rgba(14, 23, 47, 0.85);
    }
    code { color: #ffe3a3; }
  </style>
</head>
<body>
  <main>
    <h1>TokenStar Frontend Not Built</h1>
    <p>Could not find <code>dist/app.html</code>. Run the frontend build or set <code>TOKENSTAR_APP_HTML</code>.</p>
  </main>
</body>
</html>
"""


def resolve_app_html_path(html_path: Path | None = None) -> Path:
    """Resolve the single-file frontend HTML path via env var, explicit arg, or dist/app.html."""
    env_value = os.environ.get(APP_HTML_ENV_VAR, "").strip()
    if env_value:
        return Path(env_value).expanduser()
    if html_path is not None:
        return html_path

    repo_or_plugin_dist = Path(__file__).resolve().parents[3] / "dist" / "app.html"
    if repo_or_plugin_dist.is_file():
        return repo_or_plugin_dist

    cwd_dist = Path.cwd() / "dist" / "app.html"
    if cwd_dist.is_file():
        return cwd_dist

    return repo_or_plugin_dist


def load_app_html(html_path: Path | None = None) -> str:
    """Read the compiled frontend HTML or return a clean self-contained placeholder."""
    target = resolve_app_html_path(html_path)
    try:
        if target.is_file():
            return target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        pass
    return _PLACEHOLDER_HTML


def _sanitize_png_filename(filename: str) -> str:
    """Normalize an export filename into a safe single-segment .png filename."""
    leaf = Path(filename.strip().replace("\\", "/")).name
    cleaned = _UNSAFE_FILENAME_RE.sub("-", leaf).lstrip(".-")
    if not cleaned:
        return "tokenstar-export.png"
    if not cleaned.lower().endswith(".png"):
        stem = Path(cleaned).stem.lstrip(".-") or "tokenstar-export"
        return f"{stem}.png"
    return cleaned


def save_png_export(
    png_base64: str,
    filename: str = "tokenstar-wallpaper-2x.png",
    export_dir: Path | None = None,
) -> dict[str, Any]:
    """Validate and persist a base64 PNG image into the user export directory."""
    if not isinstance(png_base64, str) or not png_base64.strip():
        raise ValueError("PNG payload cannot be empty.")

    stripped = _DATA_URL_PREFIX_RE.sub("", png_base64.strip(), count=1)
    compact = "".join(stripped.split())
    if not compact:
        raise ValueError("PNG base64 payload cannot be empty.")

    try:
        raw = base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Invalid base64 PNG payload.") from exc

    if not raw or len(raw) > MAX_EXPORT_PNG_BYTES:
        raise ValueError(
            f"PNG size must be between 1 byte and {MAX_EXPORT_PNG_BYTES} bytes."
        )
    if not raw.startswith(_PNG_SIGNATURE):
        raise ValueError("Payload is not a valid PNG image.")

    target_dir = resolve_export_dir(export_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    safe_name = _sanitize_png_filename(filename)
    stem = Path(safe_name).stem or "tokenstar-export"
    dest = target_dir / safe_name
    counter = 2
    while dest.exists():
        dest = target_dir / f"{stem}-{counter}.png"
        counter += 1

    dest.write_bytes(raw)
    return {
        "status": "saved",
        "path": str(dest),
        "filename": dest.name,
        "bytes": len(raw),
    }


def create_mcp_server(
    scanner: TokenStarScanner,
    html_path: Path | None = None,
    export_dir: Path | None = None,
    plugin_root: Path | None = None,
) -> MCPServer:
    """Create and configure the TokenStar MCP App server."""
    server = MCPServer("tokenstar")
    scan_lock = threading.Lock()

    @server.resource(
        APP_URI,
        name="tokenstar_app",
        title="TokenStar",
        description="TokenStar interactive starry sky & usage observatory UI",
        mime_type=APP_RESOURCE_MIME,
        meta={"ui": {"prefersBorder": False}},
    )
    def app_html() -> str:
        """Serve the single-file MCP App frontend HTML."""
        return load_app_html(html_path)

    @server.tool(
        name="open_tokenstar",
        title="TokenStar",
        description="Open the TokenStar starry sky & Gemini token observatory.",
        meta={
            "ui": {
                "resourceUri": APP_URI,
            },
            "com.google.antigravity/ui": {
                "entrypoints": [
                    {"type": "global", "title": "TokenStar"},
                    {"type": "aux_pane", "title": "TokenStar"},
                ]
            },
        },
    )
    def open_tokenstar(
        default_view: Literal["sky", "stats"] = "sky",
    ) -> dict[str, str]:
        """Lightweight launcher tool returning UI readiness metadata only."""
        return {"status": "ready", "default_view": default_view}

    @server.tool(
        name="tokenstar_get_sky_data",
        description="Scan local logs incrementally and return SkyDataResponse.",
        meta={"ui": {"visibility": ["app"]}},
    )
    def tokenstar_get_sky_data() -> dict[str, Any]:
        """App-only tool returning cached/incremental SkyDataResponse."""
        with scan_lock:
            return scanner.scan(force=False).model_dump(mode="json")

    @server.tool(
        name="tokenstar_refresh",
        description="Force a full rescan of local logs and return SkyDataResponse.",
        meta={"ui": {"visibility": ["app"]}},
    )
    def tokenstar_refresh() -> dict[str, Any]:
        """App-only tool forcing re-parse and returning fresh SkyDataResponse."""
        with scan_lock:
            return scanner.scan(force=True).model_dump(mode="json")

    @server.tool(
        name="tokenstar_save_export",
        description="Save an exported 2x PNG sky image locally and return its saved file path.",
        meta={"ui": {"visibility": ["app"]}},
    )
    def tokenstar_save_export(
        png_base64: str,
        filename: str = "tokenstar-wallpaper-2x.png",
    ) -> dict[str, Any]:
        """App-only tool persisting an exported PNG screenshot into the export directory."""
        return save_png_export(png_base64, filename=filename, export_dir=export_dir)

    @server.tool(
        name="tokenstar_check_update",
        description="Check GitHub Releases on demand for a newer TokenStar plugin version.",
        meta={"ui": {"visibility": ["app"]}},
    )
    def tokenstar_check_update() -> dict[str, Any]:
        """App-only tool checking GitHub Releases on demand."""
        return check_for_update(plugin_root=plugin_root, html_path=html_path)

    @server.tool(
        name="tokenstar_apply_update",
        description="Download and apply an official TokenStar GitHub Release bundle in place.",
        meta={"ui": {"visibility": ["app"]}},
    )
    def tokenstar_apply_update(tag: str | None = None) -> dict[str, Any]:
        """App-only tool downloading and applying a TokenStar Release bundle."""
        return apply_plugin_update(
            tag=tag,
            plugin_root=plugin_root,
            html_path=html_path,
        )

    return server


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tokenstar-mcp",
        description="Run the TokenStar Antigravity MCP App stdio server.",
    )
    parser.add_argument(
        "--brain-dir",
        type=Path,
        default=None,
        help="Override the Antigravity brain directory (read-only).",
    )
    parser.add_argument(
        "--html-path",
        type=Path,
        default=None,
        help="Override path to the built single-file app.html.",
    )
    return parser


def main(argv: list[str] | None = None) -> None:
    """CLI entry point for tokenstar-mcp."""
    args = _build_parser().parse_args(argv)
    scanner = TokenStarScanner(brain_dir=args.brain_dir)
    server = create_mcp_server(scanner, html_path=args.html_path)
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
