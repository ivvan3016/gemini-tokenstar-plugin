#!/usr/bin/env python3
"""Cross-platform TokenStar plugin builder, packager, and installer.

Supports installing from source, packaging a portable release zip, or
installing directly from a local zip or GitHub Release without Node.js.
Uses Python standard library modules only.
"""

from __future__ import annotations

import argparse
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

REPO = "ivvan3016/gemini-tokenstar-plugin"
DEFAULT_TARGET = Path.home() / ".gemini" / "config" / "plugins" / "tokenstar"
MANAGED_ENTRIES = (
    "plugin.json",
    "mcp_config.json",
    "assets",
    "dist",
    "server/pyproject.toml",
    "server/uv.lock",
    "server/src",
)
REQUIRED_BUNDLE_FILES = (
    "plugin.json",
    "mcp_config.json",
    "dist/app.html",
    "server/pyproject.toml",
)
EXCLUDED_DIRS = {"__pycache__", ".venv", ".pytest_cache", "tests"}
EXCLUDED_SUFFIXES = (".pyc", ".pyo")
MAX_APP_HTML_BYTES = 10 * 1024 * 1024

EXTERNAL_TAG_RE = re.compile(
    r"(?is)<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*[\"']?\s*(?:https?:)?//"
)
EXTERNAL_CSS_RE = re.compile(
    r"(?is)(?:@import\s+(?:url\s*\(|[\"'])|\burl\(\s*[\"']?\s*(?:https?:)?//)"
)


def repo_root() -> Path:
    """Return repository root relative to this script."""
    return Path(__file__).resolve().parent.parent


def run_checked(cmd: list[str], description: str, env: dict[str, str] | None = None) -> None:
    """Run a subprocess command and raise a clear error on failure."""
    print(f"==> {description}")
    result = subprocess.run(cmd, env=env)
    if result.returncode != 0:
        raise RuntimeError(f"Step failed ({description}) with exit code {result.returncode}.")


def resolve_target_dir(raw: str | None) -> Path:
    """Validate and resolve the target plugin installation directory."""
    if raw is None:
        resolved = DEFAULT_TARGET.resolve()
    else:
        if not raw.strip():
            raise ValueError("Target directory cannot be empty.")
        resolved = Path(os.path.abspath(os.path.expanduser(raw)))

    anchor = Path(resolved.anchor)
    if resolved == anchor or str(resolved).rstrip("\\/") == str(anchor).rstrip("\\/"):
        raise ValueError(f"Refusing to install directly into filesystem root: {resolved}")
    return resolved


def resolve_npm(env: dict[str, str]) -> str:
    """Locate npm executable, preferring npm.cmd on Windows."""
    path_env = env.get("PATH")
    candidates = ("npm.cmd", "npm") if os.name == "nt" else ("npm",)
    for name in candidates:
        found = shutil.which(name, path=path_env)
        if found:
            return found
    raise FileNotFoundError("npm executable not found on PATH (Node.js >= 20 is required to build from source).")


def resolve_uv(env: dict[str, str] | None = None) -> str:
    """Locate uv executable on PATH."""
    path_env = env.get("PATH") if env else None
    found = shutil.which("uv", path=path_env)
    if not found:
        raise FileNotFoundError("uv executable not found on PATH. Install uv: https://docs.astral.sh/uv/")
    return found


def validate_app_html(app_html: Path) -> None:
    """Ensure dist/app.html exists, fits within 10 MiB, and has zero external URLs."""
    print("==> Validating dist/app.html")
    if not app_html.is_file():
        raise FileNotFoundError(f"Expected compiled frontend artifact not found: {app_html}")

    size = app_html.stat().st_size
    if size <= 0:
        raise ValueError(f"dist/app.html is empty: {app_html}")
    if size >= MAX_APP_HTML_BYTES:
        raise ValueError(f"dist/app.html exceeds 10 MiB limit ({size / (1024 * 1024):.2f} MiB): {app_html}")

    content = app_html.read_text(encoding="utf-8")
    if EXTERNAL_TAG_RE.search(content):
        raise ValueError("dist/app.html contains an external http://, https://, or protocol-relative <script> or <link> URL.")
    if EXTERNAL_CSS_RE.search(content):
        raise ValueError("dist/app.html contains an external CSS @import or url(...) network reference.")

    print(f"Validated dist/app.html ({size / 1024.0:.2f} KiB, 0 external script/link/CSS URLs).")


