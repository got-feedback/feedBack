"""Coverage for the slopsmith -> feedBack env backward-compat shim."""

from env_compat import getenv_compat, env_flag_compat


def test_canonical_wins_over_legacy(monkeypatch):
    monkeypatch.setenv("FEEDBACK_UI", "v3")
    monkeypatch.setenv("SLOPSMITH_UI", "v2")
    assert getenv_compat("FEEDBACK_UI") == "v3"


def test_legacy_fallback_when_canonical_unset(monkeypatch):
    monkeypatch.delenv("FEEDBACK_UI", raising=False)
    monkeypatch.setenv("SLOPSMITH_UI", "v2")
    assert getenv_compat("FEEDBACK_UI") == "v2"


def test_default_when_neither_set(monkeypatch):
    monkeypatch.delenv("FEEDBACK_UI", raising=False)
    monkeypatch.delenv("SLOPSMITH_UI", raising=False)
    assert getenv_compat("FEEDBACK_UI", "default") == "default"
    assert getenv_compat("FEEDBACK_UI") is None


def test_non_feedback_names_have_no_fallback(monkeypatch):
    monkeypatch.delenv("CONFIG_DIR", raising=False)
    monkeypatch.setenv("SLOPSMITH_CONFIG_DIR", "/tmp/x")
    # A non-FEEDBACK_ name must behave like os.environ.get (no aliasing).
    assert getenv_compat("CONFIG_DIR") is None


def test_empty_canonical_is_respected_not_overridden(monkeypatch):
    # An explicitly-empty canonical value is still "set" and wins.
    monkeypatch.setenv("FEEDBACK_UI", "")
    monkeypatch.setenv("SLOPSMITH_UI", "v2")
    assert getenv_compat("FEEDBACK_UI") == ""


def test_flag_parses_true_values(monkeypatch):
    for raw in ("1", "true", "YES", " On "):
        monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", raw)
        assert env_flag_compat("FEEDBACK_SYNC_STARTUP") is True


def test_flag_false_and_legacy(monkeypatch):
    monkeypatch.delenv("FEEDBACK_SYNC_STARTUP", raising=False)
    monkeypatch.setenv("SLOPSMITH_SYNC_STARTUP", "1")
    assert env_flag_compat("FEEDBACK_SYNC_STARTUP") is True
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "0")
    assert env_flag_compat("FEEDBACK_SYNC_STARTUP") is False
