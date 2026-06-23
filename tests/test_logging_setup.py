"""Tests for lib/logging_setup.py — configure_logging() behaviour.

Covers:
- LOG_FORMAT=json produces one valid JSON object per line.
- JSON output includes expected fields (event, level, timestamp).
- exc_info / logger.exception() is serializable in JSON mode (no TypeError).
- LOG_LEVEL=WARNING suppresses INFO records.
- LOG_LEVEL=WARNING allows WARNING records.
- LOG_FORMAT=text produces non-JSON human-readable output.
- Correlation ID context variable is injected as request_id in JSON mode.
- Calling configure_logging() again with a new LOG_LEVEL takes effect.
- LOG_FILE creates a RotatingFileHandler that writes log records.
- LOG_FILE + LOG_FORMAT=text file output contains no ANSI escape sequences.
- LOG_FILE + LOG_FORMAT=json file output is valid JSON.
- Unrecognised LOG_LEVEL value falls back to INFO with a stderr warning.
- Unrecognised LOG_FORMAT value falls back to text mode with a stderr warning.
- configure_logging() restores structlog handlers on uvicorn loggers after uvicorn
  applies its own default log_config (simulates startup re-configuration).
"""

import io
import json
import logging

import pytest
import structlog


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _isolate_logging(isolate_logging):
    """Auto-use wrapper that pulls in the shared isolate_logging fixture."""


def _setup(monkeypatch, *, fmt: str = "json", level: str = "DEBUG") -> tuple:
    """Configure logging with the given env vars and return (logger, capture_buf).

    Returns a stdlib logger under the feedBack hierarchy and a StringIO buffer
    wired to the console handler's stream.
    """
    monkeypatch.setenv("LOG_FORMAT", fmt)
    monkeypatch.setenv("LOG_LEVEL", level)
    monkeypatch.delenv("LOG_FILE", raising=False)

    import logging_setup

    logging_setup.configure_logging()

    buf = io.StringIO()
    root = logging.getLogger("feedBack")
    for h in root.handlers:
        # Replace stream on the console StreamHandler (not file handlers).
        if isinstance(h, logging.StreamHandler) and not isinstance(
            h, logging.FileHandler
        ):
            h.stream = buf

    return logging.getLogger("feedBack.test"), buf


# ---------------------------------------------------------------------------
# JSON format
# ---------------------------------------------------------------------------


def test_json_format_emits_valid_json(monkeypatch):
    log, buf = _setup(monkeypatch, fmt="json")
    log.info("hello_world")
    line = buf.getvalue().strip()
    assert line, "no output was captured"
    parsed = json.loads(line)
    assert parsed.get("event") == "hello_world"


def test_json_format_includes_level_field(monkeypatch):
    log, buf = _setup(monkeypatch, fmt="json")
    log.warning("check_level")
    parsed = json.loads(buf.getvalue().strip())
    assert "level" in parsed


def test_json_format_includes_timestamp_field(monkeypatch):
    log, buf = _setup(monkeypatch, fmt="json")
    log.info("ts_test")
    parsed = json.loads(buf.getvalue().strip())
    assert "timestamp" in parsed


def test_json_format_exc_info_is_serializable(monkeypatch):
    """exc_info tuples must not raise TypeError in JSONRenderer."""
    log, buf = _setup(monkeypatch, fmt="json")
    try:
        raise ValueError("boom")
    except ValueError:
        log.exception("oops")
    line = buf.getvalue().strip()
    assert line, "no output was captured"
    # Must be valid JSON — no TypeError should have propagated.
    parsed = json.loads(line)
    assert parsed.get("event") == "oops"


# ---------------------------------------------------------------------------
# LOG_LEVEL filtering
# ---------------------------------------------------------------------------


def test_log_level_warning_suppresses_info(monkeypatch):
    log, buf = _setup(monkeypatch, fmt="json", level="WARNING")
    log.info("should_be_suppressed")
    assert buf.getvalue() == ""


def test_log_level_warning_allows_warning(monkeypatch):
    log, buf = _setup(monkeypatch, fmt="json", level="WARNING")
    log.warning("visible")
    assert buf.getvalue().strip() != ""


# ---------------------------------------------------------------------------
# Text format
# ---------------------------------------------------------------------------


def test_text_format_is_not_json(monkeypatch):
    log, buf = _setup(monkeypatch, fmt="text")
    log.info("hello_text")
    line = buf.getvalue().strip()
    assert line != ""
    with pytest.raises((json.JSONDecodeError, ValueError)):
        json.loads(line)


