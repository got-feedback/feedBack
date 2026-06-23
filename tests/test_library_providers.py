import importlib
import sys

import pytest
from fastapi.responses import Response
from fastapi.testclient import TestClient


@pytest.fixture()
def server_mod(tmp_path, monkeypatch):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    yield mod
    conn = getattr(getattr(mod, "meta_db", None), "conn", None)
    if conn is not None:
        conn.close()


@pytest.fixture()
def client(server_mod):
    c = TestClient(server_mod.app)
    try:
        yield c
    finally:
        c.close()


def _put(server_mod, filename="local.archive", title="Local Song", artist="Local Artist"):
    server_mod.meta_db.put(filename, 1.0, 1, {
        "title": title,
        "artist": artist,
        "album": "Local Album",
        "year": "2026",
        "duration": 180.0,
        "tuning": "E Standard",
        "arrangements": [{"index": 0, "name": "Lead", "notes": 1}],
        "has_lyrics": True,
        "format": "archive",
        "stem_count": 0,
        "stem_ids": [],
        "tuning_name": "E Standard",
        "tuning_sort_key": 0,
    })


class FakeLibraryProvider:
    id = "remote:frodo"
    label = "Frodo's Library"
    kind = "remote"
    capabilities = ("library.read", "art.read", "song.sync")

    def __init__(self):
        self.page_kwargs = None
        self.artist_kwargs = None
        self.stats_kwargs = None
        self.art_song_id = None
        self.sync_song_id = None

    def query_page(self, **kwargs):
        self.page_kwargs = kwargs
        return ([{
            "filename": "remote-song-id",
            "title": "Remote Song",
            "artist": "Remote Artist",
            "album": "Remote Album",
            "arrangements": [],
            "format": "archive",
        }], 1)

    def query_artists(self, **kwargs):
        self.artist_kwargs = kwargs
        return ([{
            "name": "Remote Artist",
            "album_count": 1,
            "song_count": 1,
            "albums": [{"name": "Remote Album", "songs": []}],
        }], 1)

    def query_stats(self, **kwargs):
        self.stats_kwargs = kwargs
        return {"total_songs": 1, "total_artists": 1, "letters": {"R": 1}}

    def tuning_names(self):
        return {"tunings": [{"name": "E Standard", "sort_key": 0, "count": 1}]}

    def get_art(self, song_id: str):
        self.art_song_id = song_id
        return Response(content=b"fake-art", media_type="image/png")

    def sync_song(self, song_id: str):
        self.sync_song_id = song_id
        return {"ok": True, "filename": "synced.archive", "song_id": song_id}


class ReadOnlyLibraryProvider:
    id = "remote:readonly"
    label = "Readonly Library"
    kind = "remote"
    capabilities = ("library.read",)

    def query_page(self, **kwargs):
        return ([], 0)

    def query_artists(self, **kwargs):
        return ([], 0)

    def query_stats(self, **kwargs):
        return {"total_songs": 0, "total_artists": 0, "letters": {}}

    def tuning_names(self):
        return {"tunings": []}

    def get_art(self, song_id: str):
        raise AssertionError("provider without art.read capability should not be dispatched")

    def sync_song(self, song_id: str):
        raise AssertionError("provider without song.sync capability should not be dispatched")


class NonBrowsableLibraryProvider:
    id = "remote:actions-only"
    label = "Actions Only"
    kind = "remote"
    capabilities = ("art.read", "song.sync")

    def query_page(self, **kwargs):
        raise AssertionError("provider without library.read capability should not be dispatched")

    def query_artists(self, **kwargs):
        raise AssertionError("provider without library.read capability should not be dispatched")

    def query_stats(self, **kwargs):
        raise AssertionError("provider without library.read capability should not be dispatched")

    def tuning_names(self):
        raise AssertionError("provider without library.read capability should not be dispatched")

    def get_art(self, song_id: str):
        raise AssertionError("get_art should not be dispatched in this test")

    def sync_song(self, song_id: str):
        raise AssertionError("sync_song should not be dispatched in this test")


def test_local_provider_is_default_library_provider(server_mod, client):
    _put(server_mod)

    providers = client.get("/api/library/providers").json()["providers"]
    local = next(provider for provider in providers if provider["id"] == "local")
    assert local["label"] == "My Library"
    assert local["kind"] == "local"
    assert local["default"] is True
    assert "library.read" in local["capabilities"]

    default_payload = client.get("/api/library").json()
    explicit_payload = client.get("/api/library", params={"provider": "local"}).json()
    assert default_payload == explicit_payload
    assert default_payload["songs"][0]["filename"] == "local.archive"


