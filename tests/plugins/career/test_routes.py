"""HTTP-level tests for the career plugin: stars, unlocks, packs."""

import hashlib
import json
import zipfile

import routes as career_routes


def _install_fake_pack(venue_id, files=None):
    """Drop a valid installed pack into the plugin's venues dir."""
    pack_dir = career_routes._venue_dir(venue_id)
    pack_dir.mkdir(parents=True, exist_ok=True)
    loops = {s: f"{s}.mp4" for s in career_routes.REQUIRED_LOOPS}
    (pack_dir / "manifest.json").write_text(json.dumps(
        {"venue": venue_id, "version": 1, "loops": loops,
         "stingers": {"clap": "clap.mp4", "cheer": "cheer.mp4"}}))
    for name in list(loops.values()) + ["clap.mp4", "cheer.mp4"]:
        (pack_dir / name).write_bytes((files or {}).get(name, b"\x00video"))


def test_stars_from_best_accuracy_across_arrangements(client, meta_db):
    # Thresholds 0.6/0.75/0.85 → 1/2/3 stars; best arrangement wins.
    meta_db.add("a.feedpak", "guitar", 0.5)    # 0 stars
    meta_db.add("b.feedpak", "guitar", 0.62)   # 1 star
    meta_db.add("c.feedpak", "guitar", 0.70)
    meta_db.add("c.feedpak", "bass", 0.80)     # 2 stars (max across arrangements)
    meta_db.add("d.feedpak", "guitar", 0.99)   # 3 stars
    state = client.get("/api/plugins/career/state").json()
    assert state["stars_total"] == 6
    assert state["stars_per_song"] == {"b.feedpak": 1, "c.feedpak": 2, "d.feedpak": 3}


def test_unlock_flags_follow_thresholds(client, meta_db):
    # 6 stars: bar (0) unlocked, club (50) and arena (150) locked.
    for i in range(2):
        meta_db.add(f"s{i}.feedpak", "guitar", 0.9)  # 3 stars each
    state = client.get("/api/plugins/career/state").json()
    by_id = {v["id"]: v for v in state["venues"]}
    assert by_id["bar"]["unlocked"] is True
    assert by_id["club"]["unlocked"] is False
    assert by_id["arena"]["unlocked"] is False


def test_orphaned_stats_do_not_count(client, meta_db):
    # A song removed from the library (stats row survives the scan) must not
    # keep contributing stars.
    meta_db.add("gone.feedpak", "guitar", 0.99, in_library=False)
    meta_db.add("here.feedpak", "guitar", 0.99)
    state = client.get("/api/plugins/career/state").json()
    assert state["stars_total"] == 3
    assert "gone.feedpak" not in state["stars_per_song"]


def test_star_detail_rows_sorted_by_next_star_gap(client, meta_db):
    meta_db.add("far.feedpak", "guitar", 0.61)    # 1★, 14% from next
    meta_db.add("close.feedpak", "guitar", 0.84)  # 2★, 1% from next
    meta_db.add("maxed.feedpak", "guitar", 0.99)  # 3★, maxed
    detail = client.get("/api/plugins/career/state").json()["star_detail"]
    assert [r["filename"] for r in detail] == \
        ["close.feedpak", "far.feedpak", "maxed.feedpak"]
    close = detail[0]
    assert close["stars"] == 2 and close["next_star_at"] == 0.85
    assert detail[2]["next_star_at"] is None


def test_no_stats_still_serves_state(client):
    state = client.get("/api/plugins/career/state").json()
    assert state["stars_total"] == 0
    assert state["venues"][0]["unlocked"] is True  # bar is always open


def test_download_unknown_venue_404s(client):
    assert client.post("/api/plugins/career/packs/nope/download").status_code == 404
    assert client.post("/api/plugins/career/packs/../etc/download").status_code == 404


def test_download_without_published_pack_404s(client):
    # Bundled packs are already installed; download still requires a published
    # remote pack entry.
    assert client.post("/api/plugins/career/packs/bar/download").status_code == 404


