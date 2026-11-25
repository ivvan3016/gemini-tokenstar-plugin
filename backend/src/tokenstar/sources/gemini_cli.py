"""Gemini CLI log source adapter stub reserved for future extension."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from tokenstar.config import DEFAULT_GEMINI_CLI_DIR
from tokenstar.models import SourceScanReport
from tokenstar.sources.base import RawSessionRecord


class GeminiCliAdapter:
    """Placeholder LogSourceAdapter for Gemini CLI (~/.gemini/tmp/) logs."""

    source_name: Literal["antigravity", "gemini_cli"] = "gemini_cli"

    def scan(
        self, root_dir: Path | None = None
    ) -> tuple[list[RawSessionRecord], SourceScanReport]:
        target_dir = root_dir if root_dir is not None else DEFAULT_GEMINI_CLI_DIR
        try:
            exists = target_dir.exists() and target_dir.is_dir()
        except OSError:
            exists = False

        return [], SourceScanReport(
            source=self.source_name,
            directory=str(target_dir),
            exists=exists,
        )
