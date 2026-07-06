"""Path-containment helper for code that joins attacker-controlled names
under a server-owned root.
"""

from __future__ import annotations

from pathlib import Path


def safe_join(root: Path, name: str) -> Path | None:
    """Resolve ``name`` under ``root`` and return the resolved Path, or
    ``None`` if it would escape ``root`` or is unrepresentable.

    Rejects:
      * empty names
      * paths that resolve outside ``root`` (``..`` traversal, absolute paths)
      * paths the OS can't resolve (embedded NULs, OSError on stat)

    Normalizes:
      * backslash separators to forward slash so a Windows-style entry
        name inside a user-supplied archive can't bypass containment on
        POSIX hosts (``..\\foo`` would otherwise be treated as a literal
        single filename on Linux and resolve inside ``root`` — but on
        Windows the same string IS a traversal; normalising means both
        platforms reject it identically).
    """
    if not name:
        return None
    # Reject embedded NULs explicitly. This used to ride on `.resolve()`
    # raising ValueError, but on Python 3.13 (Windows) resolve() no longer
    # raises for an embedded NUL, so the byte would otherwise leak through
    # containment. An explicit guard is strictly-more-rejection (no effect on
    # the zip-slip / traversal contract).
    if "\x00" in name:
        return None
    safe = name.replace("\\", "/")
    try:
        root_resolved = root.resolve()
        candidate = (root_resolved / safe).resolve()
        if not candidate.is_relative_to(root_resolved):
            return None
    except (ValueError, OSError):
        return None
    return candidate
