"""Two-layer dependency-aware incremental cache for TokenStar scanning."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from tokenstar.models import ConversationStar
from tokenstar.sources.base import RawSessionRecord

MetaSignature = tuple[tuple[str, int, int], ...]
DirSignature = tuple[int, int, MetaSignature]
RawParserFn = Callable[[Path], tuple[RawSessionRecord | None, list[str]]]


def compute_dir_signature(conv_dir: Path) -> DirSignature | None:
    """Compute a read-only stat signature for a conversation directory."""
    transcript_path = conv_dir / ".system_generated" / "logs" / "transcript.jsonl"
    try:
        transcript_stat = transcript_path.stat()
    except OSError:
        return None

    meta_entries: list[tuple[str, int, int]] = []
    for folder_name in ("subagents", "messages"):
        meta_dir = conv_dir / ".system_generated" / folder_name
        try:
            if not meta_dir.is_dir():
                continue
            for meta_file in sorted(meta_dir.glob("*.json"), key=lambda p: p.name):
                try:
                    st = meta_file.stat()
                except OSError:
                    continue
                meta_entries.append(
                    (f"{folder_name}/{meta_file.name}", st.st_mtime_ns, st.st_size)
                )
        except OSError:
            continue

    return (
        transcript_stat.st_mtime_ns,
        transcript_stat.st_size,
        tuple(meta_entries),
    )


@dataclass(slots=True)
class RawCacheEntry:
    """Layer 1 cache entry holding raw parsed record and file signatures."""

    transcript_mtime_ns: int
    transcript_size: int
    subagent_meta_sig: MetaSignature
    record: RawSessionRecord | None
    warnings: list[str] = field(default_factory=list)
    version: int = 1


@dataclass(slots=True)
class StarCacheEntry:
    """Layer 2 cache entry holding a rolled-up ConversationStar and its dep signature."""

    dep_signature: tuple[Any, ...]
    star: ConversationStar


class DependencyRollupCache:
    """Two-layer dependency-aware cache for raw transcripts and rolled-up stars."""

    def __init__(self) -> None:
        self._raw_cache: dict[str, RawCacheEntry] = {}
        self._star_cache: dict[str, StarCacheEntry] = {}
        self._dependencies: dict[str, set[str]] = {}
        self._dependents: dict[str, set[str]] = {}
        self._next_version: int = 1

    def _allocate_version(self) -> int:
        version = self._next_version
        self._next_version += 1
        return version

    def get_or_parse(
        self,
        dir_id: str,
        conv_dir: Path,
        parser: RawParserFn,
        force: bool = False,
    ) -> tuple[RawSessionRecord | None, list[str]]:
        """Return cached raw parse result if signatures match, else re-parse."""
        sig = compute_dir_signature(conv_dir)
        cached = self._raw_cache.get(dir_id)

        if (
            not force
            and sig is not None
            and cached is not None
            and cached.transcript_mtime_ns == sig[0]
            and cached.transcript_size == sig[1]
            and cached.subagent_meta_sig == sig[2]
        ):
            return cached.record, list(cached.warnings)

        record, warnings = parser(conv_dir)
        version = self._allocate_version()

        if sig is not None:
            self._raw_cache[dir_id] = RawCacheEntry(
                transcript_mtime_ns=sig[0],
                transcript_size=sig[1],
                subagent_meta_sig=sig[2],
                record=record,
                warnings=list(warnings),
                version=version,
            )
        else:
            self._raw_cache.pop(dir_id, None)
            self._invalidate_dependents(dir_id)

        return record, list(warnings)

    def get_raw_version(self, dir_id: str) -> int:
        """Return the current raw parse revision for `dir_id` (0 if uncached)."""
        entry = self._raw_cache.get(dir_id)
        return entry.version if entry is not None else 0

    def register_dependencies(self, root_id: str, dependency_ids: set[str]) -> None:
        """Record the transitive set of directory IDs that `root_id` depends on."""
        old_deps = self._dependencies.get(root_id, set())
        for dep_id in old_deps - dependency_ids:
            dependents = self._dependents.get(dep_id)
            if dependents is not None:
                dependents.discard(root_id)
                if not dependents:
                    self._dependents.pop(dep_id, None)

        new_deps = set(dependency_ids)
        self._dependencies[root_id] = new_deps
        for dep_id in new_deps:
            self._dependents.setdefault(dep_id, set()).add(root_id)

    def get_dependents(self, dir_id: str) -> set[str]:
        """Return root IDs whose rolled-up ConversationStar depends on `dir_id`."""
        return set(self._dependents.get(dir_id, set()))

    def _remove_star_entry(self, root_id: str) -> None:
        self._star_cache.pop(root_id, None)
        deps = self._dependencies.pop(root_id, set())
        for dep_id in deps:
            dependents = self._dependents.get(dep_id)
            if dependents is not None:
                dependents.discard(root_id)
                if not dependents:
                    self._dependents.pop(dep_id, None)

    def _invalidate_dependents(self, dir_id: str) -> None:
        affected_roots = self.get_dependents(dir_id)
        affected_roots.add(dir_id)
        for root_id in affected_roots:
            self._remove_star_entry(root_id)

    def get_cached_star(
        self, root_id: str, dep_signature: tuple[Any, ...]
    ) -> ConversationStar | None:
        """Return cached ConversationStar if `dep_signature` matches exactly."""
        entry = self._star_cache.get(root_id)
        if entry is not None and entry.dep_signature == dep_signature:
            return entry.star
        return None

    def set_cached_star(
        self,
        root_id: str,
        dep_signature: tuple[Any, ...],
        star: ConversationStar,
        dependency_ids: set[str],
    ) -> None:
        """Store rolled-up ConversationStar and update reverse dependency links."""
        self.register_dependencies(root_id, dependency_ids)
        self._star_cache[root_id] = StarCacheEntry(
            dep_signature=dep_signature,
            star=star,
        )

    def prune_missing(self, active_ids: set[str]) -> set[str]:
        """Remove deleted directories and invalidate affected rolled-up stars."""
        stale_ids = set(self._raw_cache.keys()) - active_ids
        for stale_id in stale_ids:
            self._raw_cache.pop(stale_id, None)
            self._invalidate_dependents(stale_id)

        stale_star_ids = set(self._star_cache.keys()) - active_ids
        for star_id in stale_star_ids:
            self._invalidate_dependents(star_id)

        return stale_ids

    def prune_stale_stars(self, active_root_ids: set[str]) -> None:
        """Remove cached stars that are no longer root conversations."""
        for star_id in set(self._star_cache.keys()) - active_root_ids:
            self._remove_star_entry(star_id)

    def clear(self) -> None:
        """Clear both Layer 1 and Layer 2 caches."""
        self._raw_cache.clear()
        self._star_cache.clear()
        self._dependencies.clear()
        self._dependents.clear()
