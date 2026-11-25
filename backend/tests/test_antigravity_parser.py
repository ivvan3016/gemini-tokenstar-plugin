"""Unit tests for the read-only Antigravity transcript and subagent parser."""

from __future__ import annotations

import json
from datetime import timedelta, timezone
from pathlib import Path

from tokenstar.config import resolve_brain_dir
from tokenstar.models import SkyDataResponse
from tokenstar.sources.antigravity import (
    AntigravityTranscriptAdapter,
    extract_subagent_links,
    parse_antigravity_dir,
    sanitize_title,
)
from tokenstar.sources.base import LogSourceAdapter
from tokenstar.sources.gemini_cli import GeminiCliAdapter


def test_parse_valid_transcript_and_strip_wrapper_tags(tmp_brain):
    conv_dir = tmp_brain.add_conversation(
        conv_id="conv-abc12345",
        lines=[
            {
                "step_index": 0,
                "type": "USER_INPUT",
                "status": "DONE",
                "created_at": "2026-11-25T09:28:55Z",
                "content": (
                    "<USER_REQUEST>\n分析这个项目的架构\n补充细节\n</USER_REQUEST>\n"
                    "<ADDITIONAL_METADATA>\n2026-11-25\n</ADDITIONAL_METADATA>\n"
                    "<USER_SETTINGS_CHANGE>\nModel\n</USER_SETTINGS_CHANGE>"
                ),
            },
            {
                "step_index": 1,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T09:29:10Z",
                "model": "gemini-4-neon-high",
                "input_tokens": 1200,
                "cache_read_tokens": 800,
                "output_tokens": 300,
                "tool_calls": [{"name": "read_file"}, {"name": "invoke_subagent"}],
            },
        ],
        subagents=[
            {
                "conversationId": "sub-111",
                "subagentDescriptor": {"typeName": "research", "role": "Reviewer"},
            }
        ],
        include_transcript_full=True,
    )
    record, warnings = parse_antigravity_dir(conv_dir)
    assert warnings == []
    assert record is not None
    assert record.title == "分析这个项目的架构"
    assert record.input_tokens == 1200
    assert record.cache_read_tokens == 800
    assert record.output_tokens == 300
    assert record.total_tokens == 2300
    assert record.non_cache_tokens == 1500
    assert record.primary_model == "gemini-4-neon-high"
    assert record.user_turns == 1
    assert record.model_steps_count == 1
    assert record.tool_calls_count == 2
    assert record.subagent_calls_count == 1
    assert record.last_status == "DONE"
    assert [link.child_id for link in record.subagent_links] == ["sub-111"]
    assert record.subagent_links[0].role == "Reviewer"
    assert record.subagent_links[0].type_name == "research"
    assert len(record.requests) == 1
    assert record.requests[0].id == "conv-abc12345:1"
    assert record.requests[0].turn_index == 1
    assert record.requests[0].model == "gemini-4-neon-high"
    assert record.requests[0].total_tokens == 2300
    assert record.requests[0].subagent_calls_count == 1


def test_local_date_timezone_conversion(tmp_brain):
    conv_dir = tmp_brain.add_conversation(
        conv_id="conv-tz01",
        lines=[
            {
                "type": "USER_INPUT",
                "status": "DONE",
                "created_at": "2026-12-31T20:00:00Z",
                "content": "跨年测试",
            }
        ],
    )
    record, _ = parse_antigravity_dir(conv_dir, tz=timezone(timedelta(hours=8)))
    assert record is not None
    assert record.local_date == "2027-01-01"


def test_title_truncation_and_fallback():
    long_title = sanitize_title(
        "<USER_REQUEST>\n" + "星" * 80 + "\n</USER_REQUEST>", "abcd1234efgh"
    )
    assert len(long_title) == 60
    assert (
        sanitize_title("<ADDITIONAL_METADATA>\nmeta\n</ADDITIONAL_METADATA>", "abcd1234efgh")
        == "对话 abcd1234"
    )


