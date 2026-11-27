"""Tests for celestial classification, dependency cache, and subagent rollup."""

from __future__ import annotations

import json
from unittest.mock import patch

from tokenstar.classifier import classify_celestial
from tokenstar.scanner import TokenStarScanner, _build_conversation_star
from tokenstar.sources.antigravity import parse_antigravity_dir
from tokenstar.sources.base import SubagentLink


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


def test_parallel_subagents_share_exact_parent_request_and_dep_sig(tmp_brain):
    tmp_brain.add_conversation(
        conv_id="root-parallel",
        lines=[
            {
                "step_index": 0,
                "type": "USER_INPUT",
                "status": "DONE",
                "created_at": "2026-11-25T10:00:00Z",
                "content": "并行调度",
            },
            {
                "step_index": 1,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:01:00Z",
                "model": "gemini-pro",
                "input_tokens": 500,
                "output_tokens": 100,
                "tool_calls": [
                    {"name": "invoke_subagent"},
                    {"name": "invoke_subagent"},
                ],
            },
            {
                "step_index": 2,
                "type": "GENERIC",
                "status": "DONE",
                "created_at": "2026-11-25T10:01:02Z",
                "content": "parallel dispatch",
            },
            {
                "step_index": 4,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:05:00Z",
                "model": "gemini-pro",
                "input_tokens": 300,
                "output_tokens": 50,
                "tool_calls": [{"name": "invoke_subagent"}],
            },
        ],
        subagents=[
            {
                "conversationId": "sub-par-a",
                "spawnStepIndex": 2,
                "subagentDescriptor": {"typeName": "explore", "role": "Alpha"},
            },
            {
                "conversationId": "sub-par-b",
                "spawnStepIndex": 2,
                "subagentDescriptor": {"typeName": "code", "role": "Beta"},
            },
        ],
    )
    tmp_brain.add_conversation(
        conv_id="sub-par-a",
        lines=[
            {
                "step_index": 1,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:01:10Z",
                "model": "gemini-flash",
                "input_tokens": 100,
                "output_tokens": 20,
            }
        ],
    )
    # sub-par-b has a timestamp AFTER root's step 4, proving spawnStepIndex overrides timestamp heuristic
    tmp_brain.add_conversation(
        conv_id="sub-par-b",
        lines=[
            {
                "step_index": 1,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:06:00Z",
                "model": "gemini-flash",
                "input_tokens": 120,
                "output_tokens": 30,
            },
            {
                "step_index": 2,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:06:30Z",
                "model": "gemini-flash",
                "input_tokens": 80,
                "output_tokens": 10,
            },
        ],
    )

    scanner = TokenStarScanner(brain_dir=tmp_brain.root)
    sky = scanner.scan()
    assert len(sky.conversations) == 1
    root = sky.conversations[0]
    assert sky.schema_version == "1.0"

    sub_by_id = {s.id: s for s in root.subagents}
    assert sub_by_id["sub-par-a"].parent_session_id == "root-parallel"
    assert sub_by_id["sub-par-a"].parent_request_id == "root-parallel:1"
    assert sub_by_id["sub-par-a"].request_count == 1
    assert sub_by_id["sub-par-a"].started_at == "2026-11-25T10:01:10+00:00"
    assert sub_by_id["sub-par-a"].ended_at == "2026-11-25T10:01:10+00:00"

    assert sub_by_id["sub-par-b"].parent_session_id == "root-parallel"
    assert sub_by_id["sub-par-b"].parent_request_id == "root-parallel:1"
    assert sub_by_id["sub-par-b"].request_count == 2
    assert sub_by_id["sub-par-b"].started_at == "2026-11-25T10:06:00+00:00"
    assert sub_by_id["sub-par-b"].ended_at == "2026-11-25T10:06:30+00:00"

    req_by_id = {r.id: r for r in root.requests}
    assert req_by_id["root-parallel:1"].parent_session_id is None
    assert req_by_id["root-parallel:1"].parent_request_id is None
    assert req_by_id["sub-par-a:1"].parent_session_id == "root-parallel"
    assert req_by_id["sub-par-a:1"].parent_request_id == "root-parallel:1"
    assert req_by_id["sub-par-b:1"].parent_session_id == "root-parallel"
    assert req_by_id["sub-par-b:1"].parent_request_id == "root-parallel:1"
    assert req_by_id["sub-par-b:2"].parent_session_id == "root-parallel"
    assert req_by_id["sub-par-b:2"].parent_request_id == "root-parallel:1"

    # Updating spawnStepIndex in subagent_1.json invalidates cache and updates parent_request_id
    sub1_path = (
        tmp_brain.root / "root-parallel" / ".system_generated" / "subagents" / "subagent_1.json"
    )
    sub1_path.write_text(
        json.dumps(
            {
                "conversationId": "sub-par-b",
                "spawnStepIndex": 10,
                "subagentDescriptor": {"typeName": "code", "role": "Beta"},
            }
        ),
        encoding="utf-8",
    )
    sky_updated = scanner.scan()
    updated_root = sky_updated.conversations[0]
    updated_subs = {s.id: s for s in updated_root.subagents}
    assert updated_subs["sub-par-b"].parent_request_id == "root-parallel:4"
    updated_reqs = {r.id: r for r in updated_root.requests}
    assert updated_reqs["sub-par-b:1"].parent_request_id == "root-parallel:4"


