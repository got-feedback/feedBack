"""Guard: every first-party module `server.py` imports must be one the packagers copy.

feedback-desktop's `scripts/bundle-slopsmith.sh` copies a **hardcoded list** from
core into the app bundle — `server.py`, `VERSION`, `lib/`, `data/`, `static/`,
`plugins/__init__.py`. A new root-level module (say `appstate.py`) ships fine in
Docker, imports fine under pytest, and is then *silently dropped* from the
packaged desktop app, which dies at startup with:

    File ".../Resources/slopsmith/server.py", line 71, in <module>
        import appstate
    ModuleNotFoundError: No module named 'appstate'

That shipped once. This test is why it can't ship twice: it walks `server.py`'s
module-level imports, keeps the ones that resolve inside this repo, and asserts
each lives under a directory every packaging path already copies wholesale.

If you add a first-party module for `server.py`, put it in `lib/` — the one core
directory the Dockerfile (`COPY lib/`), `docker-compose.yml`, and the desktop
bundler (`cp -r lib`) all copy, and that all three put on `sys.path`. If you
genuinely need it at the repo root, you must also teach `bundle-slopsmith.sh`,
the `Dockerfile`, `.dockerignore`, and `docker-compose.yml` about it — and then
update `BUNDLED_ROOTS` below.
"""

import ast
import importlib.util
import pathlib

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent

# Directories every packaging path copies wholesale, plus the files copied by name.
BUNDLED_ROOTS = ("lib", "plugins", "data", "static")
BUNDLED_FILES = ("server.py", "main.py")


def _server_toplevel_imports():
    """Module names imported at `server.py`'s top level (not inside a function)."""
    tree = ast.parse((REPO_ROOT / "server.py").read_text())
    names = set()
    for node in tree.body:                      # top level only — lazy imports are fine
        if isinstance(node, ast.Import):
            names.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return sorted(names)


# `spec.origin` is not always a path: built-in and frozen stdlib modules use
# these sentinels. `Path("frozen").resolve()` would land inside the repo and
# report `os` as first-party — so filter them before touching the filesystem.
_NON_PATH_ORIGINS = {"built-in", "frozen", "namespace"}


def _first_party_origin(name):
    """Path of `name` if it resolves inside this repo, else None (stdlib/site-package)."""
    try:
        spec = importlib.util.find_spec(name)
    except (ImportError, ValueError):
        return None
    if spec is None:
        return None

    if spec.origin and spec.origin not in _NON_PATH_ORIGINS:
        origin = pathlib.Path(spec.origin)
    else:
        # Namespace/frozen: fall back to the first search location, if any.
        locations = list(getattr(spec, "submodule_search_locations", None) or [])
        if not locations:
            return None
        origin = pathlib.Path(locations[0])

    if not origin.is_absolute():
        return None                              # a sentinel, not a real path
    origin = origin.resolve()
    try:
        origin.relative_to(REPO_ROOT)
    except ValueError:
        return None                              # outside the repo → a dependency
    return origin


@pytest.mark.parametrize("name", _server_toplevel_imports())
def test_server_import_is_bundled(name):
    origin = _first_party_origin(name)
    if origin is None:
        return                                   # stdlib or an installed dependency

    rel = origin.relative_to(REPO_ROOT)
    if rel.as_posix() in BUNDLED_FILES or rel.parts[0] in BUNDLED_ROOTS:
        return

    raise AssertionError(
        f"server.py imports `{name}` from {rel}, which no packager copies.\n"
        f"The desktop bundler (scripts/bundle-slopsmith.sh) copies only "
        f"{BUNDLED_FILES} and {BUNDLED_ROOTS}/, so the packaged app would die "
        f"at startup with ModuleNotFoundError: No module named '{name}'.\n"
        f"Move it under lib/, or teach bundle-slopsmith.sh + Dockerfile + "
        f".dockerignore + docker-compose.yml about it and update BUNDLED_ROOTS."
    )


def test_the_seam_and_routers_live_under_lib():
    """Pin the two that already caused a shipped break."""
    for name in ("appstate", "routers"):
        origin = _first_party_origin(name)
        assert origin is not None, f"{name} does not resolve inside the repo"
        assert origin.relative_to(REPO_ROOT).parts[0] == "lib", (
            f"{name} resolved to {origin.relative_to(REPO_ROOT)}; it must live "
            f"under lib/ or the packaged desktop app will not ship it"
        )
