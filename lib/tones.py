"""Tone helpers for sloppak playback.

A feedBack arrangement may carry a tone block — the initial tone name plus
in-song tone switches — embedded inline in the arrangement JSON (see
``lib/song.py`` ``arrangement_to_wire`` / the ``tones`` wire key). This module
turns that already-embedded block into the (base, changes) payload the highway
WebSocket sends to the client.

The proprietary-archive tone-extraction path (lifting tone definitions out of
an unpacked encrypted archive) has been removed. FeedBack reads tones only
from its own ``.sloppak`` / arrangement JSON; it never reads or decrypts
proprietary archive formats.
"""

from __future__ import annotations

import logging
import math
import re

log = logging.getLogger("feedBack.lib.tones")


def tokens(s: str) -> set[str]:
    """Split a name or file stem into lowercased alphanumeric tokens.

    Used for fuzzy arrangement↔XML matching: arrangement names carry spaces
    ("Bonus Lead") while file stems are underscored ("song_bonus_lead"), and a
    plain substring check is ambiguous ("lead" is a substring of "bonuslead").
    Shared with the playback path in `server.py` so the two stay consistent.
    """
    return {t for t in re.split(r"[^a-z0-9]+", (s or "").lower()) if t}


def sloppak_tone_changes(arr_tones) -> tuple[str, str, list[dict]]:
    """Build the highway tone-change payload from an arrangement's tone block.

    Given ``Arrangement.tones`` (the dict embedded in the sloppak, or ``None``),
    returns ``(base, base_rig, changes)`` where ``base`` is the initial tone
    name, ``base_rig`` is the ``rigs.json`` rig id bound to it (feedpak-spec
    §6.9; ``""`` when absent), and ``changes`` is a time-sorted
    ``[{"t", "name", "rig"?}]`` list. Non-string names, non-dict entries, and
    non-numeric / non-finite times are skipped — a hand-edited or third-party
    sloppak must not crash the highway WebSocket or emit NaN/inf (which the
    client's ``JSON.parse`` rejects).

    ``rig`` / ``base_rig`` are carried through but NOT resolved against
    ``rigs.json`` here: this builder only preserves the binding the chart
    declared. Realization selection and the ``intent.gm`` fallback (§7.9) belong
    to the consumer that actually voices the part.
    """
    if not isinstance(arr_tones, dict):
        return "", "", []
    base_val = arr_tones.get("base", "")
    base = base_val.strip() if isinstance(base_val, str) else ""
    base_rig_val = arr_tones.get("base_rig", "")
    base_rig = base_rig_val.strip() if isinstance(base_rig_val, str) else ""

    changes: list[dict] = []
    raw_changes = arr_tones.get("changes")
    if not isinstance(raw_changes, list):
        # A truthy non-list (e.g. `1`) would raise TypeError on iteration.
        raw_changes = []
    for c in raw_changes:
        if not isinstance(c, dict):
            continue
        t = c.get("t")
        name = c.get("name")
        if t is None or not isinstance(name, str) or not name:
            continue
        try:
            t = float(t)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(t):
            continue
        change = {"t": round(t, 3), "name": name}
        # ponytail: `rig` only when it's a usable id — a non-string or blank
        # value is dropped rather than forwarded, so a consumer can treat
        # presence of the key as "this change binds a rig".
        rig = c.get("rig")
        if isinstance(rig, str) and rig.strip():
            change["rig"] = rig.strip()
        changes.append(change)
    changes.sort(key=lambda x: x["t"])
    return base, base_rig, changes
