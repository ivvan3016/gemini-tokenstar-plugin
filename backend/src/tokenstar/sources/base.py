"""Base interfaces and raw parsed session models for log source adapters."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Literal, Protocol, runtime_checkable

from tokenstar.models import ModelBreakdownItem, SourceScanReport, SourceType


@dataclass(frozen=True, slots=True)
class SubagentLink:
    """Directed link from a parent conversation to a child subagent conversation."""

    child_id: str
    role: str = ""
    type_name: str = ""
    spawn_step_index: int | None = None
    spawn_request_id: str | None = None


@dataclass(slots=True)
class RawRequestRecord:
    """Intermediate parsed single model request step."""

    id: str
    session_id: str
    step_index: int
    turn_index: int
    created_at: datetime | None
    local_date: str | None
    model: str
    input_tokens: int
    cache_read_tokens: int
    output_tokens: int
    total_tokens: int
    non_cache_tokens: int
    tool_calls_count: int
    subagent_calls_count: int
    status: str


@dataclass(slots=True)
class RawSessionRecord:
    """Intermediate unmerged session metrics parsed from a single conversation directory."""

    id: str
    source: SourceType
    title: str
    started_at: datetime
    ended_at: datetime
    local_date: str
    primary_model: str
    models: dict[str, ModelBreakdownItem]
    input_tokens: int
    cache_read_tokens: int
    output_tokens: int
    total_tokens: int
    non_cache_tokens: int
    user_turns: int
    model_steps_count: int
    tool_calls_count: int
    subagent_calls_count: int
    error_steps_count: int
    last_status: str
    subagent_links: list[SubagentLink] = field(default_factory=list)
    requests: list[RawRequestRecord] = field(default_factory=list)
    dir_path: Path | None = None


@runtime_checkable
class LogSourceAdapter(Protocol):
    """Adapter contract for scanning a local Gemini / Antigravity log source."""

    source_name: Literal["antigravity", "gemini_cli"]

    def scan(
        self, root_dir: Path | None = None
    ) -> tuple[list[RawSessionRecord], SourceScanReport]:
        """Scan `root_dir` (or default location) and return raw records + diagnostics."""
        ...
