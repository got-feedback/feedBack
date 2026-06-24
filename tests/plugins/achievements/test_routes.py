"""HTTP-level tests for the achievements engine, incl. the integration law."""


def test_catalog_ships_baseline(client):
    data = client.get("/api/plugins/achievements/catalog").json()
    assert "baseline" in data
    ids = [d["id"] for d in data["baseline"].get("global", [])]
    assert "first_steps" in ids and "ascendant" in ids


def test_activity_unlocks_feat_and_appears_on_shelf(client):
    # 100k notes in one shot crosses notes_total tier 0 (Note Hunter).
    res = client.post("/api/plugins/achievements/activity", json={"notes": 100000}).json()
    assert res["ok"] is True
    unlocked_ids = [u["id"] for u in res["unlocked"]]
    assert "notes_total" in unlocked_ids
    # And it shows on the Feats shelf.
    feats = client.get("/api/plugins/achievements/feats").json()["feats"]
    assert any(f["id"] == "notes_total" for f in feats)


def test_activity_below_threshold_unlocks_nothing(client):
    res = client.post("/api/plugins/achievements/activity", json={"notes": 50000}).json()
    assert res["unlocked"] == []
    assert client.get("/api/plugins/achievements/feats").json()["feats"] == []


def test_integration_law_competency_never_on_feat_shelf(client):
    # A competency unlock reported by a source must NEVER appear among Feats.
    client.post("/api/plugins/achievements/report-unlock", json={
        "id": "tempo_push", "kind": "achievement", "category": "guitar", "sourceId": "virtuoso"})
    feats = client.get("/api/plugins/achievements/feats").json()["feats"]
    assert all(f["id"] != "tempo_push" for f in feats)
    # But it is earned (competency class).
    earned = client.get("/api/plugins/achievements/earned").json()["earned"]
    rec = [e for e in earned if e["id"] == "tempo_push"]
    assert rec and rec[0]["cls"] == "competency"


def test_report_unlock_is_idempotent_and_tier_monotonic(client):
    body = {"id": "ascendant", "kind": "achievement", "category": "global", "tier": 1}
    first = client.post("/api/plugins/achievements/report-unlock", json=body).json()
    assert first["changed"] is True
    # Same tier again → no change.
    again = client.post("/api/plugins/achievements/report-unlock", json=body).json()
    assert again["changed"] is False
    # Lower tier → still no change (monotonic).
    lower = client.post("/api/plugins/achievements/report-unlock",
                        json={**body, "tier": 0}).json()
    assert lower["changed"] is False
    # Higher tier → advances.
    higher = client.post("/api/plugins/achievements/report-unlock",
                         json={**body, "tier": 2}).json()
    assert higher["changed"] is True


def test_witching_feat_unlocks_on_seventh_consecutive_night(client):
    # Regression: the derived witching_nights_run counter must NOT be pre-written
    # before the prev snapshot, or diff_unlocks never sees the fresh unlock.
    unlocked_ever = []
    for day in range(1, 8):
        res = client.post("/api/plugins/achievements/activity",
                          json={"night_session": True, "night_date": "2026-06-%02d" % day}).json()
        unlocked_ever += [u["id"] for u in res["unlocked"]]
    assert "secret_witching" in unlocked_ever, "witching feat never reported as unlocked"
    feats = [f["id"] for f in client.get("/api/plugins/achievements/feats").json()["feats"]]
    assert "secret_witching" in feats


def test_witching_not_unlocked_before_seven(client):
    for day in range(1, 7):  # only 6 nights
        client.post("/api/plugins/achievements/activity",
                    json={"night_session": True, "night_date": "2026-06-%02d" % day})
    feats = [f["id"] for f in client.get("/api/plugins/achievements/feats").json()["feats"]]
    assert "secret_witching" not in feats


def test_chart_key_is_stable_not_builtin_hash(client):
    import hashlib
    import routes
    # Deterministic across processes (sha1-based), unlike the salted builtin hash().
    assert routes._chart_key("song.sloppak") == "chart_plays:" + hashlib.sha1(b"song.sloppak").hexdigest()[:16]
    assert routes._chart_key("a") != routes._chart_key("b")


def test_report_criterion_counts_distinct(client):
    url = "/api/plugins/achievements/report-criterion"
    assert client.post(url, json={"criterion_id": "x", "token": "a"}).json()["count"] == 1
    assert client.post(url, json={"criterion_id": "x", "token": "a"}).json()["count"] == 1  # dup
    assert client.post(url, json={"criterion_id": "x", "token": "b"}).json()["count"] == 2
