"""Deterministic celestial classification for TokenStar conversations."""

from __future__ import annotations

from tokenstar.config import CelestialThresholds
from tokenstar.models import CelestialType


def classify_celestial(
    last_status: str,
    model_steps_count: int,
    error_steps_count: int,
    subagent_calls_count: int,
    tool_calls_count: int,
    user_turns: int,
    total_tokens: int,
) -> tuple[CelestialType, str]:
    """Classify a conversation into one of 5 celestial types by strict priority."""
    normalized_status = last_status.strip().upper()

    if normalized_status in CelestialThresholds.ERROR_STATUSES:
        return "black_hole", f"结束状态异常 ({normalized_status})"

    if (
        model_steps_count > 0
        and (error_steps_count / model_steps_count)
        >= CelestialThresholds.ERROR_STEP_RATIO
    ):
        return (
            "black_hole",
            f"{error_steps_count}/{model_steps_count} 个响应步骤异常",
        )

    if subagent_calls_count >= CelestialThresholds.BINARY_MIN_SUBAGENTS:
        return "binary", f"调用了 {subagent_calls_count} 次子代理协作"

    if tool_calls_count >= CelestialThresholds.PULSAR_MIN_TOOL_CALLS:
        return "pulsar", f"高频工具调用（累计 {tool_calls_count} 次）"

    if (
        user_turns <= CelestialThresholds.COMET_MAX_USER_TURNS
        and tool_calls_count <= CelestialThresholds.COMET_MAX_TOOL_CALLS
        and total_tokens < CelestialThresholds.COMET_MAX_TOTAL_TOKENS
    ):
        return "comet", f"轻量快问快答（{user_turns} 轮对话）"

    return "star", f"常规深度对话（{user_turns} 轮交互）"


def classify_request_celestial(
    status: str,
    subagent_calls_count: int,
    tool_calls_count: int,
    total_tokens: int,
    is_subagent: bool = False,
) -> tuple[CelestialType, str]:
    """Classify a single model request into one of 5 celestial types."""
    normalized_status = status.strip().upper()

    if normalized_status in CelestialThresholds.ERROR_STATUSES:
        return "black_hole", f"请求异常中断 ({normalized_status})"

    if subagent_calls_count >= 1:
        return "binary", f"本步派发 {subagent_calls_count} 个子代理"

    if tool_calls_count >= CelestialThresholds.REQUEST_PULSAR_MIN_TOOL_CALLS:
        return "pulsar", f"高频并行工具调用（本步 {tool_calls_count} 次）"

    if tool_calls_count == 0 and total_tokens < 15_000:
        return "comet", "子代理轻量步骤" if is_subagent else "轻快单步响应"

    return "star", "子代理推理步骤" if is_subagent else "常规模型请求"
