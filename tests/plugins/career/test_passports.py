"""HTTP-level tests for the passport layer: badges, stubs, genres, drill intake.

Badges are computed on read (never stored): N genre songs at min_stars — with
stars ≥2 meaning best_accuracy ≥ 0.75 under the default 0.6/0.75/0.85
thresholds — plus any configured virtuoso drills.
"""

import routes as career_routes

LEAD = [{"type": "lead", "name": "Lead"}]
BASS = [{"type": "bass", "name": "Bass"}]


def _open(client, instrument="guitar", genre="Blues"):
    res = client.post("/api/plugins/career/passports/open",
                      json={"instrument": instrument, "genre": genre})
    assert res.status_code == 200
    return res.json()


def _passport(client, instrument="guitar", genre_key="blues"):
    view = client.get("/api/plugins/career/passports").json()
    for p in view["instruments"][instrument]["passports"]:
        if p["genre_key"] == genre_key:
            return p
    return None


def test_badge_earned_at_five_genre_songs_two_stars(client, meta_db):
    for i in range(5):
        meta_db.add(f"blues{i}.feedpak", 0, 0.8, genre="Blues", arrangements=LEAD)
    _open(client)
    p = _passport(client)
    assert p["badge"] == "earned"
    assert p["qualifying_count"] == 5
    assert all(s["qualifies"] and s["stars"] == 2 for s in p["songs"])


def test_badge_in_progress_below_the_bar(client, meta_db):
    for i in range(4):
        meta_db.add(f"blues{i}.feedpak", 0, 0.8, genre="Blues", arrangements=LEAD)
    meta_db.add("weak.feedpak", 0, 0.65, genre="Blues", arrangements=LEAD)  # 1★
    _open(client)
    p = _passport(client)
    assert p["badge"] == "in_progress"
    assert p["qualifying_count"] == 4
    # Qualifying stubs sort ahead of the near-misses.
    assert [s["qualifies"] for s in p["songs"]] == [True] * 4 + [False]


def test_instruments_split_and_bass_is_shown_not_judged(client, meta_db):
    # Same 5 songs but played on the BASS arrangement: no guitar badge credit.
    for i in range(5):
        meta_db.add(f"blues{i}.feedpak", 0, 0.9, genre="Blues", arrangements=BASS)
    _open(client, "guitar")
    _open(client, "bass")
    guitar = _passport(client, "guitar")
    bass = _passport(client, "bass")
    assert guitar["qualifying_count"] == 0 and guitar["badge"] == "in_progress"
    assert bass["qualifying_count"] == 5
    # Bass isn't a graded instrument: repertoire shows, no pass/fail bar.
    assert bass["badge"] == "shown_not_judged" and bass["graded"] is False


def test_best_accuracy_per_instrument_across_arrangements(client, meta_db):
    both = [{"type": "lead", "name": "Lead"}, {"type": "lead", "name": "Alt. Lead"}]
    meta_db.add("song.feedpak", 0, 0.7, genre="Blues", arrangements=both)
    meta_db.add("song.feedpak", 1, 0.9, genre="Blues", arrangements=both)
    _open(client)
    p = _passport(client)
    assert len(p["songs"]) == 1
    assert p["songs"][0]["best_accuracy"] == 0.9
    assert p["songs"][0]["stars"] == 3


def test_orphaned_songs_do_not_feed_stubs(client, meta_db):
    meta_db.add("gone.feedpak", 0, 0.9, genre="Blues", arrangements=LEAD,
                in_library=False)
    _open(client)
    assert _passport(client)["songs"] == []


def test_genre_rack_collapses_case_and_skips_blank(client, meta_db):
    meta_db.add_song_only("a.feedpak", genre="Blues")
    meta_db.add_song_only("b.feedpak", genre="blues")
    meta_db.add_song_only("c.feedpak", genre="Funk")
    meta_db.add_song_only("d.feedpak", genre="")
    genres = client.get("/api/plugins/career/passports").json()["genres"]
    assert genres == [
        {"genre_key": "blues", "genre": "Blues", "songs_in_library": 2},
        {"genre_key": "funk", "genre": "Funk", "songs_in_library": 1},
    ]


def test_commit_is_idempotent_and_open_implies_commit(client):
    first = client.post("/api/plugins/career/passports/commit",
                        json={"instrument": "guitar"}).json()
    again = client.post("/api/plugins/career/passports/commit",
                        json={"instrument": "guitar"}).json()
    assert first["committed_at"] == again["committed_at"]
    _open(client, "bass", "Funk")
    view = client.get("/api/plugins/career/passports").json()
    assert view["instruments"]["bass"]["committed_at"]
    # Re-opening the same passport keeps the original opened_at.
    opened = view["instruments"]["bass"]["passports"][0]["opened_at"]
    _open(client, "bass", "  funk ")  # normalizes to the same key
    view = client.get("/api/plugins/career/passports").json()
    assert [p["opened_at"] for p in view["instruments"]["bass"]["passports"]] == [opened]


def test_open_and_commit_validation(client):
    assert client.post("/api/plugins/career/passports/commit",
                       json={"instrument": "theremin"}).status_code == 400
    assert client.post("/api/plugins/career/passports/open",
                       json={"instrument": "guitar", "genre": "  "}).status_code == 400
    assert client.post("/api/plugins/career/passports/open",
                       json={"instrument": "guitar", "genre": "x" * 65}).status_code == 400


def test_drill_requirement_gates_badge_until_snapshot_clears_it(client, meta_db):
    for i in range(5):
        meta_db.add(f"blues{i}.feedpak", 0, 0.8, genre="Blues", arrangements=LEAD)
    career_routes._state["passports_content"]["genres"]["blues"] = {
        "virtuoso_nodes": ["node.shuffle"]}
    _open(client)
    p = _passport(client)
    assert p["badge"] == "in_progress"
    assert p["drills"] == {"required": ["node.shuffle"], "cleared": []}

    res = client.post("/api/plugins/career/drill-state", json={
        "mode": "casual", "xp": 120,
        "byNode": {"node.shuffle": {"masteredAt": 1720000000,
                                    "depth": {"travel": None}}}})
    assert res.status_code == 200
    p = _passport(client)
    assert p["drills"]["cleared"] == ["node.shuffle"]
    assert p["badge"] == "earned"


def test_drill_state_validation(client):
    assert client.post("/api/plugins/career/drill-state",
                       json={"mode": "casual"}).status_code == 400
    huge = {"byNode": {"pad": "x" * (300 * 1024)}}
    assert client.post("/api/plugins/career/drill-state",
                       json=huge).status_code == 413
