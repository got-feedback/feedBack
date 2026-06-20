"""Tests for the `GET /api/version` endpoint.

Covers the configurable `APP_SOURCE_URL` / `APP_LICENSE_URL` env vars
introduced during the AGPL-3.0 relicense: the default values, the
empty/whitespace fallback, trailing-slash stripping, and — most importantly
— the URL guard (http(s) scheme + non-empty host) that prevents a
misconfigured/hostile env var from smuggling `javascript:` / `data:` /
malformed URLs onto the About-page `<a href>`.
"""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


DEFAULT_SOURCE_URL = "https://github.com/got-feedback/feedBack"
DEFAULT_LICENSE_URL = DEFAULT_SOURCE_URL + "/blob/main/LICENSE"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """Minimal server TestClient, with background I/O suppressed.

    Mirrors the fixture pattern used by `test_correlation_id.py` — fresh
    server import per test so module-level env captures (if any are ever
    added) don't leak between tests.
    """
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("SLOPSMITH_SYNC_STARTUP", "1")
    # Clear ambient overrides so the default-URL assertions are deterministic
    # regardless of the caller's shell / CI environment. Individual tests
    # re-set these via their own monkeypatch calls as needed.
    monkeypatch.delenv("APP_SOURCE_URL", raising=False)
    monkeypatch.delenv("APP_LICENSE_URL", raising=False)
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    monkeypatch.setattr(server, "load_plugins", lambda *a, **kw: None)
    monkeypatch.setattr(server, "startup_scan", lambda: None)
    with TestClient(server.app) as tc:
        try:
            yield tc
        finally:
            conn = getattr(getattr(server, "meta_db", None), "conn", None)
            if conn is not None:
                conn.close()


def _get(client):
    r = client.get("/api/version")
    assert r.status_code == 200, r.text
    return r.json()


def test_default_urls_when_envs_unset(client, monkeypatch):
    """No env vars set → both URLs are the documented defaults."""
    monkeypatch.delenv("APP_SOURCE_URL", raising=False)
    monkeypatch.delenv("APP_LICENSE_URL", raising=False)
    body = _get(client)
    assert body["source_url"] == DEFAULT_SOURCE_URL
    assert body["license_url"] == DEFAULT_LICENSE_URL
    assert "version" in body


def test_empty_source_url_falls_back_to_default(client, monkeypatch):
    monkeypatch.setenv("APP_SOURCE_URL", "")
    body = _get(client)
    assert body["source_url"] == DEFAULT_SOURCE_URL
    assert body["license_url"] == DEFAULT_LICENSE_URL


def test_whitespace_source_url_falls_back_to_default(client, monkeypatch):
    monkeypatch.setenv("APP_SOURCE_URL", "   \t  ")
    body = _get(client)
    assert body["source_url"] == DEFAULT_SOURCE_URL


def test_configured_source_url_used(client, monkeypatch):
    monkeypatch.setenv("APP_SOURCE_URL", "https://gitlab.example.com/me/fork")
    body = _get(client)
    assert body["source_url"] == "https://gitlab.example.com/me/fork"
    # license_url defaults to the GitHub-style suffix off the configured source
    assert body["license_url"] == "https://gitlab.example.com/me/fork/blob/main/LICENSE"


def test_source_url_trailing_slash_stripped(client, monkeypatch):
    monkeypatch.setenv("APP_SOURCE_URL", "https://example.com/repo/")
    body = _get(client)
    assert body["source_url"] == "https://example.com/repo"
    assert body["license_url"] == "https://example.com/repo/blob/main/LICENSE"


@pytest.mark.parametrize(
    "hostile",
    [
        "javascript:alert(1)",
        "JAVASCRIPT:alert(1)",      # case-insensitive scheme guard
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        "file:///etc/passwd",
        "ftp://example.com/repo",
        "//evil.example.com/repo",  # protocol-relative
        "evil.example.com/repo",    # no scheme
        "https://",                 # http(s) prefix but no host
        "http://",
        "https:///path/only",       # empty host, has path
        "http://:80/path",          # port-only "netloc", empty hostname
        "https://:8080",
    ],
)
def test_non_http_source_url_rejected(client, monkeypatch, hostile):
    """Non-http(s) APP_SOURCE_URL values fall back to the safe default — the
    UI assigns the result straight to `<a href>`, so this is XSS-relevant.
    """
    monkeypatch.setenv("APP_SOURCE_URL", hostile)
    body = _get(client)
    assert body["source_url"] == DEFAULT_SOURCE_URL
    # license_url must follow the (safe) source, never the hostile input
    assert body["license_url"] == DEFAULT_LICENSE_URL


def test_configured_license_url_used(client, monkeypatch):
    """APP_LICENSE_URL overrides the constructed GitHub-style default — for
    non-GitHub hosts or non-`main` default branches.
    """
    monkeypatch.setenv("APP_LICENSE_URL", "https://gitlab.example.com/me/fork/-/blob/trunk/LICENSE")
    body = _get(client)
    assert body["license_url"] == "https://gitlab.example.com/me/fork/-/blob/trunk/LICENSE"


def test_license_url_overrides_independently_of_source_url(client, monkeypatch):
    """When both envs are set, APP_LICENSE_URL wins (doesn't derive from source)."""
    monkeypatch.setenv("APP_SOURCE_URL", "https://example.com/src")
    monkeypatch.setenv("APP_LICENSE_URL", "https://example.org/license.txt")
    body = _get(client)
    assert body["source_url"] == "https://example.com/src"
    assert body["license_url"] == "https://example.org/license.txt"


def test_license_url_trailing_slash_stripped(client, monkeypatch):
    monkeypatch.setenv("APP_LICENSE_URL", "https://example.com/license/")
    body = _get(client)
    assert body["license_url"] == "https://example.com/license"


@pytest.mark.parametrize(
    "hostile",
    [
        "javascript:alert(1)",
        "data:text/html,foo",
        "vbscript:msgbox(1)",
        "file:///etc/passwd",
        "//evil.example.com/license",
        "license.html",   # no scheme
        "https://",       # http(s) prefix but no host
        "http://",
        "https:///path",  # empty host, has path
        "http://:80/path",   # port-only "netloc", empty hostname
        "https://:8080",
    ],
)
def test_non_http_license_url_rejected(client, monkeypatch, hostile):
    monkeypatch.setenv("APP_LICENSE_URL", hostile)
    body = _get(client)
    # Falls back to source_url + /blob/main/LICENSE (the constructed default)
    assert body["license_url"] == DEFAULT_LICENSE_URL


def test_empty_license_url_falls_back_to_constructed(client, monkeypatch):
    monkeypatch.setenv("APP_SOURCE_URL", "https://example.com/repo")
    monkeypatch.setenv("APP_LICENSE_URL", "")
    body = _get(client)
    assert body["license_url"] == "https://example.com/repo/blob/main/LICENSE"
