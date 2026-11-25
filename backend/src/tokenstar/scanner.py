"""Dependency-cached scanner and transitive subagent rollup engine."""

from __future__ import annotations

import time
from collections import deque
from datetime import datetime, timezone, tzinfo
from pathlib import Path

from tokenstar.cache import DependencyRollupCache
from tokenstar.classifier import classify_celestial, classify_request_celestial
from tokenstar.config import resolve_brain_dir
from tokenstar.models import (
    ConversationStar,
    ModelBreakdownItem,
    RequestStar,
    SkyDataResponse,
    SourceScanReport,
    SubagentSummary,
)
from tokenstar.sources.antigravity import parse_antigravity_dir
from tokenstar.sources.base import RawSessionRecord, SubagentLink
from tokenstar.sources.gemini_cli import GeminiCliAdapter


def _merge_model_buckets(
    records: list[RawSessionRecord],
) -> list[ModelBreakdownItem]:
    """Merge per-model token buckets across root and linked subagents."""
    merged: dict[str, ModelBreakdownItem] = {}
    for rec in records:
        for model_name, item in rec.models.items():
            existing = merged.get(model_name)
            if existing is None:
                merged[model_name] = ModelBreakdownItem(
                    model=model_name,
                    input_tokens=item.input_tokens,
                    cache_read_tokens=item.cache_read_tokens,
                    output_tokens=item.output_tokens,
                    total_tokens=item.total_tokens,
                    steps=item.steps,
                )
            else:
                existing.input_tokens += item.input_tokens
                existing.cache_read_tokens += item.cache_read_tokens
                existing.output_tokens += item.output_tokens
                existing.total_tokens += item.total_tokens
                existing.steps += item.steps

    return sorted(
        merged.values(),
        key=lambda m: (-m.total_tokens, -m.steps, m.model),
    )


def _build_conversation_star(
    root: RawSessionRecord,
    children: list[tuple[RawSessionRecord, SubagentLink]],
    is_orphan: bool,
) -> ConversationStar:
    """Aggregate root and linked child records into a ConversationStar."""
    all_records = [root, *(child for child, _ in children)]
    merged_models = _merge_model_buckets(all_records)
    primary_model = (
        max(merged_models, key=lambda m: (m.total_tokens, m.steps, m.model)).model
        if merged_models
        else "unknown"
    )

    input_tokens = sum(r.input_tokens for r in all_records)
    cache_read_tokens = sum(r.cache_read_tokens for r in all_records)
    output_tokens = sum(r.output_tokens for r in all_records)
    total_tokens = input_tokens + cache_read_tokens + output_tokens
    non_cache_tokens = input_tokens + output_tokens

    ended_at_dt = max(r.ended_at for r in all_records)
    model_steps_count = sum(r.model_steps_count for r in all_records)
    tool_calls_count = sum(r.tool_calls_count for r in all_records)
    error_steps_count = sum(r.error_steps_count for r in all_records)
    subagent_calls_count = max(root.subagent_calls_count, len(children))

    subagents = [
        SubagentSummary(
            id=child.id,
            role=link.role,
            type_name=link.type_name,
            primary_model=child.primary_model,
            input_tokens=child.input_tokens,
            cache_read_tokens=child.cache_read_tokens,
            output_tokens=child.output_tokens,
            total_tokens=child.total_tokens,
            non_cache_tokens=child.non_cache_tokens,
            last_status=child.last_status,
        )
        for child, link in children
    ]

    title = f"子代理任务 {root.id[:8]}" if is_orphan else root.title
    last_status = root.last_status

    celestial_type, celestial_reason = classify_celestial(
        last_status=last_status,
        model_steps_count=model_steps_count,
        error_steps_count=error_steps_count,
        subagent_calls_count=subagent_calls_count,
        tool_calls_count=tool_calls_count,
        user_turns=root.user_turns,
        total_tokens=total_tokens,
    )

    request_items: list[tuple[datetime, int, int, RequestStar]] = []

    def append_requests(rec: RawSessionRecord, is_sub: bool, sub_role: str) -> None:
        for req in rec.requests:
            req_dt = req.created_at or rec.started_at
            req_local_date = req.local_date or rec.local_date
            req_ctype, req_reason = classify_request_celestial(
                status=req.status,
                subagent_calls_count=req.subagent_calls_count,
                tool_calls_count=req.tool_calls_count,
                total_tokens=req.total_tokens,
                is_subagent=is_sub,
            )
            request_items.append(
                (
                    req_dt,
                    1 if is_sub else 0,
                    req.step_index,
                    RequestStar(
                        id=req.id,
                        conversation_id=root.id,
                        session_id=req.session_id,
                        step_index=req.step_index,
                        turn_index=req.turn_index,
                        created_at=req_dt.isoformat(),
                        local_date=req_local_date,
                        model=req.model,
                        input_tokens=req.input_tokens,
                        cache_read_tokens=req.cache_read_tokens,
                        output_tokens=req.output_tokens,
                        total_tokens=req.total_tokens,
                        non_cache_tokens=req.non_cache_tokens,
                        tool_calls_count=req.tool_calls_count,
                        subagent_calls_count=req.subagent_calls_count,
                        status=req.status,
                        is_subagent=is_sub,
                        subagent_role=sub_role,
                        celestial_type=req_ctype,
                        celestial_reason=req_reason,
                    ),
                )
            )

    append_requests(root, False, "")
    for child, link in children:
        append_requests(child, True, link.role or link.type_name)

    request_items.sort(key=lambda item: (item[0], item[1], item[2], item[3].id))
    requests = [item[3] for item in request_items]
    if not requests:
        requests = [
            RequestStar(
                id=f"{root.id}:0",
                conversation_id=root.id,
                session_id=root.id,
                step_index=0,
                turn_index=root.user_turns,
                created_at=root.started_at.isoformat(),
                local_date=root.local_date,
                model=primary_model,
                input_tokens=input_tokens,
                cache_read_tokens=cache_read_tokens,
                output_tokens=output_tokens,
                total_tokens=total_tokens,
                non_cache_tokens=non_cache_tokens,
                tool_calls_count=tool_calls_count,
                subagent_calls_count=subagent_calls_count,
                status=last_status,
                is_subagent=False,
                subagent_role="",
                celestial_type=celestial_type,
                celestial_reason=celestial_reason,
            )
        ]

    return ConversationStar(
        id=root.id,
        source=root.source,
        title=title,
        started_at=root.started_at.isoformat(),
        ended_at=ended_at_dt.isoformat(),
        local_date=root.local_date,
        primary_model=primary_model,
        models=merged_models,
        input_tokens=input_tokens,
        cache_read_tokens=cache_read_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        non_cache_tokens=non_cache_tokens,
        user_turns=root.user_turns,
        model_steps_count=model_steps_count,
        tool_calls_count=tool_calls_count,
        subagent_calls_count=subagent_calls_count,
        subagents=subagents,
        requests=requests,
        is_orphan_subagent=is_orphan,
        error_steps_count=error_steps_count,
        last_status=last_status,
        celestial_type=celestial_type,
        celestial_reason=celestial_reason,
    )


