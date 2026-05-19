# Plugin sibling imports — `load_sibling`

When a backend plugin spans multiple Python files, **use `context["load_sibling"]`** rather than bare `import` statements. This is the slopsmith#33 contract.

## The problem

The plugin loader inserts each plugin's directory onto `sys.path` so `from extractor import X` works. But Python caches imports by **module name** in `sys.modules`. Two plugins that each ship a top-level `extractor.py` (or any other generic name — `util.py`, `client.py`, `parser.py`, `config.py`, …) collide: whichever loads first wins, and the other plugin's `from extractor import X` either gets the wrong module or fails with `cannot import name 'X' from 'extractor'`.

## The fix

`context["load_sibling"](name)` loads the sibling under a namespaced module name `plugin_<id>.<name>`, so each plugin gets its own copy. The `<id>` portion is bijectively encoded so reverse-DNS-style ids like `com.example.foo` work without colliding: `_` → `_5f_`, `.` → `_2e_`.

```python
def setup(app, context):
    extractor = context["load_sibling"]("extractor")
    PsarcReader = extractor.PsarcReader
    # …
```

## Notes

- **`name` is a bare module name** — no `.py` suffix, no slashes, no `.`. The helper raises `ValueError` for path traversal / format issues and `ImportError` for missing files.
- **Both single-file siblings (`extractor.py`) and package-form siblings (`extractor/__init__.py`) work.** Package form wins when both exist (matches CPython's import-resolution precedence).
- **Relative imports between siblings work** — `from .shared import X` in a top-level helper, `from ..shared import X` from inside a sibling package. The synthetic parent package `plugin_<id>` carries the plugin directory in its `__path__`.
- **`from . import sibling` (attribute-style) also resolves**: loaded children are exposed as attributes on the parent package.
- **Repeat calls return the cached module.** Concurrent first-time calls are serialized via per-module locks so no caller observes a half-initialized module.
- **Don't mix `load_sibling` and bare `import` for the same module** — they'd execute the file twice and split module-level state.

## Migration

Bare `import sibling` from `routes.py` still works during the transition period, but the loader prints a startup warning when it detects two plugins shipping a same-named top-level module — covering both `.py` files and package directories. Migrate to `load_sibling` to silence the warning and immunize your plugin from future ecosystem collisions.

## Verification

The collision-detection logic is encoded in `tests/test_plugins.py`. Run:

```bash
pytest tests/test_plugins.py -v
```

If you're authoring a plugin with a top-level helper, add a test that imports your plugin under a `reset_plugin_state` fixture to confirm clean import behaviour. See [testing-plugins.md](testing-plugins.md).

## Related

- [PLUGIN_AUTHORING.md](PLUGIN_AUTHORING.md) — guide index
- [plugin-manifest.md](plugin-manifest.md) — declaring `routes.py`
- [plugin-logging.md](plugin-logging.md) — `context["log"]` (also exposed via `context`)
- [testing-plugins.md](testing-plugins.md) — `reset_plugin_state` fixture
