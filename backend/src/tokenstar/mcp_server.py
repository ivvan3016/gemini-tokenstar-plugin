"""Antigravity MCP App server (tokenstar-mcp) for TokenStar."""

from __future__ import annotations

import argparse
import os
import threading
from pathlib import Path
from typing import Any, Literal

from mcp.server.mcpserver import MCPServer

from tokenstar.config import APP_HTML_ENV_VAR
from tokenstar.scanner import TokenStarScanner

FastMCP = MCPServer

APP_URI = "ui://tokenstar/app.html"
APP_RESOURCE_MIME = "text/html;profile=mcp-app"

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


def create_mcp_server(
    scanner: TokenStarScanner,
    html_path: Path | None = None,
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
