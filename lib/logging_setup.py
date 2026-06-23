"""Logging configuration for FeedBack.

Call ``configure_logging()`` once at server startup, before any feedBack
module imports that might emit log records.

Environment variables:
    LOG_LEVEL   — severity threshold for the ``feedBack.*`` logger tree
                  (default: INFO). Also accepted: DEBUG, WARNING, ERROR.
    LOG_FORMAT  — "json" for structured output (Loki, ELK, Promtail);
                  "text" (default) for human-readable coloured console output.
    LOG_FILE    — optional path; when set, a RotatingFileHandler is added
                  alongside the console handler (max 10 MB, 5 backups).
                  The parent directory is created automatically if it does not
                  exist.  If the file cannot be opened, a warning is printed
                  and the server continues with console-only logging.
                  Useful for persistent NAS deployments.
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import sys
from pathlib import Path

import structlog


def _add_correlation_id(
    logger: object, method_name: str, event_dict: dict
) -> dict:
    """Inject the current request correlation ID into the event dict."""
    try:
        from asgi_correlation_id import correlation_id

        cid = correlation_id.get(None)
        if cid:
            event_dict["request_id"] = cid
    except ImportError:
        pass
    return event_dict


def configure_logging() -> None:
    """Wire up the feedBack logger hierarchy.

    Safe to call multiple times; always reflects the current LOG_LEVEL,
    LOG_FORMAT, and LOG_FILE environment variables.
    """
    raw_level = os.environ.get("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, raw_level, None)
    if not isinstance(level, int):
        sys.stderr.write(
            f"[feedBack] WARNING: unrecognised LOG_LEVEL={raw_level!r};"
            " falling back to INFO.\n"
        )
        level = logging.INFO

    raw_fmt = os.environ.get("LOG_FORMAT", "text").lower()
    if raw_fmt not in ("json", "text"):
        sys.stderr.write(
            f"[feedBack] WARNING: unrecognised LOG_FORMAT={raw_fmt!r};"
            " falling back to 'text'.\n"
        )
        raw_fmt = "text"
    fmt = raw_fmt

    log_file = os.environ.get("LOG_FILE", "").strip()

    # Console renderer: coloured when text mode, JSON otherwise.
    console_renderer = (
        structlog.processors.JSONRenderer()
        if fmt == "json"
        else structlog.dev.ConsoleRenderer()
    )
    # File renderer: always plain (no ANSI escape sequences) so rotated log
    # files are human-readable without a terminal.  JSON mode reuses the same
    # renderer because JSON output is already colour-free.
    file_renderer = (
        structlog.processors.JSONRenderer()
        if fmt == "json"
        else structlog.dev.ConsoleRenderer(colors=False)
    )

    # Applied to all records — both structlog-native and stdlib (foreign) calls.
    # Stdlib logging handles %-style format strings itself, so no
    # PositionalArgumentsFormatter is needed here.
    pre_chain: list = [
        structlog.contextvars.merge_contextvars,
        _add_correlation_id,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
    ]

    structlog.configure(
        processors=pre_chain + [structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        # Keep False so that every reconfigure() call takes effect immediately
        # for any code that holds a structlog.get_logger() proxy.  The small
        # per-call overhead is acceptable given that logging is not on the hot
        # path.
        cache_logger_on_first_use=False,
    )

    def _make_formatter(renderer: object) -> structlog.stdlib.ProcessorFormatter:
        return structlog.stdlib.ProcessorFormatter(
            processors=[
                structlog.stdlib.ProcessorFormatter.remove_processors_meta,
                # Format exc_info tuples to strings before the renderer so that
                # JSONRenderer never encounters a non-serializable traceback object.
                structlog.processors.ExceptionRenderer(),
                renderer,
            ],
            foreign_pre_chain=pre_chain,
        )

    console_formatter = _make_formatter(console_renderer)
    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(console_formatter)
    handlers: list[logging.Handler] = [console]

    if log_file:
        file_formatter = _make_formatter(file_renderer)
        try:
            Path(log_file).parent.mkdir(parents=True, exist_ok=True)
            fh = logging.handlers.RotatingFileHandler(
                log_file,
                maxBytes=10 * 1024 * 1024,  # 10 MB
                backupCount=5,
                encoding="utf-8",
            )
            fh.setFormatter(file_formatter)
            handlers.append(fh)
        except OSError as exc:
            sys.stderr.write(
                f"[feedBack] WARNING: could not open LOG_FILE={log_file!r}: {exc}"
                " — continuing with console-only logging.\n"
            )

    _uvicorn_names = ("uvicorn", "uvicorn.error", "uvicorn.access")
    all_loggers = [logging.getLogger("feedBack")] + [
        logging.getLogger(n) for n in _uvicorn_names
    ]

    # Collect all unique old handlers across every logger *before* any close so
    # that a shared handler (feedBack and uvicorn* were intentionally given the
    # same objects) isn't closed while still attached to another logger tree.
    old_handlers: set[logging.Handler] = set()
    for lg in all_loggers:
        old_handlers.update(lg.handlers)

    # Detach first, then close each unique handler exactly once.
    for lg in all_loggers:
        for h in list(lg.handlers):
            lg.removeHandler(h)
    for h in old_handlers:
        h.close()

    # Install fresh handlers on the feedBack root.
    root = logging.getLogger("feedBack")
    for h in handlers:
        root.addHandler(h)
    root.setLevel(level)
    root.propagate = False

    # Route uvicorn output through the same pipeline so everything is uniform.
    for name in _uvicorn_names:
        lg = logging.getLogger(name)
        lg.handlers = list(handlers)
        lg.propagate = False
        lg.setLevel(level)
