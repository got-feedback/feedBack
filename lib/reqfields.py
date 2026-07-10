"""Request-field coercion helpers shared by the raw-`dict` POST handlers.

Extracted verbatim from ``server.py`` (R3). Pure — no IO, no globals — so it
imports cleanly from both ``server`` and any ``routers/`` module.
"""


def _clean_str(value) -> str:
    """Trim a request field to a string; non-strings (or missing) → ''.
    Lets the raw-`dict` POST handlers treat wrong-typed JSON (an int/list/etc.
    where a string was expected) as "empty" and answer 400, instead of raising
    AttributeError/TypeError → 500 on a later .strip()/`in`."""
    return value.strip() if isinstance(value, str) else ""
