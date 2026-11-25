"""Tests for celestial classification, dependency cache, and subagent rollup."""

from __future__ import annotations

import json
from unittest.mock import patch

from tokenstar.classifier import classify_celestial
from tokenstar.scanner import TokenStarScanner
from tokenstar.sources.antigravity import parse_antigravity_dir


def test_celestial_priority_and_thresholds():
    ctype, reason = classify_celestial("FAILED", 4, 0, 2, 20, 3, 100_000)
    assert ctype == "black_hole" and "FAILED" in reason
    ctype2, _ = classify_celestial("DONE", 10, 3, 0, 0, 1, 10_000)
    assert ctype2 == "black_hole"
    ctype3, _ = classify_celestial("DONE", 5, 0, 1, 30, 3, 80_000)
    assert ctype3 == "binary"
    ctype4_below, _ = classify_celestial("DONE", 5, 0, 0, 39, 3, 80_000)
    assert ctype4_below == "star"
    ctype4, _ = classify_celestial("DONE", 5, 0, 0, 40, 3, 80_000)
    assert ctype4 == "pulsar"
    ctype5, _ = classify_celestial("DONE", 2, 0, 0, 2, 2, 49_999)
    assert ctype5 == "comet"
    ctype6, _ = classify_celestial("DONE", 2, 0, 0, 2, 2, 50_000)
    assert ctype6 == "star"


def test_transitive_cyclic_and_orphan_subagents(tmp_brain):
    tmp_brain.add_conversation(
        conv_id="root-1111",
        lines=[
            {
                "type": "USER_INPUT",
                "status": "DONE",
                "created_at": "2026-11-25T10:00:00Z",
                "content": "主任务",
            },
            {
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:01:00Z",
                "model": "gemini-pro",
                "input_tokens": 1000,
                "cache_read_tokens": 500,
                "output_tokens": 200,
                "tool_calls": [{"name": "invoke_subagent"}],
            },
        ],
        subagents=[
            {
                "conversationId": "sub-1111",
                "subagentDescriptor": {"typeName": "research", "role": "Level1"},
            }
        ],
    )
    tmp_brain.add_conversation(
        conv_id="sub-1111",
        lines=[
            {
                "type": "PLANNER_RESPONSE",
                "status": "FAILED",
                "created_at": "2026-11-25T10:02:00Z",
                "model": "gemini-flash",
                "input_tokens": 300,
                "cache_read_tokens": 0,
                "output_tokens": 100,
                "tool_calls": [{"name": "invoke_subagent"}],
            }
        ],
        subagents=[
            {
                "conversationId": "sub-2222",
                "subagentDescriptor": {"typeName": "code", "role": "Level2"},
            }
        ],
    )
    tmp_brain.add_conversation(
        conv_id="sub-2222",
        lines=[
            {
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:02:30Z",
                "model": "gemini-flash",
                "input_tokens": 200,
                "cache_read_tokens": 50,
                "output_tokens": 25,
            },
            {
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:03:00Z",
                "model": "gemini-flash",
                "input_tokens": 200,
                "cache_read_tokens": 50,
                "output_tokens": 25,
            },
        ],
    )
    tmp_brain.add_conversation(
        conv_id="orphan-9999aaaa",
        lines=[
            {
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T11:00:00Z",
                "model": "gemini-flash",
                "input_tokens": 200,
                "output_tokens": 50,
            }
        ],
        subagents=[
            {
                "conversationId": "orphan-9999aaaa",
                "subagentDescriptor": {"typeName": "self", "role": "Cycle"},
            }
        ],
    )
    sky = TokenStarScanner(brain_dir=tmp_brain.root).scan()
    assert len(sky.conversations) == 2
    root = next(c for c in sky.conversations if c.id == "root-1111")
    assert root.total_tokens == 1700 + 400 + 550
    assert root.non_cache_tokens == (1000 + 200) + (300 + 100) + (400 + 50)
    assert root.last_status == "DONE"
    assert root.error_steps_count == 1 and root.model_steps_count == 4
    assert root.celestial_type == "binary"
    assert len(root.subagents) == 2
    assert len(root.requests) == 4
    assert [r.id for r in root.requests] == [
        "root-1111:2",
        "sub-1111:1",
        "sub-2222:1",
        "sub-2222:2",
    ]
    assert all(r.conversation_id == "root-1111" for r in root.requests)
    assert root.requests[0].is_subagent is False and root.requests[0].celestial_type == "binary"
    assert root.requests[1].is_subagent is True and root.requests[1].subagent_role == "Level1"
    assert root.requests[1].celestial_type == "black_hole"
    assert root.requests[2].is_subagent is True and root.requests[2].subagent_role == "Level2"
    assert root.requests[2].celestial_type == "comet"
    orphan = next(c for c in sky.conversations if c.id == "orphan-9999aaaa")
    assert orphan.is_orphan_subagent is True
    assert orphan.title == "子代理任务 orphan-9"
    assert len(orphan.requests) == 1


