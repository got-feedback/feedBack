"""Backward-compatible environment lookup for the slopsmith -> feedBack rename.

Canonical configuration variables are now ``FEEDBACK_*``. Deployments that
predate the rename may still set the old ``SLOPSMITH_*`` names (docker-compose
overrides, shell profiles, CI), so we honour those as a fallback. New code
should always read the canonical ``FEEDBACK_*`` name and let this shim resolve
the legacy alias.

Flat-importable, no import-time IO or global state (constitution P-V).
"""

import os

_CANON_PREFIX = "FEEDBACK_"
_LEGACY_PREFIX = "SLOPSMITH_"
_TRUE_VALUES = {"1", "true", "yes", "on"}


def getenv_compat(name, default=None):
    """``os.environ.get`` with a legacy ``SLOPSMITH_*`` fallback.

    For a canonical ``FEEDBACK_<X>`` name, returns the value of ``FEEDBACK_<X>``
    if set, else ``SLOPSMITH_<X>`` if set, else ``default``. Names that do not
    start with ``FEEDBACK_`` behave exactly like ``os.environ.get``.
    """
    value = os.environ.get(name)
    if value is not None:
        return value
    if name.startswith(_CANON_PREFIX):
        legacy = os.environ.get(_LEGACY_PREFIX + name[len(_CANON_PREFIX):])
        if legacy is not None:
            return legacy
    return default


def env_flag_compat(name):
    """Parse a conventional boolean env flag, honouring the legacy alias."""
    return (getenv_compat(name, "") or "").strip().lower() in _TRUE_VALUES