def test_nested_root_child_grandchild_parent_attribution(tmp_brain):
    tmp_brain.add_conversation(
        conv_id="root-nest",
        lines=[
            {
                "step_index": 0,
                "type": "USER_INPUT",
                "status": "DONE",
                "created_at": "2026-11-25T10:00:00Z",
                "content": "嵌套代理测试",
            },
            {
                "step_index": 1,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:01:00Z",
                "model": "gemini-pro",
                "input_tokens": 200,
                "output_tokens": 40,
            },
            {
                "step_index": 3,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:03:00Z",
                "model": "gemini-pro",
                "input_tokens": 300,
                "output_tokens": 60,
                "tool_calls": [{"name": "invoke_subagent"}],
            },
        ],
        subagents=[
            {
                "conversationId": "child-nest",
                "spawnStepIndex": 4,
                "subagentDescriptor": {"typeName": "research", "role": "Manager"},
            }
        ],
    )
    tmp_brain.add_conversation(
        conv_id="child-nest",
        lines=[
            {
                "step_index": 1,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:03:10Z",
                "model": "gemini-flash",
                "input_tokens": 100,
                "output_tokens": 20,
            },
            {
                "step_index": 2,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:03:20Z",
                "model": "gemini-flash",
                "input_tokens": 150,
                "output_tokens": 30,
                "tool_calls": [{"name": "invoke_subagent"}],
            },
            {
                "step_index": 3,
                "type": "GENERIC",
                "status": "DONE",
                "created_at": "2026-11-25T10:03:25Z",
                "content": '{"conversationId": "grand-nest"}',
            },
        ],
        subagents=[
            {
                "conversationId": "grand-nest",
                "subagentDescriptor": {"typeName": "code", "role": "Specialist"},
            }
        ],
    )
    tmp_brain.add_conversation(
        conv_id="grand-nest",
        lines=[
            {
                "step_index": 1,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:03:30Z",
                "model": "gemini-flash",
                "input_tokens": 50,
                "output_tokens": 10,
            },
            {
                "step_index": 2,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:03:40Z",
                "model": "gemini-flash",
                "input_tokens": 60,
                "output_tokens": 15,
            },
            {
                "step_index": 3,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:03:50Z",
                "model": "gemini-flash",
                "input_tokens": 70,
                "output_tokens": 20,
            },
        ],
    )

    sky = TokenStarScanner(brain_dir=tmp_brain.root).scan()
    assert len(sky.conversations) == 1
    root = sky.conversations[0]

    sub_by_id = {s.id: s for s in root.subagents}
    assert sub_by_id["child-nest"].parent_session_id == "root-nest"
    assert sub_by_id["child-nest"].parent_request_id == "root-nest:3"
    assert sub_by_id["child-nest"].request_count == 2
    assert sub_by_id["child-nest"].started_at == "2026-11-25T10:03:10+00:00"
    assert sub_by_id["child-nest"].ended_at == "2026-11-25T10:03:25+00:00"

    assert sub_by_id["grand-nest"].parent_session_id == "child-nest"
    assert sub_by_id["grand-nest"].parent_request_id == "child-nest:2"
    assert sub_by_id["grand-nest"].request_count == 3
    assert sub_by_id["grand-nest"].started_at == "2026-11-25T10:03:30+00:00"
    assert sub_by_id["grand-nest"].ended_at == "2026-11-25T10:03:50+00:00"

    req_by_id = {r.id: r for r in root.requests}
    assert req_by_id["root-nest:1"].parent_session_id is None
    assert req_by_id["root-nest:1"].parent_request_id is None
    assert req_by_id["child-nest:1"].parent_session_id == "root-nest"
    assert req_by_id["child-nest:1"].parent_request_id == "root-nest:3"
    assert req_by_id["child-nest:2"].parent_session_id == "root-nest"
    assert req_by_id["child-nest:2"].parent_request_id == "root-nest:3"
    assert req_by_id["grand-nest:1"].parent_session_id == "child-nest"
    assert req_by_id["grand-nest:1"].parent_request_id == "child-nest:2"
    assert req_by_id["grand-nest:2"].parent_session_id == "child-nest"
    assert req_by_id["grand-nest:2"].parent_request_id == "child-nest:2"
    assert req_by_id["grand-nest:3"].parent_session_id == "child-nest"
    assert req_by_id["grand-nest:3"].parent_request_id == "child-nest:2"


