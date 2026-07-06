"""Pure-function tests for AcoustID fingerprint response parsing + config
gating. No network, no fpcalc binary — server.py owns those seams."""
import acoustid_match as a


def _resp(score=0.97, rec_id="rec-1", title="Highway to Hell", artist="AC/DC",
          rg_title="Highway to Hell", rg_type="Album", secondary=None,
          year=1979, duration=208.4):
    return {
        "status": "ok",
        "results": [{
            "id": "acoustid-uuid",
            "score": score,
            "recordings": [{
                "id": rec_id,
                "title": title,
                "duration": duration,
                "artists": [{"id": "a1", "name": artist}],
                "releasegroups": [{
                    "id": "rg1", "title": rg_title, "type": rg_type,
                    "secondarytypes": secondary or [],
                    "releases": [{"date": {"year": year}}],
                }],
            }],
        }],
    }


def test_parse_maps_the_studio_recording():
    out = a.parse_lookup_response(_resp())
    assert len(out) == 1
    c = out[0]
    assert c["recording_id"] == "rec-1"
    assert c["title"] == "Highway to Hell"
    assert c["artist"] == "AC/DC"
    assert c["album"] == "Highway to Hell"
    assert c["year"] == "1979"
    assert c["duration"] == 208
    assert c["studio"] is True
    assert c["source"] == "acoustid"
    assert c["mb_score"] == 97           # 0.97 → 0..100 confidence band
    assert c["score"] == 0.97


def test_live_release_group_is_not_studio():
    out = a.parse_lookup_response(_resp(rg_type="Album", secondary=["Live"]))
    assert out[0]["studio"] is False


def test_compilation_is_not_studio():
    out = a.parse_lookup_response(_resp(secondary=["Compilation"]))
    assert out[0]["studio"] is False


def test_prefers_studio_group_for_album_display():
    resp = _resp()
    # Add a comp release-group first; the studio one must win the album pick.
    resp["results"][0]["recordings"][0]["releasegroups"].insert(0, {
        "id": "rg0", "title": "Greatest Hits", "type": "Album",
        "secondarytypes": ["Compilation"], "releases": [{"date": {"year": 2000}}],
    })
    c = a.parse_lookup_response(resp)[0]
    assert c["album"] == "Highway to Hell"
    assert c["studio"] is True


def test_earliest_studio_album_wins_over_later_one():
    # Two studio "Album" groups (e.g. a later soundtrack typed Album). The
    # ORIGINAL — earliest release year — must win the album pick, not whichever
    # AcoustID happened to list first. (Real case: "Machine Head" over a later
    # comp for "Smoke on the Water".)
    resp = _resp(rg_title="Machine Head", year=1972)
    resp["results"][0]["recordings"][0]["releasegroups"].insert(0, {
        "id": "rg-late", "title": "Later Studio Album", "type": "Album",
        "secondarytypes": [], "releases": [{"date": {"year": 1997}}],
    })
    c = a.parse_lookup_response(resp)[0]
    assert c["album"] == "Machine Head"
    assert c["year"] == "1972"


def test_year_is_earliest_release_not_a_reissue():
    # A group's first-listed release is often a reissue; the year must be the
    # EARLIEST across the group's releases (real case: British Steel's 1980
    # original, not a 2010 reissue listed first).
    resp = _resp(rg_title="British Steel", year=2010)
    resp["results"][0]["recordings"][0]["releasegroups"][0]["releases"].append(
        {"date": {"year": 1980}})
    c = a.parse_lookup_response(resp)[0]
    assert c["year"] == "1980"


def test_dedupes_recording_across_results():
    resp = _resp()
    resp["results"].append(dict(resp["results"][0]))  # same recording again
    assert len(a.parse_lookup_response(resp)) == 1


def test_non_ok_status_and_garbage_return_empty():
    assert a.parse_lookup_response({"status": "error"}) == []
    assert a.parse_lookup_response({}) == []
    assert a.parse_lookup_response(None) == []
    assert a.parse_lookup_response({"status": "ok", "results": []}) == []


def test_higher_acoustid_score_ranks_first():
    resp = _resp(score=0.55, rec_id="low")
    resp["results"].append(_resp(score=0.99, rec_id="high")["results"][0])
    out = a.parse_lookup_response(resp)
    assert out[0]["recording_id"] == "high"


def test_config_gating(monkeypatch):
    monkeypatch.delenv("ACOUSTID_API_KEY", raising=False)
    assert a.api_key() == ""
    assert a.is_configured() is False
    assert a.is_configured("explicit-key") is True
    monkeypatch.setenv("ACOUSTID_API_KEY", "envkey")
    assert a.api_key() == "envkey"
    assert a.is_configured() is True
