"""Configuration constants and path resolution for TokenStar."""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

DEFAULT_BRAIN_DIR: Path = Path.home() / ".gemini" / "antigravity" / "brain"
DEFAULT_GEMINI_CLI_DIR: Path = Path.home() / ".gemini" / "tmp"
DEFAULT_EXPORT_DIR: Path = Path.home() / "Downloads"

BRAIN_DIR_ENV_VAR: str = "TOKENSTAR_BRAIN_DIR"
APP_HTML_ENV_VAR: str = "TOKENSTAR_APP_HTML"
EXPORT_DIR_ENV_VAR: str = "TOKENSTAR_EXPORT_DIR"
PLUGIN_ROOT_ENV_VAR: str = "TOKENSTAR_PLUGIN_ROOT"

DEFAULT_WEB_HOST: str = "127.0.0.1"
DEFAULT_WEB_PORT: int = 18420
WEB_PORT_SCAN_COUNT: int = 20

_DOWNLOADS_FOLDER_GUID = "374DE290-123F-4565-9164-39C4925E467B"


class CelestialThresholds:
    """Deterministic classification and parsing thresholds."""

    ERROR_STATUSES: frozenset[str] = frozenset(
        {"ERROR", "FAILED", "CANCELLED", "ABORTED"}
    )
    ERROR_STEP_RATIO: float = 0.3
    BINARY_MIN_SUBAGENTS: int = 1
    BINARY_MAX_COMPANIONS: int = 5
    PULSAR_MIN_TOOL_CALLS: int = 40
    REQUEST_PULSAR_MIN_TOOL_CALLS: int = 8
    COMET_MAX_USER_TURNS: int = 2
    COMET_MAX_TOOL_CALLS: int = 2
    COMET_MAX_TOTAL_TOKENS: int = 50_000
    TITLE_MAX_LENGTH: int = 60
    SUBAGENT_TOOL_NAMES: frozenset[str] = frozenset({"invoke_subagent", "swarm"})


def _detect_windows_downloads_dir() -> Path | None:
    """Resolve Windows Downloads via Known Folder API or User Shell Folders."""
    try:
        import ctypes
        from ctypes import wintypes

        class _GUID(ctypes.Structure):
            _fields_ = [
                ("Data1", wintypes.DWORD),
                ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD),
                ("Data4", ctypes.c_ubyte * 8),
            ]

        parsed = uuid.UUID(_DOWNLOADS_FOLDER_GUID)
        folder_id = _GUID(
            parsed.fields[0],
            parsed.fields[1],
            parsed.fields[2],
            (ctypes.c_ubyte * 8)(*parsed.bytes[8:]),
        )

        sh_get = ctypes.windll.shell32.SHGetKnownFolderPath
        sh_get.argtypes = [
            ctypes.POINTER(_GUID),
            wintypes.DWORD,
            wintypes.HANDLE,
            ctypes.POINTER(wintypes.LPWSTR),
        ]
        sh_get.restype = ctypes.HRESULT

        co_free = ctypes.windll.ole32.CoTaskMemFree
        co_free.argtypes = [ctypes.c_void_p]
        co_free.restype = None

        raw_ptr = wintypes.LPWSTR()
        try:
            hr = sh_get(ctypes.byref(folder_id), 0, None, ctypes.byref(raw_ptr))
            if hr == 0 and raw_ptr.value:
                return Path(raw_ptr.value)
        finally:
            ptr_addr = ctypes.cast(raw_ptr, ctypes.c_void_p).value
            if ptr_addr:
                co_free(ptr_addr)
    except (OSError, AttributeError, ValueError):
        pass

    try:
        import winreg

        key_path = r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            value, _ = winreg.QueryValueEx(key, f"{{{_DOWNLOADS_FOLDER_GUID}}}")
            if isinstance(value, str) and value.strip():
                return Path(os.path.expandvars(value.strip())).expanduser()
    except (OSError, AttributeError):
        pass

    return None


def _parse_xdg_download_dir(text: str, home: Path) -> Path | None:
    """Parse XDG_DOWNLOAD_DIR from user-dirs.dirs contents."""
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, rhs = line.split("=", 1)
        if key.strip() != "XDG_DOWNLOAD_DIR":
            continue
        val = rhs.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
            val = val[1:-1]
        val = val.replace("${HOME}", str(home)).replace("$HOME", str(home)).strip()
        if val:
            return Path(val).expanduser()
    return None


def _detect_xdg_downloads_dir() -> Path | None:
    """Resolve XDG_DOWNLOAD_DIR on Linux desktops when configured."""
    xdg_config = os.environ.get("XDG_CONFIG_HOME", "").strip()
    config_root = Path(xdg_config).expanduser() if xdg_config else Path.home() / ".config"
    user_dirs = config_root / "user-dirs.dirs"
    try:
        if user_dirs.is_file():
            return _parse_xdg_download_dir(
                user_dirs.read_text(encoding="utf-8", errors="replace"),
                Path.home(),
            )
    except OSError:
        pass
    return None


def detect_system_downloads_dir() -> Path:
    """Detect the OS Downloads directory, falling back to DEFAULT_EXPORT_DIR."""
    detected: Path | None = None
    if sys.platform == "win32":
        detected = _detect_windows_downloads_dir()
    elif sys.platform.startswith("linux"):
        detected = _detect_xdg_downloads_dir()
    return detected if detected is not None else DEFAULT_EXPORT_DIR


def resolve_brain_dir(override: Path | None = None) -> Path:
    """Resolve the Antigravity brain directory from override, env var, or default."""
    if override is not None:
        return override
    env_value = os.environ.get(BRAIN_DIR_ENV_VAR, "").strip()
    if env_value:
        return Path(env_value).expanduser()
    return DEFAULT_BRAIN_DIR


def resolve_export_dir(override: Path | None = None) -> Path:
    """Resolve the PNG export output directory from override, env var, or OS Downloads."""
    if override is not None:
        return override
    env_value = os.environ.get(EXPORT_DIR_ENV_VAR, "").strip()
    if env_value:
        return Path(env_value).expanduser()
    return detect_system_downloads_dir()
