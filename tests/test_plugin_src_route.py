"""Tests for the plugin `src/` module-serving route and the live-edit cache
contract added in R0 (module-migration rails).

Covers:
  * GET /api/plugins/{id}/src/{path} serves a plugin's ES-module source tree
    with the right Content-Type, including nested paths.
  * Path containment: `..`, absolute, and NUL are rejected (404) — the same
    `safe_join` guard the assets/ route uses.
  * The live-edit cache contract: no-cache + a weak ETag, a bodyless 304 on
    matching If-None-Match, and no stale 304 after an in-place edit.
  * screen.js and assets/ now also emit an ETag and honor If-None-Match
    (previously screen.js sent no headers and assets/ never returned 304).

The routes read the module-global `plugins.LOADED_PLUGINS`, so each test
registers a fake ready plugin directly (save/restore that global) and drives
`register_plugin_api` on a fresh FastAPI app — no full server import needed.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import plugins


PLUGIN_ID = "srctest"


@pytest.fixture()
def client(tmp_path):
    """A TestClient with `register_plugin_api` wired and a single fake ready
    plugin whose dir (`tmp_path`) holds a src/ tree, an asset, and a screen.js.
    Restores LOADED_PLUGINS afterward."""
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.js").write_text("import './util/x.js';\nexport const boot = 1;\n")
    (tmp_path / "src" / "util").mkdir()
    (tmp_path / "src" / "util" / "x.js").write_text("export const x = 42;\n")
    (tmp_path / "src" / "theme.css").write_text(".a{color:red}\n")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "worklet.js").write_text("// worklet\n")
    (tmp_path / "screen.js").write_text("import './src/main.js';\n")

    saved = list(plugins.LOADED_PLUGINS)
    plugins.LOADED_PLUGINS.clear()
    plugins.LOADED_PLUGINS.append({
        "id": PLUGIN_ID,
        "status": "ready",
        "_dir": tmp_path,
        "_manifest": {"script": "screen.js", "scriptType": "module"},
    })
    app = FastAPI()
    plugins.register_plugin_api(app)
    c = TestClient(app, raise_server_exceptions=True)
    try:
        yield c, tmp_path
    finally:
        c.close()
        plugins.LOADED_PLUGINS.clear()
        plugins.LOADED_PLUGINS.extend(saved)


def test_src_file_served_with_js_media_type(client):
    c, _ = client
    r = c.get(f"/api/plugins/{PLUGIN_ID}/src/main.js")
    assert r.status_code == 200
    # Either application/javascript or text/javascript is a valid module-script
    # MIME (guess_type returns text/javascript on newer platforms); browsers
    # accept both for <script type=module>.
    assert "javascript" in r.headers["content-type"]
    assert "export const boot" in r.text
    assert r.headers["cache-control"] == "no-cache"
    assert r.headers.get("etag")


def test_src_nested_path_and_css_media_type(client):
    c, _ = client
    assert c.get(f"/api/plugins/{PLUGIN_ID}/src/util/x.js").status_code == 200
    r = c.get(f"/api/plugins/{PLUGIN_ID}/src/theme.css")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/css")


@pytest.mark.parametrize("bad", [
    "..%2f..%2fplugin.json",     # escape the src/ dir
    "..%2f..%2f..%2fetc%2fpasswd",
    "%2fetc%2fpasswd",           # absolute
    "util%2f..%2f..%2fscreen.js",
])
def test_src_traversal_rejected(client, bad):
    c, _ = client
    assert c.get(f"/api/plugins/{PLUGIN_ID}/src/{bad}").status_code == 404


def test_src_missing_is_404(client):
    c, _ = client
    assert c.get(f"/api/plugins/{PLUGIN_ID}/src/nope.js").status_code == 404


def test_src_conditional_304(client):
    c, _ = client
    r1 = c.get(f"/api/plugins/{PLUGIN_ID}/src/main.js")
    etag = r1.headers["etag"]
    r2 = c.get(f"/api/plugins/{PLUGIN_ID}/src/main.js", headers={"If-None-Match": etag})
    assert r2.status_code == 304
    assert r2.content == b""


def test_src_no_stale_304_after_edit(client):
    c, root = client
    etag = c.get(f"/api/plugins/{PLUGIN_ID}/src/main.js").headers["etag"]
    (root / "src" / "main.js").write_text("export const boot = 2;  // edited, longer body\n")
    r = c.get(f"/api/plugins/{PLUGIN_ID}/src/main.js", headers={"If-None-Match": etag})
    assert r.status_code == 200
    assert "boot = 2" in r.text
    assert r.headers["etag"] != etag


def test_screen_js_now_conditional(client):
    c, _ = client
    r1 = c.get(f"/api/plugins/{PLUGIN_ID}/screen.js")
    assert r1.status_code == 200
    assert r1.headers["cache-control"] == "no-cache"
    etag = r1.headers["etag"]
    r2 = c.get(f"/api/plugins/{PLUGIN_ID}/screen.js", headers={"If-None-Match": etag})
    assert r2.status_code == 304


def test_asset_now_conditional(client):
    c, _ = client
    r1 = c.get(f"/api/plugins/{PLUGIN_ID}/assets/worklet.js")
    assert r1.status_code == 200
    etag = r1.headers["etag"]
    r2 = c.get(f"/api/plugins/{PLUGIN_ID}/assets/worklet.js", headers={"If-None-Match": etag})
    assert r2.status_code == 304


def test_unready_plugin_src_is_404(client):
    c, _ = client
    plugins.LOADED_PLUGINS[0]["status"] = "installing"
    assert c.get(f"/api/plugins/{PLUGIN_ID}/src/main.js").status_code == 404


# ── #879: the /g/<token>/ generation prefix ────────────────────────────────────
#
# A plugin ROLLBACK must actually re-evaluate a module plugin. ES modules are
# evaluated once per URL per document, so re-inserting a <script type="module">
# whose src the module map has already seen fires `load` without re-running the
# body. Busting the ENTRY url alone does not help — screen.js is a one-line
# `import './src/main.js'`, and a relative specifier resolves against the base URL
# with the QUERY DROPPED, so a ?v= token never reaches the graph.
#
# Hence a token in the PATH: every relative import inherits it, at every depth,
# with no import-specifier rewriting. These routes must serve the SAME bytes and
# keep the SAME containment.

def test_generation_prefix_serves_identical_screen_js(client):
    c, _ = client
    plain = c.get(f"/api/plugins/{PLUGIN_ID}/screen.js")
    gen = c.get(f"/api/plugins/{PLUGIN_ID}/g/7/screen.js")
    assert gen.status_code == 200
    assert gen.content == plain.content
    assert "import './src/main.js'" in gen.text


def test_generation_prefix_serves_the_whole_module_graph(client):
    """The point of the path token: a relative import from a /g/7/ entry resolves
    to a /g/7/ URL, so the graph is fetched fresh — not just the entry."""
    c, _ = client
    main = c.get(f"/api/plugins/{PLUGIN_ID}/g/7/src/main.js")
    assert main.status_code == 200
    assert main.text == c.get(f"/api/plugins/{PLUGIN_ID}/src/main.js").text
    # and one level deeper, which is where a query-string token would already have
    # been lost twice over
    nested = c.get(f"/api/plugins/{PLUGIN_ID}/g/7/src/util/x.js")
    assert nested.status_code == 200
    assert "export const x = 42" in nested.text


def test_generation_token_is_opaque(client):
    """Any token serves the same bytes — it exists only to vary the URL."""
    c, _ = client
    a = c.get(f"/api/plugins/{PLUGIN_ID}/g/1/src/main.js")
    b = c.get(f"/api/plugins/{PLUGIN_ID}/g/999999/src/main.js")
    assert a.status_code == b.status_code == 200
    assert a.text == b.text


def test_generation_prefix_does_not_widen_containment(client):
    """The token is never joined into a path, so containment must be EXACTLY what the
    un-prefixed route already gives. Asserted as parity rather than as a flat 404:
    `../screen.js` legitimately 200s on BOTH, because the URL normalises to
    /api/plugins/<id>/screen.js before routing ever happens — it never leaves the
    plugin dir. Pinning an absolute expectation here would have encoded my guess
    about the existing route instead of testing the thing that matters, which is
    that /g/ changes nothing."""
    c, _ = client
    for bad in ("../screen.js", "../../etc/passwd", "..%2f..%2fetc%2fpasswd",
                "..%5c..%5cwindows%5cwin.ini", "/etc/passwd"):
        plain = c.get(f"/api/plugins/{PLUGIN_ID}/src/{bad}")
        gen = c.get(f"/api/plugins/{PLUGIN_ID}/g/1/src/{bad}")
        assert gen.status_code == plain.status_code, f"/g/ diverged on {bad!r}"
        assert gen.content == plain.content, f"/g/ served different bytes for {bad!r}"
        assert "root:" not in gen.text and "[extensions]" not in gen.text

    # and the real traversals are genuinely rejected, on both
    for bad in ("../../etc/passwd", "..%2f..%2fetc%2fpasswd"):
        assert c.get(f"/api/plugins/{PLUGIN_ID}/g/1/src/{bad}").status_code == 404


def test_generation_prefix_404s_for_unknown_plugin(client):
    c, _ = client
    assert c.get("/api/plugins/nope/g/1/screen.js").status_code == 404
    assert c.get("/api/plugins/nope/g/1/src/main.js").status_code == 404


def test_generation_prefix_serves_ASSETS_too(client):
    """Codex [P2] on the first cut of this fix, and it was right.

    The path token shifts the BASE URL, so everything a module resolves relatively moves
    with it — not just imports. `new URL('../assets/worklet.js', import.meta.url)` from
    /api/plugins/<id>/g/1/src/main.js resolves to /api/plugins/<id>/g/1/assets/worklet.js.
    Mirroring only screen.js and src/ would have fixed imports and 404'd every asset,
    worklet and wasm file the graph reaches. Hence a path REWRITE, so every plugin route
    — present and future — works under the prefix."""
    c, _ = client
    plain = c.get(f"/api/plugins/{PLUGIN_ID}/assets/worklet.js")
    gen = c.get(f"/api/plugins/{PLUGIN_ID}/g/1/assets/worklet.js")
    assert plain.status_code == 200
    assert gen.status_code == 200, "an asset reached relatively from a reloaded module graph 404'd"
    assert gen.content == plain.content


def test_generation_prefix_covers_every_plugin_route(client):
    """The rewrite is generic, so this holds for routes nobody thought about — which is
    the point. Any plugin route added later works under /g/ with no extra wiring."""
    c, _ = client
    for route in ("screen.js", "src/main.js", "src/util/x.js", "src/theme.css",
                  "assets/worklet.js", "settings.html"):
        plain = c.get(f"/api/plugins/{PLUGIN_ID}/{route}")
        gen = c.get(f"/api/plugins/{PLUGIN_ID}/g/42/{route}")
        assert gen.status_code == plain.status_code, f"/g/ diverged on {route}"
        assert gen.content == plain.content, f"/g/ served different bytes for {route}"


def test_generation_prefix_handles_non_ascii_filenames(client):
    """Codex [P3] on the second cut. A plugin file named e.g. src/工具.js is perfectly
    valid, and the middleware must not 500 on it — which an eager
    raw_path.encode("latin-1") did, making the prefixed route LESS capable than the
    plain one. raw_path is informational; Starlette routes on scope["path"]."""
    c, tmp = client
    (tmp / "src" / "工具.js").write_text("export const t = 1;\n")
    plain = c.get(f"/api/plugins/{PLUGIN_ID}/src/工具.js")
    gen = c.get(f"/api/plugins/{PLUGIN_ID}/g/3/src/工具.js")
    assert plain.status_code == 200
    assert gen.status_code == 200, "non-ASCII module path 500'd or 404'd under /g/"
    assert gen.content == plain.content
