"""Pydantic data contracts shared across TokenStar backend and frontend."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

CelestialType = Literal["star", "black_hole", "binary", "pulsar", "comet"]
SourceType = Literal["antigravity", "gemini_cli"]


class ModelBreakdownItem(BaseModel):
    """Token and step breakdown for a single model within a conversation."""

    model: str
    input_tokens: int = 0
    cache_read_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    steps: int = 0


class SubagentSummary(BaseModel):
    """Aggregated summary of a linked child subagent session."""

    id: str
    role: str = ""
    type_name: str = ""
    parent_session_id: str | None = None
    parent_request_id: str | None = None
    primary_model: str = "unknown"
    request_count: int = 0
    started_at: str = ""
    ended_at: str = ""
    input_tokens: int = 0
    cache_read_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    non_cache_tokens: int = 0
    last_status: str = "UNKNOWN"


class RequestStar(BaseModel):
    """Individual model request rendered as a single star inside a conversation constellation."""

    id: str
    conversation_id: str
    session_id: str
    step_index: int = 0
    turn_index: int = 0
    created_at: str
    local_date: str
    model: str = "unknown"
    input_tokens: int = 0
    cache_read_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    non_cache_tokens: int = 0
    tool_calls_count: int = 0
    subagent_calls_count: int = 0
    status: str = "DONE"
    is_subagent: bool = False
    subagent_role: str = ""
    parent_session_id: str | None = None
    parent_request_id: str | None = None
    celestial_type: CelestialType
    celestial_reason: str


class ConversationStar(BaseModel):
    """Unified star record representing a root conversation (or orphan subagent)."""

    id: str
    source: SourceType
    title: str
    started_at: str
    ended_at: str
    local_date: str
    primary_model: str
    models: list[ModelBreakdownItem]
    input_tokens: int
    cache_read_tokens: int
    output_tokens: int
    total_tokens: int
    non_cache_tokens: int
    user_turns: int
    model_steps_count: int
    tool_calls_count: int
    subagent_calls_count: int
    subagents: list[SubagentSummary] = Field(default_factory=list)
    requests: list[RequestStar] = Field(default_factory=list)
    is_orphan_subagent: bool = False
    error_steps_count: int
    last_status: str
    celestial_type: CelestialType
    celestial_reason: str


class SourceScanReport(BaseModel):
    """Diagnostic scan report for a single log source adapter."""

    source: SourceType
    directory: str
    exists: bool
    scanned_files: int = 0
    parsed_conversations: int = 0
    skipped_files: int = 0
    warnings: list[str] = Field(default_factory=list)


class SkyDataResponse(BaseModel):
    """Top-level payload returned by both MCP App tools and Web API endpoints."""

    schema_version: Literal["1.0"] = "1.0"
    generated_at: str
    scan_duration_ms: float = 0.0
    sources: list[SourceScanReport]
    conversations: list[ConversationStar]
