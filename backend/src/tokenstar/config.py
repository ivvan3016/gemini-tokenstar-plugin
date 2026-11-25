"""Configuration constants and path resolution for TokenStar."""

from __future__ import annotations

import os
from pathlib import Path

DEFAULT_BRAIN_DIR: Path = Path.home() / ".gemini" / "antigravity" / "brain"
DEFAULT_GEMINI_CLI_DIR: Path = Path.home() / ".gemini" / "tmp"

BRAIN_DIR_ENV_VAR: str = "TOKENSTAR_BRAIN_DIR"
APP_HTML_ENV_VAR: str = "TOKENSTAR_APP_HTML"

DEFAULT_WEB_HOST: str = "127.0.0.1"
DEFAULT_WEB_PORT: int = 18420
WEB_PORT_SCAN_COUNT: int = 20


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


def resolve_brain_dir(override: Path | None = None) -> Path:
    """Resolve the Antigravity brain directory from override, env var, or default."""
    if override is not None:
        return override
    env_value = os.environ.get(BRAIN_DIR_ENV_VAR, "").strip()
    if env_value:
        return Path(env_value).expanduser()
    return DEFAULT_BRAIN_DIR
