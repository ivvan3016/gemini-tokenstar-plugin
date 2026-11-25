"""Strictly read-only Antigravity transcript and subagent log parser."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone, tzinfo
from pathlib import Path
from typing import Any, Literal

from tokenstar.config import CelestialThresholds, resolve_brain_dir
from tokenstar.models import ModelBreakdownItem, SourceScanReport
from tokenstar.sources.base import RawRequestRecord, RawSessionRecord, SubagentLink

_METADATA_BLOCK_RE = re.compile(
    r"<ADDITIONAL_METADATA>.*?</ADDITIONAL_METADATA>",
    re.IGNORECASE | re.DOTALL,
)
_SETTINGS_BLOCK_RE = re.compile(
    r"<USER_SETTINGS_CHANGE>.*?</USER_SETTINGS_CHANGE>",
    re.IGNORECASE | re.DOTALL,
)
_USER_REQUEST_TAG_RE = re.compile(r"</?USER_REQUEST>", re.IGNORECASE)
_CONVERSATION_ID_RE = re.compile(
    r'"(?:conversationId|conversation_id)"\s*:\s*"([^"]+)"'
)


def sanitize_title(raw_content: str, conv_id: str) -> str:
    """Strip Antigravity XML wrapper tags and return a clean, truncated title."""
    cleaned = _METADATA_BLOCK_RE.sub("", raw_content)
    cleaned = _SETTINGS_BLOCK_RE.sub("", cleaned)
    cleaned = _USER_REQUEST_TAG_RE.sub("", cleaned)

    for line in cleaned.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped[: CelestialThresholds.TITLE_MAX_LENGTH]

    return f"对话 {conv_id[:8]}"


def _safe_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return value


def _parse_iso_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        dt = datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _read_json_readonly(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8-sig", errors="replace") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None


def _iter_json_dicts(payload: Any):
    """Yield every dict nested inside a JSON payload."""
    if isinstance(payload, dict):
        yield payload
        for value in payload.values():
            yield from _iter_json_dicts(value)
    elif isinstance(payload, list):
        for item in payload:
            yield from _iter_json_dicts(item)


def extract_subagent_links(
    conv_dir: Path, tool_outputs: list[str]
) -> list[SubagentLink]:
    """Discover child subagent links from subagents/, messages/, and tool outputs."""
    self_id = conv_dir.name
    links_by_id: dict[str, SubagentLink] = {}

    def record(child_id: Any, role: Any = "", type_name: Any = "") -> None:
        if not isinstance(child_id, str):
            return
        cid = child_id.strip()
        if not cid or cid == self_id:
            return
        role_str = role.strip() if isinstance(role, str) else ""
        type_str = type_name.strip() if isinstance(type_name, str) else ""
        existing = links_by_id.get(cid)
        if existing is None:
            links_by_id[cid] = SubagentLink(
                child_id=cid, role=role_str, type_name=type_str
            )
        elif (not existing.role and role_str) or (not existing.type_name and type_str):
            links_by_id[cid] = SubagentLink(
                child_id=cid,
                role=existing.role or role_str,
                type_name=existing.type_name or type_str,
            )

    # 1. Primary source: .system_generated/subagents/*.json
    subagents_dir = conv_dir / ".system_generated" / "subagents"
    try:
        if subagents_dir.is_dir():
            for sub_file in sorted(subagents_dir.glob("*.json")):
                data = _read_json_readonly(sub_file)
                if isinstance(data, dict):
                    descriptor = data.get("subagentDescriptor")
                    desc = descriptor if isinstance(descriptor, dict) else {}
                    record(
                        data.get("conversationId"),
                        desc.get("role", ""),
                        desc.get("typeName", ""),
                    )
    except OSError:
        pass

    # 2. Fallback: .system_generated/messages/*.json
    messages_dir = conv_dir / ".system_generated" / "messages"
    try:
        if messages_dir.is_dir():
            for msg_file in sorted(messages_dir.glob("*.json")):
                data = _read_json_readonly(msg_file)
                for node in _iter_json_dicts(data):
                    source_meta = node.get("sourceMetadata")
                    if not isinstance(source_meta, dict):
                        continue
                    tool_meta = source_meta.get("tool")
                    if not isinstance(tool_meta, dict):
                        continue
                    descriptor = tool_meta.get("subagentDescriptor")
                    desc = descriptor if isinstance(descriptor, dict) else {}
                    record(
                        tool_meta.get("conversationId"),
                        tool_meta.get("role") or desc.get("role", ""),
                        tool_meta.get("typeName") or desc.get("typeName", ""),
                    )
    except OSError:
        pass

    # 3. Fallback: tool outputs / transcript payloads
    for raw_output in tool_outputs:
        if not isinstance(raw_output, str) or not raw_output:
            continue
        parsed: Any = None
        try:
            parsed = json.loads(raw_output)
        except json.JSONDecodeError:
            parsed = None

        if parsed is not None:
            for node in _iter_json_dicts(parsed):
                cid = node.get("conversationId") or node.get("conversation_id")
                descriptor = node.get("subagentDescriptor")
                desc = descriptor if isinstance(descriptor, dict) else {}
                record(
                    cid,
                    node.get("role") or desc.get("role", ""),
                    node.get("typeName") or desc.get("typeName", ""),
                )

        for match in _CONVERSATION_ID_RE.findall(raw_output):
            record(match)

    return list(links_by_id.values())


def _collect_tool_output_strings(tool_call: dict[str, Any], out: list[str]) -> None:
    """Extract candidate JSON/string payloads from a tool_call dictionary."""
    for key in ("output", "result", "response", "payload"):
        val = tool_call.get(key)
        if isinstance(val, str) and val:
            out.append(val)
        elif isinstance(val, (dict, list)):
            out.append(json.dumps(val, ensure_ascii=False))
    if "conversationId" in tool_call or "conversation_id" in tool_call:
        out.append(json.dumps(tool_call, ensure_ascii=False))


def parse_antigravity_dir(
    conv_dir: Path, tz: tzinfo | None = None
) -> tuple[RawSessionRecord | None, list[str]]:
    """Parse a single Antigravity conversation directory strictly read-only."""
    conv_id = conv_dir.name
    transcript_path = conv_dir / ".system_generated" / "logs" / "transcript.jsonl"
    warnings: list[str] = []

    try:
        if not transcript_path.is_file():
            return None, warnings
    except OSError as exc:
        return None, [f"无法访问对话 {conv_id}: {exc}"]

    try:
        with transcript_path.open("r", encoding="utf-8-sig", errors="replace") as fh:
            raw_lines = fh.readlines()
    except OSError as exc:
        return None, [f"无法读取对话 {conv_id}: {exc}"]

    valid_entries = 0
    earliest_ts: datetime | None = None
    latest_ts: datetime | None = None
    input_tokens = 0
    cache_read_tokens = 0
    output_tokens = 0
    models: dict[str, ModelBreakdownItem] = {}
    user_turns = 0
    first_user_content: str | None = None
    model_steps_count = 0
    tool_calls_count = 0
    tool_subagent_calls = 0
    error_steps_count = 0
    last_status = "UNKNOWN"
    tool_outputs: list[str] = []
    raw_requests: list[RawRequestRecord] = []
    seen_request_ids: dict[str, int] = {}

    for line_no, raw_line in enumerate(raw_lines, start=1):
        stripped = raw_line.strip()
        if not stripped:
            continue
        try:
            entry = json.loads(stripped)
        except json.JSONDecodeError as exc:
            warnings.append(f"{conv_id} 第 {line_no} 行 JSON 解析失败: {exc.msg}")
            continue

        if not isinstance(entry, dict):
            warnings.append(f"{conv_id} 第 {line_no} 行格式异常: 非 JSON 对象")
            continue

        valid_entries += 1

        ts = _parse_iso_timestamp(entry.get("created_at"))
        if ts is not None:
            if earliest_ts is None or ts < earliest_ts:
                earliest_ts = ts
            if latest_ts is None or ts > latest_ts:
                latest_ts = ts

        step_in = _safe_int(entry.get("input_tokens"))
        step_cache = _safe_int(entry.get("cache_read_tokens"))
        step_out = _safe_int(entry.get("output_tokens"))
        step_total = step_in + step_cache + step_out
        input_tokens += step_in
        cache_read_tokens += step_cache
        output_tokens += step_out

        raw_model = entry.get("model")
        model_name = raw_model.strip() if isinstance(raw_model, str) else ""
        if model_name:
            bucket = models.get(model_name)
            if bucket is None:
                models[model_name] = ModelBreakdownItem(
                    model=model_name,
                    input_tokens=step_in,
                    cache_read_tokens=step_cache,
                    output_tokens=step_out,
                    total_tokens=step_total,
                    steps=1,
                )
            else:
                bucket.input_tokens += step_in
                bucket.cache_read_tokens += step_cache
                bucket.output_tokens += step_out
                bucket.total_tokens += step_total
                bucket.steps += 1

        entry_type = entry.get("type")
        if entry_type == "USER_INPUT":
            user_turns += 1
            if first_user_content is None:
                raw_content = entry.get("content")
                first_user_content = raw_content if isinstance(raw_content, str) else ""

        if model_name or entry_type == "PLANNER_RESPONSE":
            model_steps_count += 1

        raw_status = entry.get("status")
        step_status = "DONE"
        if isinstance(raw_status, str) and raw_status.strip():
            clean_status = raw_status.strip()
            last_status = clean_status
            step_status = clean_status
            if clean_status.upper() in CelestialThresholds.ERROR_STATUSES:
                error_steps_count += 1

        tool_calls = entry.get("tool_calls")
        step_tool_calls = 0
        step_subagent_calls = 0
        if isinstance(tool_calls, list):
            step_tool_calls = len(tool_calls)
            tool_calls_count += step_tool_calls
            for tc in tool_calls:
                if not isinstance(tc, dict):
                    continue
                if tc.get("name") in CelestialThresholds.SUBAGENT_TOOL_NAMES:
                    step_subagent_calls += 1
                    tool_subagent_calls += 1
                    _collect_tool_output_strings(tc, tool_outputs)
                elif "conversationId" in tc or "conversation_id" in tc:
                    _collect_tool_output_strings(tc, tool_outputs)

        is_model_request = (
            bool(model_name)
            or entry_type == "PLANNER_RESPONSE"
            or step_total > 0
        )
        if is_model_request:
            raw_step_idx = entry.get("step_index")
            step_idx = (
                raw_step_idx
                if isinstance(raw_step_idx, int)
                and not isinstance(raw_step_idx, bool)
                else line_no
            )
            base_req_id = f"{conv_id}:{step_idx}"
            dup_count = seen_request_ids.get(base_req_id, 0)
            seen_request_ids[base_req_id] = dup_count + 1
            req_id = (
                base_req_id if dup_count == 0 else f"{base_req_id}:{dup_count}"
            )
            req_local_date: str | None = None
            if ts is not None:
                req_local_dt = (
                    ts.astimezone(tz) if tz is not None else ts.astimezone()
                )
                req_local_date = req_local_dt.strftime("%Y-%m-%d")

            raw_requests.append(
                RawRequestRecord(
                    id=req_id,
                    session_id=conv_id,
                    step_index=step_idx,
                    turn_index=user_turns,
                    created_at=ts,
                    local_date=req_local_date,
                    model=model_name or "unknown",
                    input_tokens=step_in,
                    cache_read_tokens=step_cache,
                    output_tokens=step_out,
                    total_tokens=step_total,
                    non_cache_tokens=step_in + step_out,
                    tool_calls_count=step_tool_calls,
                    subagent_calls_count=step_subagent_calls,
                    status=step_status,
                )
            )

    if valid_entries == 0:
        warnings.append(f"{conv_id} transcript.jsonl 无有效 JSON 记录")
        return None, warnings

    if earliest_ts is None or latest_ts is None:
        try:
            mtime = transcript_path.stat().st_mtime
            fallback_dt = datetime.fromtimestamp(mtime, tz=timezone.utc)
        except OSError:
            fallback_dt = datetime.now(tz=timezone.utc)
        started_at = earliest_ts or fallback_dt
        ended_at = latest_ts or started_at
    else:
        started_at = earliest_ts
        ended_at = latest_ts

    local_dt = (
        started_at.astimezone(tz) if tz is not None else started_at.astimezone()
    )
    local_date = local_dt.strftime("%Y-%m-%d")

    for req in raw_requests:
        if req.created_at is None:
            req.created_at = started_at
        if req.local_date is None:
            req.local_date = local_date

    primary_model = (
        max(models.values(), key=lambda m: (m.total_tokens, m.steps, m.model)).model
        if models
        else "unknown"
    )
    title = sanitize_title(first_user_content or "", conv_id)
    subagent_links = extract_subagent_links(conv_dir, tool_outputs)
    subagent_calls_count = max(tool_subagent_calls, len(subagent_links))
    total_tokens = input_tokens + cache_read_tokens + output_tokens
    non_cache_tokens = input_tokens + output_tokens

    record = RawSessionRecord(
        id=conv_id,
        source="antigravity",
        title=title,
        started_at=started_at,
        ended_at=ended_at,
        local_date=local_date,
        primary_model=primary_model,
        models=models,
        input_tokens=input_tokens,
        cache_read_tokens=cache_read_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        non_cache_tokens=non_cache_tokens,
        user_turns=user_turns,
        model_steps_count=model_steps_count,
        tool_calls_count=tool_calls_count,
        subagent_calls_count=subagent_calls_count,
        error_steps_count=error_steps_count,
        last_status=last_status,
        subagent_links=subagent_links,
        requests=raw_requests,
        dir_path=conv_dir,
    )
    return record, warnings


class AntigravityTranscriptAdapter:
    """LogSourceAdapter reading Antigravity conversation transcripts."""

    source_name: Literal["antigravity", "gemini_cli"] = "antigravity"

    def __init__(self, tz: tzinfo | None = None) -> None:
        self._tz = tz

    def scan(
        self, root_dir: Path | None = None
    ) -> tuple[list[RawSessionRecord], SourceScanReport]:
        target_dir = resolve_brain_dir(root_dir)
        try:
            exists = target_dir.exists() and target_dir.is_dir()
        except OSError as exc:
            return [], SourceScanReport(
                source=self.source_name,
                directory=str(target_dir),
                exists=False,
                warnings=[f"无法访问日志根目录 {target_dir}: {exc}"],
            )

        if not exists:
            return [], SourceScanReport(
                source=self.source_name,
                directory=str(target_dir),
                exists=False,
            )

        records: list[RawSessionRecord] = []
        report = SourceScanReport(
            source=self.source_name,
            directory=str(target_dir),
            exists=True,
        )

        try:
            entries = sorted(target_dir.iterdir(), key=lambda p: p.name)
        except OSError as exc:
            report.warnings.append(f"无法遍历目录 {target_dir}: {exc}")
            return [], report

        for conv_dir in entries:
            try:
                if not conv_dir.is_dir():
                    continue
                transcript_path = (
                    conv_dir / ".system_generated" / "logs" / "transcript.jsonl"
                )
                if not transcript_path.is_file():
                    continue
            except OSError as exc:
                report.warnings.append(f"无法检查对话目录 {conv_dir.name}: {exc}")
                continue

            report.scanned_files += 1
            record, warnings = parse_antigravity_dir(conv_dir, tz=self._tz)
            report.warnings.extend(warnings)
            if record is not None:
                records.append(record)
                report.parsed_conversations += 1
            else:
                report.skipped_files += 1

        return records, report