def test_resilient_parsing_and_permission_errors(tmp_brain, monkeypatch):
    conv_dir = tmp_brain.add_raw_transcript(
        conv_id="conv-dirty01",
        raw_text=(
            '\ufeff{"type":"PLANNER_RESPONSE","model":"gemini-flash","input_tokens":50,"output_tokens":10,"status":"DONE"}\n'
            "{broken json\n"
        ),
    )
    tmp_brain.add_empty_dir("conv-notranscript")
    locked_dir = tmp_brain.add_conversation(
        "conv-locked", lines=[{"type": "USER_INPUT", "content": "hi"}]
    )

    record, warnings = parse_antigravity_dir(conv_dir)
    assert record is not None
    assert record.input_tokens == 50
    assert record.output_tokens == 10
    assert record.local_date
    assert any("JSON" in w or "解析" in w for w in warnings)

    orig_open = Path.open

    def guarded_open(self, *args, **kwargs):
        if "conv-locked" in str(self):
            raise PermissionError("Access is denied")
        return orig_open(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", guarded_open)
    locked_record, locked_warnings = parse_antigravity_dir(locked_dir)
    assert locked_record is None
    assert len(locked_warnings) == 1


def test_messages_fallback_and_adapter_scan(tmp_brain):
    tmp_brain.add_conversation(
        conv_id="conv-msg-fallback",
        lines=[
            {
                "type": "USER_INPUT",
                "status": "DONE",
                "created_at": "2026-11-25T10:00:00Z",
                "content": "主对话测试",
            },
            {
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:01:00Z",
                "model": "gemini-3-pro",
                "input_tokens": 100,
                "output_tokens": 50,
                "tool_calls": [
                    {
                        "name": "invoke_subagent",
                        "output": json.dumps({"conversationId": "sub-from-tool"}),
                    }
                ],
            },
        ],
        messages=[
            {
                "sourceMetadata": {
                    "tool": {
                        "conversationId": "sub-from-msg",
                        "role": "Explorer",
                        "typeName": "explore",
                    }
                }
            }
        ],
    )
    tmp_brain.add_empty_dir("conv-skip-me")

    adapter = AntigravityTranscriptAdapter()
    records, report = adapter.scan(tmp_brain.root)

    assert report.source == "antigravity"
    assert report.exists is True
    assert report.scanned_files == 1
    assert report.parsed_conversations == 1
    assert report.skipped_files == 0
    assert len(records) == 1

    child_ids = [link.child_id for link in records[0].subagent_links]
    assert "sub-from-msg" in child_ids
    assert "sub-from-tool" in child_ids


def test_resolve_brain_dir_and_gemini_cli_stub(tmp_path, monkeypatch):
    custom = tmp_path / "custom_brain"
    monkeypatch.setenv("TOKENSTAR_BRAIN_DIR", str(custom))
    assert resolve_brain_dir() == custom
    override = tmp_path / "override_brain"
    assert resolve_brain_dir(override) == override

    cli_adapter = GeminiCliAdapter()
    records, report = cli_adapter.scan(tmp_path / "nonexistent-cli-dir")
    assert records == []
    assert report.source == "gemini_cli"
    assert report.exists is False
    assert report.parsed_conversations == 0

    assert isinstance(AntigravityTranscriptAdapter(), LogSourceAdapter)
    assert isinstance(cli_adapter, LogSourceAdapter)

    resp = SkyDataResponse(
        generated_at="2026-11-25T10:00:00Z",
        sources=[report],
        conversations=[],
    )
    assert resp.schema_version == "1.0"


def test_model_bucketing_error_steps_and_swarm_subagent(tmp_brain):
    conv_dir = tmp_brain.add_conversation(
        conv_id="conv-multi-model",
        lines=[
            {
                "type": "PLANNER_RESPONSE",
                "status": "failed",
                "model": "gemini-flash",
                "input_tokens": 100,
                "output_tokens": 20,
                "tool_calls": [{"name": "swarm"}],
            },
            {
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "model": "gemini-pro",
                "input_tokens": 500,
                "cache_read_tokens": True,  # non-int bool -> 0
                "output_tokens": 200,
            },
        ],
    )
    record, warnings = parse_antigravity_dir(conv_dir)
    assert warnings == []
    assert record is not None
    assert record.title == "对话 conv-mul"
    assert record.primary_model == "gemini-pro"
    assert record.models["gemini-flash"].steps == 1
    assert record.models["gemini-pro"].total_tokens == 700
    assert record.cache_read_tokens == 0
    assert record.model_steps_count == 2
    assert record.error_steps_count == 1
    assert record.last_status == "DONE"
    assert record.subagent_calls_count == 1

    unknown_dir = tmp_brain.add_conversation(
        conv_id="conv-nomodel",
        lines=[{"type": "USER_INPUT", "content": "hello"}],
    )
    unknown_rec, _ = parse_antigravity_dir(unknown_dir)
    assert unknown_rec is not None
    assert unknown_rec.primary_model == "unknown"
    assert unknown_rec.last_status == "UNKNOWN"