def _collect_children_bfs(
    root_id: str,
    records_by_id: dict[str, RawSessionRecord],
    claimed_ids: set[str],
) -> list[tuple[RawSessionRecord, SubagentLink]]:
    """Collect transitive subagent children in BFS order with cycle protection."""
    children: list[tuple[RawSessionRecord, SubagentLink]] = []
    queue: deque[str] = deque([root_id])

    while queue:
        current_id = queue.popleft()
        current_record = records_by_id.get(current_id)
        if current_record is None:
            continue
        for link in current_record.subagent_links:
            child_id = link.child_id
            if child_id not in records_by_id or child_id in claimed_ids:
                continue
            claimed_ids.add(child_id)
            children.append((records_by_id[child_id], link))
            queue.append(child_id)

    return children


def _resolve_root_groups(
    records_by_id: dict[str, RawSessionRecord],
) -> list[tuple[RawSessionRecord, list[tuple[RawSessionRecord, SubagentLink]], bool]]:
    """Group raw records into root conversations (or orphans) deterministically."""
    if not records_by_id:
        return []

    parents_of: dict[str, set[str]] = {cid: set() for cid in records_by_id}
    for parent_id, rec in records_by_id.items():
        for link in rec.subagent_links:
            if link.child_id in records_by_id and link.child_id != parent_id:
                parents_of[link.child_id].add(parent_id)

    ordered_ids = sorted(
        records_by_id.keys(),
        key=lambda cid: (records_by_id[cid].started_at, cid),
    )

    claimed_ids: set[str] = set()
    groups: list[
        tuple[RawSessionRecord, list[tuple[RawSessionRecord, SubagentLink]], bool]
    ] = []

    def claim_group(root_id: str) -> None:
        claimed_ids.add(root_id)
        root_rec = records_by_id[root_id]
        children = _collect_children_bfs(root_id, records_by_id, claimed_ids)
        is_orphan = root_rec.user_turns == 0
        groups.append((root_rec, children, is_orphan))

    # Phase 1: True roots with no incoming parent links
    for cid in ordered_ids:
        if cid not in claimed_ids and not parents_of[cid]:
            claim_group(cid)

    # Phase 2: User-initiated roots caught inside parent->child cycles
    for cid in ordered_ids:
        if cid not in claimed_ids and records_by_id[cid].user_turns > 0:
            claim_group(cid)

    # Phase 3: Remaining pure-cycle nodes with user_turns == 0
    for cid in ordered_ids:
        if cid not in claimed_ids:
            claim_group(cid)

    groups.sort(key=lambda item: (item[0].started_at, item[0].id))
    return groups