def build_from_source(root: Path, verify: bool) -> None:
    """Build frontend single-file HTML bundle and optionally run full test suites."""
    frontend_dir = root / "frontend"
    backend_dir = root / "backend"
    app_html = root / "dist" / "app.html"

    env = os.environ.copy()
    portable_node = root / ".tools" / "nodejs"
    portable_bin = portable_node / "bin"
    if portable_bin.is_dir():
        env["PATH"] = f"{portable_bin}{os.pathsep}{env.get('PATH', '')}"
    elif portable_node.is_dir():
        env["PATH"] = f"{portable_node}{os.pathsep}{env.get('PATH', '')}"

    npm_bin = resolve_npm(env)
    bin_dir = frontend_dir / "node_modules" / ".bin"
    tsc_bin = bin_dir / ("tsc.cmd" if os.name == "nt" else "tsc")
    vite_bin = bin_dir / ("vite.cmd" if os.name == "nt" else "vite")

    if not (tsc_bin.is_file() and vite_bin.is_file()):
        install_cmd = "ci" if (frontend_dir / "package-lock.json").is_file() else "install"
        run_checked(
            [npm_bin, "--prefix", str(frontend_dir), install_cmd],
            f"Installing frontend dependencies (npm {install_cmd})",
            env=env,
        )

    if verify:
        run_checked([npm_bin, "--prefix", str(frontend_dir), "run", "typecheck"], "Frontend TypeScript check", env=env)
        run_checked([npm_bin, "--prefix", str(frontend_dir), "run", "test"], "Frontend Vitest suite", env=env)

    run_checked([npm_bin, "--prefix", str(frontend_dir), "run", "build"], "Frontend single-file production build", env=env)
    validate_app_html(app_html)

    if verify:
        uv_bin = resolve_uv(env)
        run_checked(
            [uv_bin, "--project", str(backend_dir), "run", "pytest", str(backend_dir / "tests"), "-v"],
            "Backend Pytest suite",
            env=env,
        )


def _walk_filtered(source_dir: Path, rel_prefix: PurePosixPath) -> list[tuple[Path, str]]:
    """Collect filtered (source_path, archive_rel_posix_path) entries recursively."""
    entries: list[tuple[Path, str]] = []
    for entry in sorted(source_dir.iterdir(), key=lambda p: p.name):
        if entry.is_dir():
            if entry.name in EXCLUDED_DIRS:
                continue
            entries.extend(_walk_filtered(entry, rel_prefix / entry.name))
        elif entry.is_file():
            if entry.name.endswith(EXCLUDED_SUFFIXES):
                continue
            entries.append((entry, (rel_prefix / entry.name).as_posix()))
    return entries


def iter_bundle_entries(root: Path) -> list[tuple[Path, str]]:
    """Return validated source paths and bundle-relative POSIX paths."""
    required_paths = [
        root / "plugin" / "plugin.json",
        root / "plugin" / "mcp_config.json",
        root / "plugin" / "assets",
        root / "dist" / "app.html",
        root / "backend" / "pyproject.toml",
        root / "backend" / "uv.lock",
        root / "backend" / "src",
    ]
    for path in required_paths:
        if not path.exists():
            raise FileNotFoundError(f"Required plugin build input missing: {path}")

    entries: list[tuple[Path, str]] = [
        (root / "plugin" / "plugin.json", "plugin.json"),
        (root / "plugin" / "mcp_config.json", "mcp_config.json"),
        (root / "dist" / "app.html", "dist/app.html"),
        (root / "backend" / "pyproject.toml", "server/pyproject.toml"),
        (root / "backend" / "uv.lock", "server/uv.lock"),
    ]
    entries.extend(_walk_filtered(root / "plugin" / "assets", PurePosixPath("assets")))
    entries.extend(_walk_filtered(root / "backend" / "src", PurePosixPath("server/src")))
    return entries


