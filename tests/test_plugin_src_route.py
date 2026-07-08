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
