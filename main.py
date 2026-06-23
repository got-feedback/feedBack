"""Programmatic entry point for the FeedBack server.

Using ``uvicorn.run()`` with ``log_config=None`` prevents uvicorn from calling
``logging.config.dictConfig(LOGGING_CONFIG)`` during its startup sequence.
This ensures that the structlog pipeline installed by ``configure_logging()``
is active for **all** uvicorn messages, including the earliest lifecycle lines
logged before the ASGI startup hook fires, such as:

    "Started server process [PID]"
    "Waiting for application startup"

Usage::

    python main.py              # default host 0.0.0.0, port 8000
    HOST=127.0.0.1 PORT=8001 python main.py
"""

import os


def run() -> None:
    """Configure logging and start the uvicorn server.

    ``configure_logging()`` is called first so that when uvicorn starts with
    ``log_config=None`` it finds the structlog handlers already installed.
    Uvicorn will not call its own ``dictConfig()``, so those handlers are never
    overwritten and every log record passes through the same structured
    pipeline.
    """
    from logging_setup import configure_logging

    configure_logging()

    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(
        "server:app",
        host=host,
        port=port,
        # Skips uvicorn's logging.config.dictConfig(LOGGING_CONFIG) call so
        # our structlog handlers are never overwritten.  Every uvicorn log
        # record — including early startup messages — passes through the same
        # structured pipeline.
        log_config=None,
    )


if __name__ == "__main__":
    run()