def test_request_classification_and_no_model_step_fallback(tmp_brain):
    from tokenstar.classifier import classify_request_celestial

    assert classify_request_celestial("ERROR", 1, 5, 20_000)[0] == "black_hole"
    assert classify_request_celestial("DONE", 1, 5, 20_000)[0] == "binary"
    assert classify_request_celestial("DONE", 0, 7, 20_000)[0] == "star"
    assert classify_request_celestial("DONE", 0, 8, 20_000)[0] == "pulsar"
    assert classify_request_celestial("DONE", 0, 0, 14_999, is_subagent=True) == (
        "comet",
        "子代理轻量步骤",
    )
    assert classify_request_celestial("DONE", 0, 0, 15_000, is_subagent=False) == (
        "star",
        "常规模型请求",
    )

    tmp_brain.add_conversation(
        conv_id="conv-user-only",
        lines=[{"type": "USER_INPUT", "status": "DONE", "created_at": "2026-11-25T12:00:00Z", "content": "未回复"}],
    )
    sky = TokenStarScanner(brain_dir=tmp_brain.root).scan()
    assert len(sky.conversations) == 1
    assert len(sky.conversations[0].requests) == 1
    assert sky.conversations[0].requests[0].id == "conv-user-only:0"


def test_dependency_cache_recomputes_parent_on_child_change(tmp_brain):
    tmp_brain.add_conversation(
        conv_id="root-cache",
        lines=[
            {
                "type": "USER_INPUT",
                "status": "DONE",
                "created_at": "2026-11-25T10:00:00Z",
                "content": "缓存测试",
            }
        ],
        subagents=[
            {
                "conversationId": "child-cache",
                "subagentDescriptor": {"typeName": "research", "role": "Worker"},
            }
        ],
    )
    tmp_brain.add_conversation(
        conv_id="child-cache",
        lines=[
            {
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:01:00Z",
                "model": "gemini-flash",
                "input_tokens": 100,
                "output_tokens": 20,
            }
        ],
    )
    scanner = TokenStarScanner(brain_dir=tmp_brain.root)
    assert scanner.scan().conversations[0].total_tokens == 120
    tmp_brain.append_line(
        "child-cache",
        {
            "type": "PLANNER_RESPONSE",
            "status": "DONE",
            "created_at": "2026-11-25T10:02:00Z",
            "model": "gemini-flash",
            "input_tokens": 80,
            "output_tokens": 10,
        },
    )
    assert scanner.scan().conversations[0].total_tokens == 210