def test_registered_provider_handles_library_endpoints(server_mod, client):
    provider = FakeLibraryProvider()
    server_mod.register_library_provider(provider)

    providers = client.get("/api/library/providers").json()["providers"]
    remote = next(item for item in providers if item["id"] == "remote:frodo")
    assert remote["label"] == "Frodo's Library"
    assert remote["kind"] == "remote"
    assert remote["default"] is False
    assert remote["capabilities"] == ["art.read", "library.read", "song.sync"]

    songs = client.get("/api/library", params={
        "provider": "remote:frodo",
        "q": "needle",
        "page": "2",
        "size": "12",
        "sort": "title-desc",
        "dir": "desc",
        "format": "archive",
        "favorites": "1",
        "arrangements_has": "Lead,Rhythm",
        "has_lyrics": "1",
        "tunings": "E Standard,Drop D",
    }).json()
    assert songs["total"] == 1
    assert songs["songs"][0]["title"] == "Remote Song"
    assert provider.page_kwargs["q"] == "needle"
    assert provider.page_kwargs["page"] == 2
    assert provider.page_kwargs["size"] == 12
    assert provider.page_kwargs["sort"] == "title-desc"
    assert provider.page_kwargs["direction"] == "desc"
    assert provider.page_kwargs["favorites_only"] is True
    assert provider.page_kwargs["format_filter"] == "archive"
    assert provider.page_kwargs["arrangements_has"] == ["Lead", "Rhythm"]
    assert provider.page_kwargs["has_lyrics"] == 1
    assert provider.page_kwargs["tunings"] == ["E Standard", "Drop D"]

    artists = client.get("/api/library/artists", params={
        "provider": "remote:frodo",
        "letter": "R",
        "page": "1",
        "size": "5",
    }).json()
    assert artists["total_artists"] == 1
    assert provider.artist_kwargs["letter"] == "R"
    assert provider.artist_kwargs["page"] == 1
    assert provider.artist_kwargs["size"] == 5
    assert "sort" not in provider.artist_kwargs

    stats = client.get("/api/library/stats", params={"provider": "remote:frodo"}).json()
    assert stats["letters"] == {"R": 1}
    assert "page" not in provider.stats_kwargs
    assert "size" not in provider.stats_kwargs
    assert "sort" not in provider.stats_kwargs

    tunings = client.get("/api/library/tuning-names", params={"provider": "remote:frodo"}).json()
    assert tunings["tunings"][0]["name"] == "E Standard"

    art = client.get("/api/library/providers/remote:frodo/songs/remote-song-id/art")
    assert art.status_code == 200
    assert art.content == b"fake-art"
    assert art.headers["content-type"].startswith("image/png")
    assert provider.art_song_id == "remote-song-id"

    synced = client.post("/api/library/providers/remote:frodo/songs/remote-song-id/sync").json()
    assert synced == {"ok": True, "filename": "synced.archive", "song_id": "remote-song-id"}
    assert provider.sync_song_id == "remote-song-id"


def test_unknown_library_provider_returns_404(server_mod, client):
    response = client.get("/api/library", params={"provider": "missing"})
    assert response.status_code == 404
    assert "Unknown library provider" in response.json()["detail"]


def test_provider_art_and_sync_report_unsupported_when_missing(server_mod, client):
    server_mod.register_library_provider(ReadOnlyLibraryProvider())

    art = client.get("/api/library/providers/remote:readonly/songs/remote-song-id/art")
    assert art.status_code == 501
    assert "does not declare capability 'art.read'" in art.json()["detail"]

    synced = client.post("/api/library/providers/remote:readonly/songs/remote-song-id/sync")
    assert synced.status_code == 501
    assert "does not declare capability 'song.sync'" in synced.json()["detail"]


def test_library_read_endpoints_require_library_read_capability(server_mod, client):
    server_mod.register_library_provider(NonBrowsableLibraryProvider())

    responses = [
        client.get("/api/library", params={"provider": "remote:actions-only"}),
        client.get("/api/library/artists", params={"provider": "remote:actions-only"}),
        client.get("/api/library/stats", params={"provider": "remote:actions-only"}),
        client.get("/api/library/tuning-names", params={"provider": "remote:actions-only"}),
    ]
    for response in responses:
        assert response.status_code == 501
        assert "does not declare capability 'library.read'" in response.json()["detail"]


def test_local_library_provider_cannot_be_replaced(server_mod):
    provider = FakeLibraryProvider()
    provider.id = "local"
    provider.label = "Not Actually Local"

    try:
        server_mod.register_library_provider(provider, replace=True)
    except ValueError as exc:
        assert "local library provider cannot be replaced" in str(exc)
    else:
        raise AssertionError("expected replacing the local provider to fail")


def test_library_provider_registration_is_available_to_plugins(tmp_path, monkeypatch):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")

    captured = {}

    def _capturing_load_plugins(app, context, **kwargs):
        captured.update(context)

    monkeypatch.setattr(server, "load_plugins", _capturing_load_plugins)
    monkeypatch.setattr(server, "startup_scan", lambda: None)

    conn = getattr(getattr(server, "meta_db", None), "conn", None)
    try:
        with TestClient(server.app):
            assert captured["library_providers"] is server.library_providers
            assert captured["register_library_provider"] is server.register_library_provider
            assert captured["unregister_library_provider"] is server.unregister_library_provider
    finally:
        if conn is not None:
            conn.close()
