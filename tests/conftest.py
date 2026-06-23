"""Shared pytest fixtures for the feedBack test suite."""

import logging

import pytest
import structlog


_LOGGING_NAMES = ("feedBack", "uvicorn", "uvicorn.error", "uvicorn.access")


@pytest.fixture()
def isolate_logging():
    """Restore feedBack / uvicorn logger state after each test.

    Saves handlers, level, and propagate flag before the test runs and
    restores all three on teardown.  Import into any test module that calls
    configure_logging() so mutations don't bleed across tests.
    """
    saved = {}
    for name in _LOGGING_NAMES:
        lg = logging.getLogger(name)
        saved[name] = (
            list(lg.handlers),  # snapshot the handler list
            lg.level,
            lg.propagate,
        )
    yield
    for name in _LOGGING_NAMES:
        lg = logging.getLogger(name)
        original_handlers, original_level, original_propagate = saved[name]

        # Close and remove any handlers that were added during the test.
        for h in list(lg.handlers):
            if h not in original_handlers:
                lg.removeHandler(h)
                h.close()
        # Remove any original handlers that may have been removed during the test
        # so we can add them back cleanly.
        for h in list(lg.handlers):
            lg.removeHandler(h)
        # Reattach the original handlers.
        for h in original_handlers:
            lg.addHandler(h)

        lg.setLevel(original_level)
        lg.propagate = original_propagate
    structlog.reset_defaults()
