"""Path-containment helper for code that joins attacker-controlled names
under a server-owned root.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=16)
def resolved_root(root: Path) -> Path:
    """Canonical (link-resolved) form of a server-owned root directory.

    ``Path.resolve()`` is a filesystem call: it lstats every component of the
    path. The roots we join against — the DLC library, a plugin's asset dir —
    are fixed for the life of the process, but the containment helpers below
    (and ``dlc_paths._resolve_dlc_path``) were re-resolving them on EVERY call,
    and those are called once per song, per art fetch, per scanned row.

    On a real 50,944-song library that cost ~23,500 stat/lstat calls per second,
    pinning a core. It is brutal when the library lives on a FUSE mount
    (NTFS-3G, SMB, sshfs), where every stat is a userspace round trip: the same
    three parent directories were being walked over and over.

    Cached because a root is a constant here, not because resolution is cheap.
    Consequence: if a root's symlink/junction is re-pointed at a NEW target
    while the server is running, the old target stays in effect until restart.
    That is fine for a library path fixed at startup, and the cache is keyed on
    the Path, so switching to a different library dir is a different key.
    """
    return root.resolve()


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
        # The ROOT is a constant — resolve it once (see resolved_root). The
        # CANDIDATE must still be resolved on every call: following its symlinks
        # is exactly the zip-slip / traversal defence, so it is never cached.
        root_res = resolved_root(root)
        candidate = (root_res / safe).resolve()
        if not candidate.is_relative_to(root_res):
            return None
    except (ValueError, OSError):
        return None
    return candidate