# ---------------------------------------------------------------------------
# Correlation ID
# ---------------------------------------------------------------------------


def test_correlation_id_injected_when_set(monkeypatch):
    """request_id appears in the event dict when the correlation_id context var is set."""
    from asgi_correlation_id import correlation_id

    log, buf = _setup(monkeypatch, fmt="json")
    token = correlation_id.set("test-req-id-abc")
    try:
        log.info("correlated_event")
    finally:
        correlation_id.reset(token)

    parsed = json.loads(buf.getvalue().strip())
    assert parsed.get("request_id") == "test-req-id-abc"


def test_no_request_id_when_correlation_id_not_set(monkeypatch):
    """request_id is absent when no correlation_id context var is set."""
    log, buf = _setup(monkeypatch, fmt="json")
    log.info("uncorrelated_event")
    parsed = json.loads(buf.getvalue().strip())
    assert "request_id" not in parsed


# ---------------------------------------------------------------------------
# Reconfiguration
# ---------------------------------------------------------------------------


def test_reconfigure_picks_up_new_level(monkeypatch):
    """A second configure_logging() call reflects the updated LOG_LEVEL."""
    import logging_setup

    monkeypatch.setenv("LOG_FORMAT", "json")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    monkeypatch.delenv("LOG_FILE", raising=False)
    logging_setup.configure_logging()

    # Raise the level to WARNING via a second call.
    monkeypatch.setenv("LOG_LEVEL", "WARNING")
    logging_setup.configure_logging()

    buf = io.StringIO()
    for h in logging.getLogger("feedBack").handlers:
        if isinstance(h, logging.StreamHandler) and not isinstance(
            h, logging.FileHandler
        ):
            h.stream = buf

    test_log = logging.getLogger("feedBack.reconfig")
    test_log.info("should_not_appear")
    assert buf.getvalue() == "", "INFO should be suppressed after reconfigure to WARNING"

    test_log.warning("should_appear")
    assert buf.getvalue().strip() != "", "WARNING should pass through"


# ---------------------------------------------------------------------------
# LOG_FILE
# ---------------------------------------------------------------------------


def test_log_file_creates_rotating_handler(monkeypatch, tmp_path):
    """LOG_FILE wires up a RotatingFileHandler that writes log records."""
    import logging_setup

    log_path = tmp_path / "feedBack.log"
    monkeypatch.setenv("LOG_FORMAT", "json")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    monkeypatch.setenv("LOG_FILE", str(log_path))
    logging_setup.configure_logging()

    logging.getLogger("feedBack.filelog").info("written_to_file")

    # Flush all file handlers so the write is committed.
    for h in logging.getLogger("feedBack").handlers:
        h.flush()

    assert log_path.exists(), "log file was not created"
    content = log_path.read_text(encoding="utf-8").strip()
    assert content, "log file is empty"
    parsed = json.loads(content)
    assert parsed.get("event") == "written_to_file"


def test_log_file_creates_parent_dirs(monkeypatch, tmp_path):
    """LOG_FILE auto-creates missing parent directories instead of raising."""
    import logging_setup

    log_path = tmp_path / "nested" / "deeper" / "feedBack.log"
    monkeypatch.setenv("LOG_FORMAT", "json")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    monkeypatch.setenv("LOG_FILE", str(log_path))
    logging_setup.configure_logging()

    logging.getLogger("feedBack.nested").info("nested_dir_event")

    for h in logging.getLogger("feedBack").handlers:
        h.flush()

    assert log_path.exists(), "log file was not created in nested directories"


def test_log_file_bad_path_falls_back_gracefully(monkeypatch, tmp_path, capsys):
    """An unwritable LOG_FILE path must not crash the server; a warning is printed."""
    import logging_setup

    # Point LOG_FILE at an existing regular file used as the "parent" so that
    # mkdir() and open() will both fail (we can't write to a path whose
    # parent is a file, not a directory).
    blocker = tmp_path / "blocker"
    blocker.write_text("I am a file, not a directory")
    bad_path = str(blocker / "feedBack.log")

    monkeypatch.setenv("LOG_FORMAT", "json")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    monkeypatch.setenv("LOG_FILE", bad_path)

    # Must not raise — server should start with console-only logging.
    logging_setup.configure_logging()

    captured = capsys.readouterr()
    assert "WARNING" in captured.err
    assert "LOG_FILE" in captured.err

    # Console logging still works.
    root = logging.getLogger("feedBack")
    file_handlers = [h for h in root.handlers if isinstance(h, logging.FileHandler)]
    assert not file_handlers, "no FileHandler should have been added after open failure"