def clean_managed_entries(target_dir: Path) -> None:
    """Create target_dir and remove only TokenStar-managed entries inside it."""
    target_dir.mkdir(parents=True, exist_ok=True)
    for name in MANAGED_ENTRIES:
        managed = target_dir.joinpath(*name.split("/"))
        if managed.is_dir() and not managed.is_symlink():
            shutil.rmtree(managed)
        elif managed.exists() or managed.is_symlink():
            managed.unlink()


def stage_from_source(root: Path, target_dir: Path) -> None:
    """Copy filtered bundle entries from repository source into target_dir."""
    entries = iter_bundle_entries(root)
    print(f"==> Staging TokenStar plugin into {target_dir}")
    clean_managed_entries(target_dir)
    for src, rel in entries:
        dest = target_dir.joinpath(*rel.split("/"))
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)


def pack_bundle(root: Path, output_zip: Path) -> None:
    """Write a portable TokenStar plugin release zip with POSIX paths."""
    entries = iter_bundle_entries(root)
    resolved_zip = Path(os.path.abspath(os.path.expanduser(str(output_zip))))
    resolved_zip.parent.mkdir(parents=True, exist_ok=True)

    print(f"==> Packing TokenStar plugin bundle into {resolved_zip}")
    with zipfile.ZipFile(resolved_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for src, rel in entries:
            zf.write(src, arcname=rel)
    size_kib = resolved_zip.stat().st_size / 1024.0
    print(f"Packed {len(entries)} files into {resolved_zip} ({size_kib:.1f} KiB).")


def _validate_zip_member(raw_name: str, target_dir: Path) -> list[str]:
    """Validate zip member path against path traversal and drive prefixes."""
    normalized = raw_name.replace("\\", "/")
    if normalized.startswith("/") or normalized.startswith("//"):
        raise ValueError(f"Unsafe absolute path in zip archive: {raw_name}")
    drive, _ = os.path.splitdrive(raw_name)
    if drive:
        raise ValueError(f"Unsafe drive-qualified path in zip archive: {raw_name}")

    cleaned = posixpath.normpath(normalized)
    if cleaned in ("", "."):
        return []
    parts = [part for part in cleaned.split("/") if part]
    if any(part == ".." for part in parts):
        raise ValueError(f"Unsafe parent traversal in zip archive: {raw_name}")

    dest = target_dir.joinpath(*parts).resolve()
    resolved_target = target_dir.resolve()
    if dest != resolved_target and not dest.is_relative_to(resolved_target):
        raise ValueError(f"Zip entry escapes target directory: {raw_name}")
    return parts


def extract_zip_to_target(zip_path: Path, target_dir: Path) -> None:
    """Safely verify and extract a TokenStar release zip into target_dir."""
    if not zip_path.is_file():
        raise FileNotFoundError(f"Plugin zip archive not found: {zip_path}")

    print(f"==> Installing TokenStar plugin from {zip_path} into {target_dir}")
    with zipfile.ZipFile(zip_path, "r") as zf:
        infos = zf.infolist()
        validated_files: list[tuple[zipfile.ZipInfo, list[str]]] = []
        present_names: set[str] = set()

        for info in infos:
            parts = _validate_zip_member(info.filename, target_dir)
            if not parts:
                continue
            rel_posix = "/".join(parts)
            if not info.is_dir():
                present_names.add(rel_posix)
                validated_files.append((info, parts))

        missing = [req for req in REQUIRED_BUNDLE_FILES if req not in present_names]
        if missing:
            raise ValueError(f"Zip archive is missing required TokenStar files: {', '.join(missing)}")

        clean_managed_entries(target_dir)
        for info, parts in validated_files:
            dest = target_dir.joinpath(*parts)
            dest.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info, "r") as src_fh, open(dest, "wb") as dst_fh:
                shutil.copyfileobj(src_fh, dst_fh)


