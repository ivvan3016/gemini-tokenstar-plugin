"""Standalone local HTTP server (tokenstar-web) for TokenStar."""

from __future__ import annotations

import argparse
import json
import socket
import threading
import webbrowser
from pathlib import Path

import uvicorn
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse
from starlette.routing import Route

from tokenstar.config import (
    DEFAULT_WEB_HOST,
    DEFAULT_WEB_PORT,
    WEB_PORT_SCAN_COUNT,
    resolve_brain_dir,
)
from tokenstar.mcp_server import load_app_html
from tokenstar.scanner import TokenStarScanner
from tokenstar.updater import apply_plugin_update, check_for_update


def find_available_port(
    host: str = DEFAULT_WEB_HOST,
    start_port: int = DEFAULT_WEB_PORT,
    max_attempts: int = WEB_PORT_SCAN_COUNT,
) -> int:
    """Find the first bindable TCP port starting from start_port."""
    for offset in range(max(0, max_attempts)):
        candidate = start_port + offset
        if not (1 <= candidate <= 65535):
            break
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((host, candidate))
                return candidate
            except OSError:
                continue
    raise RuntimeError(
        f"No available TCP port on {host} in range "
        f"{start_port}..{start_port + max(0, max_attempts) - 1}"
    )


def create_web_app(
    scanner: TokenStarScanner,
    html_path: Path | None = None,
    plugin_root: Path | None = None,
) -> Starlette:
    """Create the Starlette ASGI app serving TokenStar UI and JSON APIs."""
    scan_lock = threading.Lock()

    def index(_request: Request) -> HTMLResponse:
        return HTMLResponse(load_app_html(html_path))

    def get_sky_data(_request: Request) -> JSONResponse:
        with scan_lock:
            payload = scanner.scan(force=False).model_dump(mode="json")
        return JSONResponse(payload)

    def refresh_sky_data(_request: Request) -> JSONResponse:
        with scan_lock:
            payload = scanner.scan(force=True).model_dump(mode="json")
        return JSONResponse(payload)

    def health(_request: Request) -> JSONResponse:
        brain_dir = resolve_brain_dir(getattr(scanner, "_brain_dir", None))
        try:
            brain_exists = brain_dir.is_dir()
        except OSError:
            brain_exists = False
        return JSONResponse(
            {
                "status": "ok",
                "brain_dir": str(brain_dir),
                "brain_dir_exists": brain_exists,
            }
        )

    async def check_update(_request: Request) -> JSONResponse:
        result = await run_in_threadpool(
            check_for_update,
            plugin_root,
            html_path,
        )
        return JSONResponse(result)

    async def apply_update(request: Request) -> JSONResponse:
        tag: str | None = None
        raw_body = await request.body()
        if raw_body.strip():
            try:
                parsed = json.loads(raw_body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                return JSONResponse({"error": f"Invalid JSON request body: {exc}"}, status_code=400)
            if not isinstance(parsed, dict):
                return JSONResponse({"error": "Request body must be a JSON object."}, status_code=400)
            raw_tag = parsed.get("tag")
            if raw_tag is not None:
                if not isinstance(raw_tag, str):
                    return JSONResponse({"error": "Field 'tag' must be a string."}, status_code=400)
                tag = raw_tag

        try:
            result = await run_in_threadpool(
                apply_plugin_update,
                tag,
                plugin_root,
                html_path,
            )
        except (RuntimeError, ValueError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse(result)

    routes = [
        Route("/", index, methods=["GET"]),
        Route("/api/sky-data", get_sky_data, methods=["GET"]),
        Route("/api/refresh", refresh_sky_data, methods=["POST"]),
        Route("/api/health", health, methods=["GET"]),
        Route("/api/check-update", check_update, methods=["GET"]),
        Route("/api/apply-update", apply_update, methods=["POST"]),
    ]
    return Starlette(routes=routes)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tokenstar-web",
        description="Run the standalone local TokenStar HTTP observatory server.",
    )
    parser.add_argument(
        "--brain-dir",
        type=Path,
        default=None,
        help="Override the Antigravity brain directory (read-only).",
    )
    parser.add_argument(
        "--host",
        default=DEFAULT_WEB_HOST,
        help=f"Bind host address (default: {DEFAULT_WEB_HOST}).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_WEB_PORT,
        help=f"Preferred starting TCP port (default: {DEFAULT_WEB_PORT}).",
    )
    parser.add_argument(
        "--html-path",
        type=Path,
        default=None,
        help="Override path to the built single-file app.html.",
    )
    parser.add_argument(
        "--open",
        action="store_true",
        help="Open TokenStar in the default web browser after startup.",
    )
    return parser


def main(argv: list[str] | None = None) -> None:
    """CLI entry point for tokenstar-web."""
    args = _build_parser().parse_args(argv)
    port = find_available_port(
        host=args.host,
        start_port=args.port,
        max_attempts=WEB_PORT_SCAN_COUNT,
    )
    url = f"http://{args.host}:{port}/"
    print(f"TokenStar Web server running at {url}")

    scanner = TokenStarScanner(brain_dir=args.brain_dir)
    app = create_web_app(scanner, html_path=args.html_path)

    if args.open:
        timer = threading.Timer(0.5, webbrowser.open, args=(url,))
        timer.daemon = True
        timer.start()

    uvicorn.run(app, host=args.host, port=port)


if __name__ == "__main__":
    main()
