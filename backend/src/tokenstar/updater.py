"""On-demand GitHub Release check and safe self-update support for TokenStar."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import posixpath
import re
import shutil
import stat
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request
import zipfile
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import Any

import tokenstar
from tokenstar.config import APP_HTML_ENV_VAR, PLUGIN_ROOT_ENV_VAR

GITHUB_REPO = "ivvan3016/gemini-tokenstar-plugin"
LATEST_RELEASE_API_URL = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
RELEASE_PAGE_FALLBACK_URL = f"https://github.com/{GITHUB_REPO}/releases"
BUNDLE_ASSET_NAME = "tokenstar-plugin.zip"

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
MAX_ZIP_BYTES = 50 * 1024 * 1024
MAX_APP_HTML_BYTES = 10 * 1024 * 1024
MAX_RELEASE_NOTES_CHARS = 4000

EXTERNAL_TAG_RE = re.compile(
    r"(?is)<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*[\"']?\s*(?:https?:)?//"
)
EXTERNAL_CSS_RE = re.compile(
    r"(?is)(?:@import\s+(?:url\s*\(|[\"'])|\burl\(\s*[\"']?\s*(?:https?:)?//)"
)

_TAG_RE = re.compile(r"^v?\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.]+)?$")
_SEMVER_RE = re.compile(
    r"^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$"
)
_LOCK_ERROR_MARKERS = (
    "os error 32",
    "os error 5",
    "winerror 32",
    "winerror 5",
    "access is denied",
    "being used by another process",
    "另一个程序正在使用此文件",
    "text file busy",
)
_SKIP_HASH_DIRS = {"__pycache__", ".venv", ".pytest_cache"}
_SKIP_HASH_SUFFIXES = (".pyc", ".pyo")

_UPDATE_LOCK = threading.Lock()


def parse_semver(raw: str) -> tuple[tuple[int, int, int], bool, str]:
    """Parse SemVer string into ((major, minor, patch), is_stable, prerelease)."""
    if not isinstance(raw, str):
        raise ValueError("Version must be a string.")
    match = _SEMVER_RE.match(raw.strip())
    if not match:
        raise ValueError(f"Unparseable semantic version: {raw!r}")
    major, minor, patch = int(match.group(1)), int(match.group(2)), int(match.group(3))
    prerelease = match.group(4) or ""
    is_stable = match.group(4) is None
    return (major, minor, patch), is_stable, prerelease


def is_newer_version(latest: str, current: str) -> bool:
    """Return True if latest SemVer is strictly newer than current SemVer."""
    try:
        latest_key = parse_semver(latest)
        current_key = parse_semver(current)
    except ValueError:
        return False

    if latest_key[0] != current_key[0]:
        return latest_key[0] > current_key[0]
    if latest_key[1] != current_key[1]:
        return latest_key[1] > current_key[1]
    return latest_key[2] > current_key[2]


def _dist_parent_root(app_html_path: Path) -> Path | None:
    """Resolve plugin root from a .../dist/app.html path if parent directory is dist."""
    try:
        resolved = app_html_path.expanduser().resolve()
    except OSError:
        resolved = app_html_path.expanduser()
    if resolved.parent.name.lower() == "dist":
        return resolved.parent.parent
    return None


def resolve_plugin_root(
    override: Path | None = None,
    html_path: Path | None = None,
) -> Path | None:
    """Resolve installed plugin root directory when plugin.json exists."""
    candidates: list[Path] = []

    if override is not None:
        candidates.append(override.expanduser())

    env_root = os.environ.get(PLUGIN_ROOT_ENV_VAR, "").strip()
    if env_root:
        candidates.append(Path(env_root).expanduser())

    env_html = os.environ.get(APP_HTML_ENV_VAR, "").strip()
    if env_html:
        derived = _dist_parent_root(Path(env_html))
        if derived is not None:
            candidates.append(derived)

    if html_path is not None:
        derived = _dist_parent_root(html_path)
        if derived is not None:
            candidates.append(derived)

    try:
        candidates.append(Path(__file__).resolve().parents[3])
    except IndexError:
        pass

    for candidate in candidates:
        try:
            resolved = candidate.resolve()
            if resolved.is_dir() and (resolved / "plugin.json").is_file():
                return resolved
        except OSError:
            continue

    return None


def can_self_update_root(plugin_root: Path | None) -> bool:
    """Return True only for installed plugin directories, never dev checkouts."""
    if plugin_root is None:
        return False
    try:
        if not (plugin_root / "plugin.json").is_file():
            return False
        if not (plugin_root / "server").is_dir():
            return False
        if (plugin_root / ".git").exists():
            return False
        if (plugin_root / "frontend").is_dir():
            return False
        return True
    except OSError:
        return False


def get_current_version(plugin_root: Path | None = None) -> str:
    """Read current TokenStar version from plugin.json, package metadata, or fallback."""
    if plugin_root is not None:
        manifest_path = plugin_root / "plugin.json"
        try:
            if manifest_path.is_file():
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                if isinstance(manifest, dict):
                    version = manifest.get("version")
                    if isinstance(version, str) and version.strip():
                        return version.strip().lstrip("vV")
        except (OSError, json.JSONDecodeError):
            pass

    try:
        dist_version = importlib.metadata.version("tokenstar")
        if dist_version.strip():
            return dist_version.strip().lstrip("vV")
    except importlib.metadata.PackageNotFoundError:
        pass

    return tokenstar.__version__.strip().lstrip("vV")


def _open_url(
    req: urllib.request.Request,
    opener: Any | None,
    timeout: float,
) -> Any:
    """Open an HTTP request via custom test opener or stdlib urlopen."""
    if opener is None:
        return urllib.request.urlopen(req, timeout=timeout)
    if hasattr(opener, "open"):
        return opener.open(req, timeout=timeout)
    return opener(req, timeout=timeout)


def _format_check_error(exc: Exception) -> str:
    """Return a concise Simplified Chinese error message for update check failures."""
    if isinstance(exc, urllib.error.HTTPError):
        if exc.code == 403:
            return "GitHub API 访问受限（403），请稍后再试或直接前往 Release 页面查看。"
        if exc.code == 404:
            return "未在 GitHub 上找到已发布的 Release（404）。"
        return f"请求 GitHub Release 失败（HTTP {exc.code}）。"
    if isinstance(exc, TimeoutError):
        return "检查更新超时，请检查网络连接后重试。"
    if isinstance(exc, urllib.error.URLError):
        reason = getattr(exc, "reason", exc)
        return f"无法连接 GitHub：{reason}"
    if isinstance(exc, (json.JSONDecodeError, ValueError)):
        return f"解析 GitHub Release 响应失败：{exc}"
    return f"检查更新失败：{exc}"


def check_for_update(
    plugin_root: Path | None = None,
    html_path: Path | None = None,
    opener: Any | None = None,
    timeout: float = 10.0,
) -> dict[str, Any]:
    """Query GitHub latest release on demand without modifying local files."""
    resolved_root = resolve_plugin_root(override=plugin_root, html_path=html_path)
    current_version = get_current_version(resolved_root)
    root_updatable = can_self_update_root(resolved_root)

    req = urllib.request.Request(
        LATEST_RELEASE_API_URL,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": f"tokenstar-updater/{current_version}",
        },
    )

    try:
        with _open_url(req, opener=opener, timeout=timeout) as resp:
            raw_body = resp.read().decode("utf-8", errors="replace")
        payload = json.loads(raw_body)
        if not isinstance(payload, dict):
            raise ValueError("GitHub Release response is not a JSON object.")
    except (
        urllib.error.HTTPError,
        urllib.error.URLError,
        TimeoutError,
        OSError,
        json.JSONDecodeError,
        ValueError,
    ) as exc:
        return {
            "status": "error",
            "current_version": current_version,
            "latest_version": None,
            "tag_name": None,
            "has_update": False,
            "can_self_update": False,
            "has_bundle_asset": False,
            "release_url": RELEASE_PAGE_FALLBACK_URL,
            "published_at": None,
            "release_notes": "",
            "error": _format_check_error(exc),
        }

    tag_raw = payload.get("tag_name")
    tag_name = tag_raw.strip() if isinstance(tag_raw, str) and tag_raw.strip() else None
    latest_version = tag_name.lstrip("vV") if tag_name else None

    raw_html_url = payload.get("html_url")
    allowed_prefix = f"https://github.com/{GITHUB_REPO}/"
    release_url = (
        raw_html_url
        if isinstance(raw_html_url, str) and raw_html_url.startswith(allowed_prefix)
        else RELEASE_PAGE_FALLBACK_URL
    )

    assets = payload.get("assets")
    has_bundle_asset = isinstance(assets, list) and any(
        isinstance(asset, dict) and asset.get("name") == BUNDLE_ASSET_NAME
        for asset in assets
    )

    published_raw = payload.get("published_at")
    published_at = (
        published_raw.strip()
        if isinstance(published_raw, str) and published_raw.strip()
        else None
    )

    raw_notes = payload.get("body")
    notes_text = raw_notes.strip() if isinstance(raw_notes, str) else ""
    if len(notes_text) > MAX_RELEASE_NOTES_CHARS:
        notes_text = notes_text[: MAX_RELEASE_NOTES_CHARS - 3].rstrip() + "..."

    has_update = (
        latest_version is not None
        and is_newer_version(latest_version, current_version)
    )

    return {
        "status": "ok",
        "current_version": current_version,
        "latest_version": latest_version,
        "tag_name": tag_name,
        "has_update": has_update,
        "can_self_update": root_updatable and has_bundle_asset,
        "has_bundle_asset": has_bundle_asset,
        "release_url": release_url,
        "published_at": published_at,
        "release_notes": notes_text,
        "error": None,
    }


def _is_allowed_bundle_path(rel_posix: str) -> bool:
    """Return True if archive relative POSIX path belongs to TokenStar managed bundle entries."""
    if rel_posix in {"plugin.json", "mcp_config.json", "server/pyproject.toml", "server/uv.lock"}:
        return True
    return (
        rel_posix.startswith("assets/")
        or rel_posix.startswith("dist/")
        or rel_posix.startswith("server/src/")
    )


def _validate_zip_member(raw_name: str, check_root: Path) -> str:
    """Validate zip member path against Zip Slip, symlinks are checked separately."""
    normalized = raw_name.replace("\\", "/")
    if normalized.startswith("/") or normalized.startswith("//"):
        raise ValueError(f"Unsafe absolute path in zip archive: {raw_name}")
    drive, _ = os.path.splitdrive(raw_name)
    if drive:
        raise ValueError(f"Unsafe drive-qualified path in zip archive: {raw_name}")

    cleaned = posixpath.normpath(normalized)
    if cleaned in ("", "."):
        return ""
    parts = [part for part in cleaned.split("/") if part]
    if any(part == ".." for part in parts):
        raise ValueError(f"Unsafe parent traversal in zip archive: {raw_name}")

    dest = check_root.joinpath(*parts).resolve()
    resolved_root = check_root.resolve()
    if dest != resolved_root and not dest.is_relative_to(resolved_root):
        raise ValueError(f"Zip entry escapes target directory: {raw_name}")
    return "/".join(parts)


def _validate_and_read_bundle(zip_path: Path) -> tuple[dict[str, bytes], str]:
    """Validate downloaded release zip archive and extract managed file bytes and version."""
    files: dict[str, bytes] = {}
    total_uncompressed = 0

    with zipfile.ZipFile(zip_path, "r") as zf:
        with tempfile.TemporaryDirectory(prefix="tokenstar-check-") as check_dir:
            check_root = Path(check_dir)
            for info in zf.infolist():
                mode = (info.external_attr >> 16) & 0o170000
                if stat.S_ISLNK(mode):
                    raise ValueError(f"Unsafe symlink in zip archive: {info.filename}")

                rel_posix = _validate_zip_member(info.filename, check_root)
                if info.is_dir() or not rel_posix:
                    continue

                if not _is_allowed_bundle_path(rel_posix):
                    raise ValueError(f"Unexpected file outside managed bundle paths: {rel_posix}")

                if info.file_size > MAX_ZIP_BYTES:
                    raise ValueError(f"Bundle entry too large: {rel_posix}")
                total_uncompressed += info.file_size
                if total_uncompressed > MAX_ZIP_BYTES * 2:
                    raise ValueError("Total uncompressed bundle size exceeds limit.")

                data = zf.read(info.filename)
                if len(data) > MAX_ZIP_BYTES:
                    raise ValueError(f"Bundle entry exceeds size limit: {rel_posix}")
                files[rel_posix] = data

    for req_file in REQUIRED_BUNDLE_FILES:
        if req_file not in files:
            raise ValueError(f"Invalid update bundle: missing {req_file}")

    html_bytes = files["dist/app.html"]
    if len(html_bytes) <= 0 or len(html_bytes) >= MAX_APP_HTML_BYTES:
        raise ValueError("Invalid dist/app.html size inside update bundle.")
    html_text = html_bytes.decode("utf-8")
    if EXTERNAL_TAG_RE.search(html_text) or EXTERNAL_CSS_RE.search(html_text):
        raise ValueError("Update bundle dist/app.html contains disallowed external URLs.")

    manifest = json.loads(files["plugin.json"].decode("utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("Invalid plugin.json inside update bundle.")
    version_raw = manifest.get("version")
    if not isinstance(version_raw, str) or not version_raw.strip():
        raise ValueError("Missing version in update bundle plugin.json.")
    updated_version = version_raw.strip().lstrip("vV")

    return files, updated_version


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _collect_backend_hashes_from_dir(root: Path) -> dict[str, str]:
    """Compute SHA-256 digests for managed backend files under root/server."""
    hashes: dict[str, str] = {}
    for rel in ("server/pyproject.toml", "server/uv.lock"):
        candidate = root.joinpath(*rel.split("/"))
        if candidate.is_file():
            hashes[rel] = _sha256_hex(candidate.read_bytes())

    src_dir = root / "server" / "src"
    if src_dir.is_dir():
        for dirpath, dirnames, filenames in os.walk(src_dir):
            dirnames[:] = sorted(d for d in dirnames if d not in _SKIP_HASH_DIRS)
            cur = Path(dirpath)
            rel_base = cur.relative_to(root)
            for fname in sorted(filenames):
                if fname.endswith(_SKIP_HASH_SUFFIXES):
                    continue
                fpath = cur / fname
                rel_posix = PurePosixPath(*(rel_base / fname).parts).as_posix()
                hashes[rel_posix] = _sha256_hex(fpath.read_bytes())
    return hashes


def _collect_backend_hashes_from_bundle(files: dict[str, bytes]) -> dict[str, str]:
    """Compute SHA-256 digests for backend files inside the incoming bundle."""
    hashes: dict[str, str] = {}
    for rel, data in sorted(files.items()):
        if rel in {"server/pyproject.toml", "server/uv.lock"}:
            hashes[rel] = _sha256_hex(data)
        elif rel.startswith("server/src/"):
            parts = rel.split("/")
            if any(part in _SKIP_HASH_DIRS for part in parts):
                continue
            if rel.endswith(_SKIP_HASH_SUFFIXES):
                continue
            hashes[rel] = _sha256_hex(data)
    return hashes


def _clean_managed_entries(root: Path) -> None:
    """Remove only TokenStar-managed entries while preserving server/.venv."""
    for entry in MANAGED_ENTRIES:
        target = root.joinpath(*entry.split("/"))
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        elif target.exists() or target.is_symlink():
            target.unlink()


def _backup_managed_entries(root: Path, backup_root: Path) -> list[str]:
    """Copy existing managed entries to backup_root before overwriting."""
    backed_up: list[str] = []
    for entry in MANAGED_ENTRIES:
        src = root.joinpath(*entry.split("/"))
        dest = backup_root.joinpath(*entry.split("/"))
        if src.is_dir() and not src.is_symlink():
            shutil.copytree(src, dest, symlinks=False)
            backed_up.append(entry)
        elif src.is_file():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
            backed_up.append(entry)
    return backed_up


def _restore_managed_entries(root: Path, backup_root: Path, backed_up: list[str]) -> None:
    """Restore managed entries from backup_root after a failed write."""
    for entry in MANAGED_ENTRIES:
        target = root.joinpath(*entry.split("/"))
        try:
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            elif target.exists() or target.is_symlink():
                target.unlink()
        except OSError:
            pass

    for entry in backed_up:
        src = backup_root.joinpath(*entry.split("/"))
        dest = root.joinpath(*entry.split("/"))
        if src.is_dir():
            shutil.copytree(src, dest, symlinks=False)
        elif src.is_file():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)


def _is_file_lock_output(output: str) -> bool:
    lowered = output.lower()
    return any(marker in lowered for marker in _LOCK_ERROR_MARKERS)


def _default_run_uv_sync(server_dir: Path) -> tuple[bool, bool, str]:
    """Run uv sync --no-dev, treating Windows running-exe locks as deferred sync."""
    uv_bin = shutil.which("uv")
    if not uv_bin:
        return False, True, "uv not found on PATH"

    base_cmd = [uv_bin, "--project", str(server_dir), "sync", "--no-dev"]
    try:
        proc = subprocess.run(
            base_cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, True, str(exc)

    combined = "\n".join(part for part in (proc.stdout, proc.stderr) if part).strip()
    if proc.returncode == 0:
        return True, False, combined
    if _is_file_lock_output(combined):
        return False, True, combined

    try:
        offline_proc = subprocess.run(
            [*base_cmd, "--offline"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, True, str(exc)

    offline_combined = "\n".join(
        part for part in (offline_proc.stdout, offline_proc.stderr) if part
    ).strip()
    if offline_proc.returncode == 0:
        return True, False, offline_combined
    return False, True, offline_combined or combined


def _resolve_download_url(tag: str | None) -> str:
    """Resolve official GitHub Release zip download URL after validating tag format."""
    if tag is None or not tag.strip():
        return f"https://github.com/{GITHUB_REPO}/releases/latest/download/{BUNDLE_ASSET_NAME}"

    clean_tag = tag.strip()
    if not _TAG_RE.match(clean_tag):
        raise ValueError(f"Invalid release tag format: {clean_tag!r}")
    return f"https://github.com/{GITHUB_REPO}/releases/download/{clean_tag}/{BUNDLE_ASSET_NAME}"


def _download_bundle(
    url: str,
    dest_path: Path,
    current_version: str,
    opener: Any | None,
    timeout: float,
) -> None:
    """Stream release zip bundle to disk while enforcing MAX_ZIP_BYTES."""
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/octet-stream",
            "User-Agent": f"tokenstar-updater/{current_version}",
        },
    )
    total = 0
    with _open_url(req, opener=opener, timeout=timeout) as resp:
        raw_len = resp.headers.get("Content-Length") if hasattr(resp, "headers") and resp.headers else None
        if raw_len is not None:
            try:
                if int(raw_len) > MAX_ZIP_BYTES:
                    raise ValueError("Update bundle exceeds maximum allowed download size.")
            except ValueError as exc:
                if "exceeds" in str(exc):
                    raise
        with dest_path.open("wb") as handle:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_ZIP_BYTES:
                    raise ValueError("Downloaded update bundle exceeds size limit.")
                handle.write(chunk)


def apply_plugin_update(
    tag: str | None = None,
    plugin_root: Path | None = None,
    html_path: Path | None = None,
    opener: Any | None = None,
    run_sync: Callable[[Path], tuple[bool, bool, str]] | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Download, verify, and apply a TokenStar GitHub Release bundle in place."""
    with _UPDATE_LOCK:
        resolved_root = resolve_plugin_root(override=plugin_root, html_path=html_path)
        if not can_self_update_root(resolved_root) or resolved_root is None:
            raise RuntimeError(
                "当前运行环境不支持插件内自动更新，请前往 GitHub Release 手动更新或使用 git pull。"
            )

        previous_version = get_current_version(resolved_root)
        download_url = _resolve_download_url(tag)

        with tempfile.TemporaryDirectory(prefix="tokenstar-update-") as tmp_dir:
            tmp_path = Path(tmp_dir)
            zip_path = tmp_path / BUNDLE_ASSET_NAME
            _download_bundle(
                url=download_url,
                dest_path=zip_path,
                current_version=previous_version,
                opener=opener,
                timeout=timeout,
            )

            files, updated_version = _validate_and_read_bundle(zip_path)
            backend_changed = (
                _collect_backend_hashes_from_dir(resolved_root)
                != _collect_backend_hashes_from_bundle(files)
            )

            backup_dir = tmp_path / "backup"
            backup_dir.mkdir(parents=True, exist_ok=True)
            backed_up = _backup_managed_entries(resolved_root, backup_dir)

            try:
                _clean_managed_entries(resolved_root)
                for rel, data in files.items():
                    dest = resolved_root.joinpath(*rel.split("/"))
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(data)
            except Exception:
                _restore_managed_entries(resolved_root, backup_dir, backed_up)
                raise

        if backend_changed:
            sync_fn = run_sync or _default_run_uv_sync
            _sync_ok, sync_deferred, _detail = sync_fn(resolved_root / "server")
            restart_required = True
            message = f"已更新至 v{updated_version}（包含后端改动），请关闭并重新打开 Antigravity 即可生效。"
        else:
            sync_deferred = False
            restart_required = False
            message = f"已更新至 v{updated_version}（仅界面更新），重新打开 TokenStar 视图即可生效。"

        return {
            "status": "updated",
            "previous_version": previous_version,
            "updated_version": updated_version,
            "backend_changed": backend_changed,
            "restart_required": restart_required,
            "sync_deferred": sync_deferred,
            "message": message,
        }