def download_release_zip(tag: str, dest: Path) -> None:
    """Download tokenstar-plugin.zip from GitHub Releases."""
    if tag == "latest":
        url = f"https://github.com/{REPO}/releases/latest/download/tokenstar-plugin.zip"
    else:
        url = f"https://github.com/{REPO}/releases/download/{tag}/tokenstar-plugin.zip"

    print(f"==> Downloading prebuilt release bundle from {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "tokenstar-installer/0.1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as out_fh:
        shutil.copyfileobj(resp, out_fh)


def sync_server_env(target_dir: Path) -> None:
    """Initialize or update the isolated server virtualenv using uv."""
    server_dir = target_dir / "server"
    uv_bin = resolve_uv()
    print(f"==> Syncing isolated Python environment in {server_dir}")
    res = subprocess.run([uv_bin, "--project", str(server_dir), "sync", "--no-dev"])
    if res.returncode != 0:
        print("Warning: uv sync --no-dev failed; retrying with --offline using local uv cache.", file=sys.stderr)
        res_offline = subprocess.run([uv_bin, "--project", str(server_dir), "sync", "--no-dev", "--offline"])
        if res_offline.returncode != 0:
            raise RuntimeError(
                f"uv sync --no-dev failed (and --offline fallback failed) in {server_dir}. "
                "For offline environments without a uv cache, re-run with --skip-sync."
            )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse CLI arguments."""
    parser = argparse.ArgumentParser(
        description="Build, package, or install the TokenStar Antigravity MCP App plugin.",
    )
    parser.add_argument(
        "--target-dir",
        default=None,
        help=f"Override installation directory (default: {DEFAULT_TARGET})",
    )
    parser.add_argument(
        "--from-release",
        nargs="?",
        const="latest",
        default=None,
        metavar="TAG",
        help="Install prebuilt tokenstar-plugin.zip from GitHub Releases (default tag: latest).",
    )
    parser.add_argument(
        "--from-zip",
        type=Path,
        default=None,
        metavar="PATH",
        help="Install from a local prebuilt tokenstar-plugin.zip archive.",
    )
    parser.add_argument(
        "--pack",
        type=Path,
        default=None,
        metavar="OUTPUT_ZIP",
        help="Build (unless --skip-build) and create a portable release zip instead of installing.",
    )
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help="Reuse existing dist/app.html when installing or packing from source.",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Run full frontend/backend checks (tsc, vitest, pytest) when building from source.",
    )
    parser.add_argument(
        "--skip-sync",
        action="store_true",
        help="Skip uv sync --no-dev in <target>/server (for offline staging or testing).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Entry point for the cross-platform TokenStar installer."""
    args = parse_args(argv)

    if args.from_release is not None and args.from_zip is not None:
        print("Error: --from-release and --from-zip cannot be used together.", file=sys.stderr)
        return 2
    if args.pack is not None and (args.from_release is not None or args.from_zip is not None):
        print("Error: --pack cannot be combined with --from-release or --from-zip.", file=sys.stderr)
        return 2

    root = repo_root()

    if args.pack is not None:
        if not args.skip_build:
            build_from_source(root, verify=args.verify)
        else:
            validate_app_html(root / "dist" / "app.html")
        pack_bundle(root, args.pack)
        return 0

    target_dir = resolve_target_dir(args.target_dir)

    if args.from_release is not None:
        with tempfile.TemporaryDirectory(prefix="tokenstar-release-") as tmpdir:
            zip_file = Path(tmpdir) / "tokenstar-plugin.zip"
            download_release_zip(args.from_release, zip_file)
            extract_zip_to_target(zip_file, target_dir)
    elif args.from_zip is not None:
        extract_zip_to_target(Path(os.path.expanduser(str(args.from_zip))), target_dir)
    else:
        if not args.skip_build:
            build_from_source(root, verify=args.verify)
        else:
            validate_app_html(root / "dist" / "app.html")
        stage_from_source(root, target_dir)

    if not args.skip_sync:
        sync_server_env(target_dir)
    else:
        print("==> Skipping uv sync (--skip-sync specified).")

    print(f"TokenStar plugin staged cleanly at: {target_dir}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)