def test_download_locked_venue_403s(client, monkeypatch):
    club = career_routes._venue("club")
    monkeypatch.setitem(club, "pack", {"url": "http://x/pack.zip", "sha256": "0" * 64})
    assert client.post("/api/plugins/career/packs/club/download").status_code == 403


def test_bundled_bar_pack_is_installed_and_served(client):
    state = client.get("/api/plugins/career/state").json()
    bar = {v["id"]: v for v in state["venues"]}["bar"]
    assert bar["installed"] is True
    assert bar["bundled"] is True
    assert bar["has_pack"] is True

    ok = client.get("/api/plugins/career/venues/bar/manifest.json")
    assert ok.status_code == 200
    manifest = ok.json()
    assert manifest["loops"]["ecstatic"] == "ecstatic.mp4"
    assert manifest["intro"] == {"video": "intro.mp4", "audio": "bar-ambience.mp3"}
    assert client.get("/api/plugins/career/venues/bar/intro.mp4").status_code == 200
    audio = client.get("/api/plugins/career/venues/bar/bar-ambience.mp3")
    assert audio.status_code == 200
    assert audio.headers["content-type"].startswith("audio/mpeg")


def test_pack_file_serving_and_traversal_guard(client):
    _install_fake_pack("club")
    ok = client.get("/api/plugins/career/venues/club/manifest.json")
    assert ok.status_code == 200
    assert ok.json()["loops"]["ecstatic"] == "ecstatic.mp4"
    video = client.get("/api/plugins/career/venues/club/bored.mp4")
    assert video.status_code == 200
    assert video.headers["content-type"].startswith("video/mp4")
    assert video.headers["x-content-type-options"] == "nosniff"
    # Traversal / junk shapes never resolve.
    for bad in ("../manifest.json", "..%2Fmanifest.json", "x.sh", "MANIFEST.JSON"):
        assert client.get(f"/api/plugins/career/venues/club/{bad}").status_code == 404
    assert client.get("/api/plugins/career/venues/../club/manifest.json").status_code == 404


def test_state_reports_installed_and_delete_removes(client):
    # All three venues now ship bundled, so deleting the downloaded copy
    # falls back to the bundled pack: installed stays True by design
    # (downloaded packs override bundled ones, never replace them).
    _install_fake_pack("club")
    state = client.get("/api/plugins/career/state").json()
    assert {v["id"]: v["installed"] for v in state["venues"]}["club"] is True
    assert client.delete("/api/plugins/career/packs/club").status_code == 200
    state = client.get("/api/plugins/career/state").json()
    assert {v["id"]: v["installed"] for v in state["venues"]}["club"] is True
    # the downloaded override itself is gone
    assert not (career_routes._venue_dir("club") / "manifest.json").exists()


def test_download_worker_end_to_end(client, tmp_path):
    # Build a real pack zip, serve it via file://, verify the full worker path:
    # stream → sha256 → extract (flat names only) → validate → swap in.
    src = tmp_path / "src"
    src.mkdir()
    names = [f"{s}.mp4" for s in career_routes.REQUIRED_LOOPS] + ["cheer.mp4"]
    for name in names:
        (src / name).write_bytes(b"fake-video-" + name.encode())
    (src / "manifest.json").write_text(json.dumps({
        "venue": "bar", "version": 1,
        "loops": {s: f"{s}.mp4" for s in career_routes.REQUIRED_LOOPS},
        "stingers": {"cheer": "cheer.mp4"},
    }))
    zip_path = tmp_path / "bar-pack.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        for p in src.iterdir():
            zf.write(p, p.name)
    sha = hashlib.sha256(zip_path.read_bytes()).hexdigest()

    progress = {"status": "running", "bytes_done": 0, "bytes_total": 0, "error": None}
    career_routes._download_pack(
        "bar", {"url": zip_path.as_uri(), "sha256": sha}, progress)
    assert progress["status"] == "done", progress["error"]
    assert career_routes._installed("bar")
    assert progress["bytes_done"] == zip_path.stat().st_size

    # Corrupt hash → error status, nothing installed over the good pack.
    bad = {"status": "running", "bytes_done": 0, "bytes_total": 0, "error": None}
    career_routes._download_pack("bar", {"url": zip_path.as_uri(), "sha256": "0" * 64}, bad)
    assert bad["status"] == "error"
    assert "sha256" in bad["error"]