def test_cache_hits_pruning_force_and_subagent_meta_invalidation(tmp_brain):
    tmp_brain.add_conversation(
        conv_id="conv-a",
        lines=[
            {
                "type": "USER_INPUT",
                "status": "DONE",
                "created_at": "2026-11-25T12:00:00Z",
                "content": "A",
            },
            {
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T12:01:00Z",
                "model": "gemini-pro",
                "input_tokens": 100,
                "output_tokens": 50,
            },
        ],
    )
    tmp_brain.add_conversation(
        conv_id="conv-b",
        lines=[
            {
                "type": "USER_INPUT",
                "status": "DONE",
                "created_at": "2026-11-25T09:00:00Z",
                "content": "B",
            },
            {
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T09:01:00Z",
                "model": "gemini-flash",
                "input_tokens": 50,
                "output_tokens": 10,
            },
        ],
    )

    scanner = TokenStarScanner(brain_dir=tmp_brain.root)
    first = scanner.scan()
    # Sorted ascending by started_at
    assert [c.id for c in first.conversations] == ["conv-b", "conv-a"]

    # Second scan with no file changes should not re-parse any directory
    with patch("tokenstar.scanner.parse_antigravity_dir") as mock_parse:
        second = scanner.scan()
        assert mock_parse.call_count == 0
        assert [c.id for c in second.conversations] == ["conv-b", "conv-a"]

    # Adding a subagent metadata file to conv-a invalidates conv-a even if transcript unchanged
    sub_dir = tmp_brain.root / "conv-a" / ".system_generated" / "subagents"
    sub_dir.mkdir(parents=True, exist_ok=True)
    (sub_dir / "subagent_0.json").write_text(
        json.dumps({"conversationId": "conv-b", "subagentDescriptor": {"role": "Helper"}}),
        encoding="utf-8",
    )
    third = scanner.scan()
    assert len(third.conversations) == 1
    assert third.conversations[0].id == "conv-a"
    assert third.conversations[0].total_tokens == 210
    assert scanner._cache.get_dependents("conv-b") == {"conv-a"}

    # Subsequent unchanged scan after root->child adoption hits both Layer 1 and Layer 2 caches
    with (
        patch("tokenstar.scanner.parse_antigravity_dir") as mock_parse,
        patch("tokenstar.scanner._build_conversation_star") as mock_build,
    ):
        cached_adopted = scanner.scan()
        assert mock_parse.call_count == 0
        assert mock_build.call_count == 0
        assert len(cached_adopted.conversations) == 1
        assert cached_adopted.conversations[0].total_tokens == 210

    # Deleting conv-b prunes it from cache and updates conv-a
    for p in sorted((tmp_brain.root / "conv-b").rglob("*"), reverse=True):
        if p.is_file():
            p.unlink()
        elif p.is_dir():
            p.rmdir()
    (tmp_brain.root / "conv-b").rmdir()

    fourth = scanner.scan()
    assert len(fourth.conversations) == 1
    assert fourth.conversations[0].total_tokens == 150
    assert fourth.conversations[0].subagents == []
    assert scanner._cache.get_dependents("conv-b") == set()

    # force=True forces re-parsing and Layer 2 recomputation even when unchanged
    with patch(
        "tokenstar.scanner.parse_antigravity_dir", wraps=parse_antigravity_dir
    ) as mock_parse_force:
        fifth = scanner.scan(force=True)
        assert mock_parse_force.call_count == 1
        assert len(fifth.conversations) == 1
        assert fifth.conversations[0].total_tokens == 150


def test_mutual_cycle_without_user_input_breaks_deterministically(tmp_brain):
    tmp_brain.add_conversation(
        conv_id="cyc-a",
        lines=[
            {
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:00:00Z",
                "model": "gemini-flash",
                "input_tokens": 10,
                "output_tokens": 5,
            }
        ],
        subagents=[{"conversationId": "cyc-b", "subagentDescriptor": {"role": "B"}}],
    )
    tmp_brain.add_conversation(
        conv_id="cyc-b",
        lines=[
            {
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:01:00Z",
                "model": "gemini-flash",
                "input_tokens": 20,
                "output_tokens": 5,
            }
        ],
        subagents=[{"conversationId": "cyc-a", "subagentDescriptor": {"role": "A"}}],
    )

    sky = TokenStarScanner(brain_dir=tmp_brain.root).scan()
    assert len(sky.conversations) >= 1
    assert sum(c.total_tokens for c in sky.conversations) == 40