def test_legacy_two_tuple_and_timestamp_fallbacks_in_rollup(tmp_brain):
    root_dir = tmp_brain.add_conversation(
        conv_id="root-fb",
        lines=[
            {
                "step_index": 1,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:05:00Z",
                "model": "gemini-pro",
                "input_tokens": 100,
                "output_tokens": 20,
            }
        ],
    )
    child_dir = tmp_brain.add_conversation(
        conv_id="child-fb",
        lines=[
            {
                "step_index": 1,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:01:00Z",
                "model": "gemini-flash",
                "input_tokens": 40,
                "output_tokens": 10,
            }
        ],
    )
    root_rec, _ = parse_antigravity_dir(root_dir)
    child_rec, _ = parse_antigravity_dir(child_dir)
    assert root_rec is not None and child_rec is not None

    # Child started_at < all parent requests and invalid spawn_request_id falls back to first parent request
    star = _build_conversation_star(
        root_rec,
        [(child_rec, SubagentLink(child_id="child-fb", role="Helper", spawn_request_id="missing:99"))],
        is_orphan=False,
    )
    assert star.subagents[0].parent_session_id == "root-fb"
    assert star.subagents[0].parent_request_id == "root-fb:1"
    assert star.subagents[0].request_count == 1
    child_req = next(r for r in star.requests if r.id == "child-fb:1")
    assert child_req.parent_session_id == "root-fb"
    assert child_req.parent_request_id == "root-fb:1"

    # Timestamp fallback (b): picks latest parent request <= child.started_at when spawn_request_id is None
    root_ts_dir = tmp_brain.add_conversation(
        conv_id="root-ts",
        lines=[
            {
                "step_index": 1,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:00:00Z",
                "model": "gemini-pro",
                "input_tokens": 50,
                "output_tokens": 10,
            },
            {
                "step_index": 2,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:04:00Z",
                "model": "gemini-pro",
                "input_tokens": 60,
                "output_tokens": 10,
            },
            {
                "step_index": 3,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:08:00Z",
                "model": "gemini-pro",
                "input_tokens": 70,
                "output_tokens": 10,
            },
        ],
        subagents=[{"conversationId": "child-ts", "subagentDescriptor": {"role": "TS"}}],
    )
    child_ts_dir = tmp_brain.add_conversation(
        conv_id="child-ts",
        lines=[
            {
                "step_index": 1,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "created_at": "2026-11-25T10:05:00Z",
                "model": "gemini-flash",
                "input_tokens": 20,
                "output_tokens": 5,
            }
        ],
    )
    root_ts_rec, _ = parse_antigravity_dir(root_ts_dir)
    child_ts_rec, _ = parse_antigravity_dir(child_ts_dir)
    assert root_ts_rec is not None and child_ts_rec is not None
    star_ts = _build_conversation_star(
        root_ts_rec,
        [(child_ts_rec, root_ts_rec.subagent_links[0], "root-ts")],
        is_orphan=False,
    )
    assert star_ts.subagents[0].parent_request_id == "root-ts:2"
    assert next(r for r in star_ts.requests if r.id == "child-ts:1").parent_request_id == "root-ts:2"
