"""Shared pytest fixtures for TokenStar parser and backend tests."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest


class BrainFixtureBuilder:
    """Helper to construct fake Antigravity brain directories in pytest tmp_path."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def add_conversation(
        self,
        conv_id: str,
        lines: list[dict[str, Any]],
        *,
        subagents: list[dict[str, Any]] | None = None,
        messages: list[dict[str, Any]] | None = None,
        include_transcript_full: bool = False,
    ) -> Path:
        conv_dir = self.root / conv_id
        logs_dir = conv_dir / ".system_generated" / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)

        transcript_path = logs_dir / "transcript.jsonl"
        content = "\n".join(json.dumps(item, ensure_ascii=False) for item in lines) + "\n"
        transcript_path.write_text(content, encoding="utf-8")

        if include_transcript_full:
            full_path = logs_dir / "transcript_full.jsonl"
            full_path.write_text(
                json.dumps(
                    {
                        "type": "PLANNER_RESPONSE",
                        "model": "should-be-ignored",
                        "input_tokens": 9999999,
                        "output_tokens": 9999999,
                    }
                )
                + "\n",
                encoding="utf-8",
            )

        if subagents:
            subagents_dir = conv_dir / ".system_generated" / "subagents"
            subagents_dir.mkdir(parents=True, exist_ok=True)
            for idx, sub in enumerate(subagents):
                sub_file = subagents_dir / f"subagent_{idx}.json"
                sub_file.write_text(json.dumps(sub, ensure_ascii=False), encoding="utf-8")

        if messages:
            messages_dir = conv_dir / ".system_generated" / "messages"
            messages_dir.mkdir(parents=True, exist_ok=True)
            for idx, msg in enumerate(messages):
                msg_file = messages_dir / f"message_{idx}.json"
                msg_file.write_text(json.dumps(msg, ensure_ascii=False), encoding="utf-8")

        return conv_dir

    def add_raw_transcript(self, conv_id: str, raw_text: str) -> Path:
        conv_dir = self.root / conv_id
        logs_dir = conv_dir / ".system_generated" / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        (logs_dir / "transcript.jsonl").write_text(raw_text, encoding="utf-8")
        return conv_dir

    def add_empty_dir(self, conv_id: str) -> Path:
        conv_dir = self.root / conv_id
        conv_dir.mkdir(parents=True, exist_ok=True)
        return conv_dir

    def append_line(self, conv_id: str, line: dict[str, Any]) -> Path:
        transcript_path = (
            self.root / conv_id / ".system_generated" / "logs" / "transcript.jsonl"
        )
        with transcript_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(line, ensure_ascii=False) + "\n")
        return transcript_path


@pytest.fixture
def tmp_brain(tmp_path: Path) -> BrainFixtureBuilder:
    """Provide an isolated temporary Antigravity brain root directory."""
    brain_root = tmp_path / "brain"
    brain_root.mkdir(parents=True, exist_ok=True)
    return BrainFixtureBuilder(brain_root)