class TokenStarScanner:
    """Dependency-cached scanner producing SkyDataResponse."""

    def __init__(
        self,
        brain_dir: Path | None = None,
        tz: tzinfo | None = None,
        gemini_cli_dir: Path | None = None,
    ) -> None:
        self._brain_dir = brain_dir
        self._tz = tz
        self._gemini_cli_dir = gemini_cli_dir
        self._cache = DependencyRollupCache()
        self._gemini_cli_adapter = GeminiCliAdapter()

    def _scan_antigravity(
        self, force: bool
    ) -> tuple[dict[str, RawSessionRecord], SourceScanReport]:
        target_dir = resolve_brain_dir(self._brain_dir)
        try:
            exists = target_dir.exists() and target_dir.is_dir()
        except OSError as exc:
            self._cache.prune_missing(set())
            return {}, SourceScanReport(
                source="antigravity",
                directory=str(target_dir),
                exists=False,
                warnings=[f"无法访问日志根目录 {target_dir}: {exc}"],
            )

        if not exists:
            self._cache.prune_missing(set())
            return {}, SourceScanReport(
                source="antigravity",
                directory=str(target_dir),
                exists=False,
            )

        report = SourceScanReport(
            source="antigravity",
            directory=str(target_dir),
            exists=True,
        )

        try:
            entries = sorted(target_dir.iterdir(), key=lambda p: p.name)
        except OSError as exc:
            report.warnings.append(f"无法遍历目录 {target_dir}: {exc}")
            self._cache.prune_missing(set())
            return {}, report

        records_by_id: dict[str, RawSessionRecord] = {}
        active_ids: set[str] = set()

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

            dir_id = conv_dir.name
            active_ids.add(dir_id)
            report.scanned_files += 1

            record, warnings = self._cache.get_or_parse(
                dir_id,
                conv_dir,
                lambda p: parse_antigravity_dir(p, tz=self._tz),
                force=force,
            )
            report.warnings.extend(warnings)
            if record is not None:
                records_by_id[dir_id] = record
                report.parsed_conversations += 1
            else:
                report.skipped_files += 1

        self._cache.prune_missing(active_ids)
        return records_by_id, report

    def scan(self, force: bool = False) -> SkyDataResponse:
        """Scan log sources incrementally (or forced) and return SkyDataResponse."""
        start_perf = time.perf_counter()

        records_by_id, antigravity_report = self._scan_antigravity(force=force)
        _, gemini_cli_report = self._gemini_cli_adapter.scan(self._gemini_cli_dir)

        groups = _resolve_root_groups(records_by_id)
        conversations: list[ConversationStar] = []

        for root_rec, children, is_orphan in groups:
            dep_ids = {root_rec.id, *(child.id for child, _ in children)}
            dep_sig = (
                is_orphan,
                (root_rec.id, self._cache.get_raw_version(root_rec.id)),
                tuple(
                    (
                        child.id,
                        self._cache.get_raw_version(child.id),
                        link.role,
                        link.type_name,
                    )
                    for child, link in children
                ),
            )

            star = (
                None
                if force
                else self._cache.get_cached_star(root_rec.id, dep_sig)
            )
            if star is None:
                star = _build_conversation_star(root_rec, children, is_orphan)
                self._cache.set_cached_star(root_rec.id, dep_sig, star, dep_ids)

            conversations.append(star)

        self._cache.prune_stale_stars({root_rec.id for root_rec, _, _ in groups})
        elapsed_ms = round((time.perf_counter() - start_perf) * 1000.0, 2)
        return SkyDataResponse(
            schema_version="1.0",
            generated_at=datetime.now(timezone.utc).isoformat(),
            scan_duration_ms=elapsed_ms,
            sources=[antigravity_report, gemini_cli_report],
            conversations=conversations,
        )
