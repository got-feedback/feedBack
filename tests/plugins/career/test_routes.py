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
    # venues.json ships pack: null until packs are released.
    assert client.post("/api/plugins/career/packs/bar/download").status_code == 404


def test_download_locked_venue_403s(client, monkeypatch):
    club = career_routes._venue("club")
    monkeypatch.setitem(club, "pack", {"url": "http://x/pack.zip", "sha256": "0" * 64})
    assert client.post("/api/plugins/career/packs/club/download").status_code == 403


def test_pack_file_serving_and_traversal_guard(client):
    _install_fake_pack("bar")
    ok = client.get("/api/plugins/career/venues/bar/manifest.json")
    assert ok.status_code == 200
    assert ok.json()["loops"]["ecstatic"] == "ecstatic.mp4"
    video = client.get("/api/plugins/career/venues/bar/bored.mp4")
    assert video.status_code == 200
    assert video.headers["content-type"].startswith("video/mp4")
    assert video.headers["x-content-type-options"] == "nosniff"
    # Traversal / junk shapes never resolve.
    for bad in ("../manifest.json", "..%2Fmanifest.json", "x.sh", "MANIFEST.JSON"):
        assert client.get(f"/api/plugins/career/venues/bar/{bad}").status_code == 404
    assert client.get("/api/plugins/career/venues/../bar/manifest.json").status_code == 404


def test_state_reports_installed_and_delete_removes(client):
    _install_fake_pack("bar")
    state = client.get("/api/plugins/career/state").json()
    assert {v["id"]: v["installed"] for v in state["venues"]}["bar"] is True
    assert client.delete("/api/plugins/career/packs/bar").status_code == 200
    state = client.get("/api/plugins/career/state").json()
    assert {v["id"]: v["installed"] for v in state["venues"]}["bar"] is False


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