def test_double_download_409s(client, monkeypatch):
    bar = career_routes._venue("bar")
    monkeypatch.setitem(bar, "pack", {"url": "http://x/pack.zip", "sha256": "0" * 64})
    # Pretend one is already running.
    career_routes._state["downloads"]["bar"] = {"status": "running"}
    assert client.post("/api/plugins/career/packs/bar/download").status_code == 409
    assert client.delete("/api/plugins/career/packs/bar").status_code == 409


# ── gig pre-extraction (the wait between songs) ─────────────────────────────
#
# A feedpak is a zip: the first play of one pays for its extraction into
# sloppak_cache. Inside a set that cost landed BETWEEN songs — the player
# finished a number and then sat waiting for the next one to unpack, mid-gig.
# The setlist is known up front, so extract it all while the poster is up.

def _career_client_with_library(tmp_path, meta_db, dlc, cache):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import routes as career_routes
    app = FastAPI()
    career_routes.setup(app, {
        "config_dir": str(tmp_path),
        "meta_db": meta_db,
        "get_dlc_dir": lambda: dlc,
        "get_sloppak_cache_dir": lambda: cache,
    })
    return TestClient(app)


def _write_feedpak(dlc, name, title="T"):
    """A minimal but REAL feedpak zip, so resolve_source_dir genuinely unpacks."""
    import json as _json
    import zipfile as _zip
    p = dlc / name
    with _zip.ZipFile(p, "w") as z:
        z.writestr("manifest.json", _json.dumps({"title": title, "artist": "A", "arrangements": []}))
    return p


def test_gig_prepare_extracts_every_song_up_front(tmp_path, meta_db):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    cache = tmp_path / "cache"
    cache.mkdir()
    for n in ("one.feedpak", "two.feedpak", "three.feedpak"):
        _write_feedpak(dlc, n)

    client = _career_client_with_library(tmp_path, meta_db, dlc, cache)
    before = list(cache.iterdir())
    assert before == [], "nothing unpacked yet"

    res = client.post("/api/plugins/career/gigs/prepare",
                      json={"songs": ["one.feedpak", "two.feedpak", "three.feedpak"]})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["prepared"] == 3, body
    assert body["failed"] == []
    # The point of the whole exercise: the set is on disk BEFORE the first note.
    assert len(list(cache.iterdir())) == 3, "every song of the set must be unpacked"


def test_gig_prepare_is_idempotent_on_a_warm_cache(tmp_path, meta_db):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    cache = tmp_path / "cache"
    cache.mkdir()
    _write_feedpak(dlc, "one.feedpak")
    client = _career_client_with_library(tmp_path, meta_db, dlc, cache)

    first = client.post("/api/plugins/career/gigs/prepare", json={"songs": ["one.feedpak"]}).json()
    second = client.post("/api/plugins/career/gigs/prepare", json={"songs": ["one.feedpak"]}).json()
    assert first["prepared"] == second["prepared"] == 1
    assert len(list(cache.iterdir())) == 1, "a re-prepare must not duplicate the unpack"


def test_one_bad_feedpak_does_not_stop_the_set(tmp_path, meta_db):
    # A corrupt pak in the setlist must not block the gig: the play itself will
    # surface the error exactly as it does outside a gig. Slow beats blocked.
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    cache = tmp_path / "cache"
    cache.mkdir()
    _write_feedpak(dlc, "good.feedpak")
    (dlc / "bad.feedpak").write_bytes(b"not a zip at all")

    client = _career_client_with_library(tmp_path, meta_db, dlc, cache)
    body = client.post("/api/plugins/career/gigs/prepare",
                       json={"songs": ["good.feedpak", "bad.feedpak"]}).json()
    assert body["ok"] is True, "a bad pak must not fail the whole prepare"
    assert body["prepared"] == 1
    assert body["failed"] == ["bad.feedpak"]