def test_log_file_text_mode_no_ansi(monkeypatch, tmp_path):
    """LOG_FILE with LOG_FORMAT=text must not write ANSI escape sequences."""
    import logging_setup

    log_path = tmp_path / "feedBack.log"
    monkeypatch.setenv("LOG_FORMAT", "text")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    monkeypatch.setenv("LOG_FILE", str(log_path))
    logging_setup.configure_logging()

    logging.getLogger("feedBack.plain").info("plain_text_event")

    for h in logging.getLogger("feedBack").handlers:
        h.flush()

    content = log_path.read_text(encoding="utf-8")
    # ANSI escape sequences start with ESC (\x1b) followed by [.
    assert "\x1b[" not in content, "file output must not contain ANSI escape sequences"
    assert "plain_text_event" in content


def test_log_file_json_mode_is_valid_json(monkeypatch, tmp_path):
    """LOG_FILE with LOG_FORMAT=json writes one valid JSON object per line."""
    import logging_setup

    log_path = tmp_path / "feedBack.log"
    monkeypatch.setenv("LOG_FORMAT", "json")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    monkeypatch.setenv("LOG_FILE", str(log_path))
    logging_setup.configure_logging()

    logging.getLogger("feedBack.jsonfile").warning("json_file_event")

    for h in logging.getLogger("feedBack").handlers:
        h.flush()

    lines = [l for l in log_path.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert lines, "no output written to log file"
    parsed = json.loads(lines[0])
    assert parsed.get("event") == "json_file_event"


# ---------------------------------------------------------------------------
# Typo / misconfiguration warnings
# ---------------------------------------------------------------------------


def test_bad_log_level_falls_back_to_info_with_warning(monkeypatch, capsys):
    """An unrecognised LOG_LEVEL falls back to INFO and emits a stderr warning."""
    import logging_setup

    monkeypatch.setenv("LOG_LEVEL", "TYPO")
    monkeypatch.setenv("LOG_FORMAT", "json")
    monkeypatch.delenv("LOG_FILE", raising=False)
    logging_setup.configure_logging()

    # Warning must appear on stderr.
    err = capsys.readouterr().err
    assert "LOG_LEVEL" in err
    assert "TYPO" in err

    # Fallback to INFO: INFO records pass through, DEBUG does not.
    buf = io.StringIO()
    for h in logging.getLogger("feedBack").handlers:
        if isinstance(h, logging.StreamHandler) and not isinstance(
            h, logging.FileHandler
        ):
            h.stream = buf

    log = logging.getLogger("feedBack.typo_level")
    log.debug("should_be_filtered")
    assert buf.getvalue() == "", "DEBUG should be suppressed when level is INFO"
    log.info("should_pass")
    assert buf.getvalue().strip() != "", "INFO should pass through at default level"


def test_non_integer_log_level_attribute_falls_back_to_info(monkeypatch, capsys):
    """LOG_LEVEL set to a non-integer logging module attribute (e.g. BASIC_FORMAT)
    must fall back to INFO rather than passing a string to setLevel()."""
    import logging_setup

    # logging.BASIC_FORMAT is a real attribute on the logging module but its
    # value is a string ('%(levelname)s:%(name)s:%(message)s'), not an int.
    # The old `getattr(...) is None` guard would silently accept it and then
    # crash inside setLevel(); the new isinstance(level, int) guard must catch it.
    monkeypatch.setenv("LOG_LEVEL", "BASIC_FORMAT")
    monkeypatch.setenv("LOG_FORMAT", "json")
    monkeypatch.delenv("LOG_FILE", raising=False)

    # Must not raise even though BASIC_FORMAT is a str, not an int.
    logging_setup.configure_logging()

    err = capsys.readouterr().err
    assert "LOG_LEVEL" in err
    assert "BASIC_FORMAT" in err

    # Verify INFO-level fallback: DEBUG suppressed, INFO passes.
    buf = io.StringIO()
    for h in logging.getLogger("feedBack").handlers:
        if isinstance(h, logging.StreamHandler) and not isinstance(
            h, logging.FileHandler
        ):
            h.stream = buf

    log = logging.getLogger("feedBack.basic_format_level")
    log.debug("should_be_filtered")
    assert buf.getvalue() == "", "DEBUG should be suppressed when level fell back to INFO"
    log.info("should_pass")
    assert buf.getvalue().strip() != "", "INFO should pass through at fallback level"


def test_bad_log_format_falls_back_to_text_with_warning(monkeypatch, capsys):
    """An unrecognised LOG_FORMAT falls back to text mode and emits a stderr warning."""
    import logging_setup

    monkeypatch.setenv("LOG_FORMAT", "xml")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    monkeypatch.delenv("LOG_FILE", raising=False)
    logging_setup.configure_logging()

    err = capsys.readouterr().err
    assert "LOG_FORMAT" in err
    assert "xml" in err

    # Text fallback: output should not be JSON.
    buf = io.StringIO()
    for h in logging.getLogger("feedBack").handlers:
        if isinstance(h, logging.StreamHandler) and not isinstance(
            h, logging.FileHandler
        ):
            h.stream = buf

    logging.getLogger("feedBack.typo_fmt").info("text_fallback_event")
    line = buf.getvalue().strip()
    assert line, "no output captured"
    with pytest.raises((json.JSONDecodeError, ValueError)):
        json.loads(line)


# ---------------------------------------------------------------------------
# Uvicorn log_config override resilience
# ---------------------------------------------------------------------------


def test_configure_logging_survives_uvicorn_log_config_reset(monkeypatch):
    """configure_logging() must restore structlog handlers after uvicorn resets them.

    When uvicorn starts, it calls logging.config.dictConfig(LOGGING_CONFIG) which
    replaces the handlers on the uvicorn* loggers that configure_logging() set at
    import time.  The startup_events() handler in server.py re-calls
    configure_logging() to restore the structlog pipeline.  This test simulates
    that sequence without launching a real uvicorn process.
    """
    import logging.config
    import logging_setup
    import structlog

    monkeypatch.setenv("LOG_FORMAT", "json")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    monkeypatch.delenv("LOG_FILE", raising=False)

    # Step 1: configure_logging() as done at server.py import time.
    logging_setup.configure_logging()

    # Verify: uvicorn logger now uses our ProcessorFormatter.
    uvicorn_logger = logging.getLogger("uvicorn")
    assert uvicorn_logger.handlers, "uvicorn logger should have handlers after configure_logging()"
    assert isinstance(
        uvicorn_logger.handlers[0].formatter,
        structlog.stdlib.ProcessorFormatter,
    ), "uvicorn handler should use ProcessorFormatter before uvicorn startup"

    # Step 2: simulate uvicorn applying its own LOGGING_CONFIG (as it does on startup).
    from uvicorn.config import LOGGING_CONFIG as _UVICORN_LOG_CFG

    logging.config.dictConfig(_UVICORN_LOG_CFG)

    # After uvicorn's dictConfig, uvicorn logger handlers are replaced.
    uvicorn_handlers_after_uvicorn = logging.getLogger("uvicorn").handlers
    for h in uvicorn_handlers_after_uvicorn:
        assert not isinstance(h.formatter, structlog.stdlib.ProcessorFormatter), (
            "uvicorn reset should have replaced our ProcessorFormatter — "
            "test setup incorrect"
        )

    # Step 3: re-call configure_logging() as startup_events() in server.py does.
    logging_setup.configure_logging()

    # Verify: structlog pipeline is restored on all uvicorn* loggers.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        assert lg.handlers, f"{name!r} logger has no handlers after re-configure"
        assert isinstance(
            lg.handlers[0].formatter,
            structlog.stdlib.ProcessorFormatter,
        ), (
            f"{name!r} handler formatter is {type(lg.handlers[0].formatter).__name__!r};"
            " expected ProcessorFormatter after startup re-configure"
        )


# ---------------------------------------------------------------------------
# main.py entry point
# ---------------------------------------------------------------------------


def test_main_run_passes_log_config_none():
    """main.py's run() must pass log_config=None to uvicorn.run().

    Passing log_config=None prevents uvicorn from calling
    logging.config.dictConfig(LOGGING_CONFIG) during startup, so the
    structlog pipeline installed by configure_logging() is never overwritten.
    This is what ensures early lifecycle messages like "Started server process"
    pass through the structured formatter rather than uvicorn's stock one.
    """
    import unittest.mock

    import main

    with (
        unittest.mock.patch("logging_setup.configure_logging") as mock_cfg,
        unittest.mock.patch("uvicorn.run") as mock_run,
    ):
        main.run()

    mock_cfg.assert_called_once()
    mock_run.assert_called_once()
    kwargs = mock_run.call_args.kwargs
    assert "log_config" in kwargs, (
        "main.run() must explicitly pass log_config= to uvicorn.run()"
    )
    assert kwargs["log_config"] is None, (
        "main.run() must pass log_config=None to prevent uvicorn from "
        "overwriting our structlog handlers"
    )