def test_gig_prepare_degrades_without_a_library(tmp_path, meta_db, client):
    # The stock fixture's context has no dlc/cache resolvers. That must be a
    # graceful no-op, not a 500 — pre-extraction is an optimisation and can
    # never be the reason a gig won't start.
    res = client.post("/api/plugins/career/gigs/prepare", json={"songs": ["x.feedpak"]})
    assert res.status_code == 200
    assert res.json()["prepared"] == 0


def test_gig_prepare_empty_setlist(tmp_path, meta_db, client):
    res = client.post("/api/plugins/career/gigs/prepare", json={"songs": []})
    assert res.status_code == 200
    assert res.json() == {"ok": True, "prepared": 0, "failed": []}


def test_prepare_rejects_a_non_list_songs_value(tmp_path, meta_db, client):
    # A str is iterable: without the list check, "abc" would prepare three
    # one-character "songs".
    for bad in ("abc", 42, {"a": 1}, None):
        res = client.post("/api/plugins/career/gigs/prepare", json={"songs": bad})
        assert res.status_code == 200
        assert res.json()["prepared"] == 0


def test_prepare_ignores_non_string_and_blank_entries(tmp_path, meta_db):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    cache = tmp_path / "cache"
    cache.mkdir()
    _write_feedpak(dlc, "good.feedpak")
    client = _career_client_with_library(tmp_path, meta_db, dlc, cache)
    body = client.post("/api/plugins/career/gigs/prepare",
                       json={"songs": ["good.feedpak", "", "   ", 7, None, {"x": 1}]}).json()
    assert body["prepared"] == 1
    assert body["failed"] == []


def test_prepare_caps_the_setlist(tmp_path, meta_db):
    # This endpoint unpacks zips — an arbitrary caller must not be able to ask for
    # unbounded work.
    #
    # The first version of this test asserted `prepared == 0` against a fixture
    # with NO library: the endpoint exits before extraction there, so it passed
    # whether or not the cap existed. Give it a real library, ask for far more than
    # the cap, and assert the endpoint only ever considered MAX_GIG_SONGS of them.
    import routes as career_routes
    assert career_routes.MAX_GIG_SONGS <= 64

    dlc = tmp_path / "dlc"
    dlc.mkdir()
    cache = tmp_path / "cache"
    cache.mkdir()
    client = _career_client_with_library(tmp_path, meta_db, dlc, cache)

    n = career_routes.MAX_GIG_SONGS + 50
    # None of these exist, so every song the endpoint LOOKS AT lands in `failed`.
    # That makes `failed` an exact count of how many it considered.
    body = client.post("/api/plugins/career/gigs/prepare",
                       json={"songs": [f"missing{i}.feedpak" for i in range(n)]}).json()
    assert body["prepared"] == 0
    assert len(body["failed"]) == career_routes.MAX_GIG_SONGS, (
        f"the endpoint must consider at most MAX_GIG_SONGS "
        f"({career_routes.MAX_GIG_SONGS}), not all {n}"
    )


def test_prepare_refuses_to_escape_the_library(tmp_path, meta_db):
    # resolve_source_dir() does a bare `dlc_root / filename` with no containment
    # guard, so a crafted path would walk straight out of the library. Every
    # filename must go through _resolve_dlc_path first.
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    cache = tmp_path / "cache"
    cache.mkdir()
    (tmp_path / "outside.feedpak").write_bytes(b"secret")
    client = _career_client_with_library(tmp_path, meta_db, dlc, cache)

    for evil in ("../outside.feedpak", "..\\outside.feedpak",
                 "a/../../outside.feedpak", "/etc/passwd", "C:/Windows/x.feedpak"):
        body = client.post("/api/plugins/career/gigs/prepare",
                           json={"songs": [evil]}).json()
        assert body["prepared"] == 0, f"{evil!r} must never be prepared"
        assert body["failed"] == [evil]
    # Nothing outside the library may have been unpacked.
    assert list(cache.iterdir()) == []
