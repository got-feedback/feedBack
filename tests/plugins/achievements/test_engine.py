"""Pure-helper unit tests for the achievements engine (no IO, P-V)."""

import engine


class TestTierIndexFor:
    def test_below_first_tier(self):
        assert engine.tier_index_for([100000, 1000000], 50000) == -1

    def test_exact_threshold(self):
        assert engine.tier_index_for([100000, 1000000], 100000) == 0

    def test_highest_reached(self):
        assert engine.tier_index_for([100000, 1000000, 10000000], 2000000) == 1

    def test_all_tiers(self):
        assert engine.tier_index_for([100, 500], 9999) == 1

    def test_empty_tiers(self):
        assert engine.tier_index_for([], 10) == -1


class TestApplyActivity:
    def test_cumulative_adds(self):
        c = engine.apply_activity({}, {"notes": 10, "song_done": 1, "seconds": 30})
        assert c["notes_total"] == 10
        assert c["songs_done"] == 1
        assert c["time_total_seconds"] == 30
        c = engine.apply_activity(c, {"notes": 5, "song_done": 1, "seconds": 20})
        assert c["notes_total"] == 15
        assert c["songs_done"] == 2
        assert c["time_total_seconds"] == 50

    def test_max_counters_take_maximum(self):
        c = engine.apply_activity({}, {"session_notes": 100, "in_song_streak": 40})
        c = engine.apply_activity(c, {"session_notes": 60, "in_song_streak": 90})
        assert c["notes_session_max"] == 100
        assert c["streak_insong_max"] == 90

    def test_chart_encore_only_when_present(self):
        c = engine.apply_activity({}, {"notes": 1})
        assert "chart_encore_max" not in c
        c = engine.apply_activity(c, {"chart_play_count": 7})
        assert c["chart_encore_max"] == 7

    def test_is_pure(self):
        before = {"notes_total": 5}
        engine.apply_activity(before, {"notes": 100})
        assert before == {"notes_total": 5}  # input unmutated


class TestEvaluateFeats:
    FEATS = [
        {"id": "notes_total", "counter": "notes_total", "tiers": [100000, 1000000]},
        {"id": "songs_done", "counter": "songs_done", "tiers": [1000, 5000]},
        {"id": "secret_combo", "counter": None, "tiers": []},
    ]

    def test_unmet_omitted(self):
        assert engine.evaluate_feats(self.FEATS, {"notes_total": 50000}) == {}

    def test_met_tier(self):
        out = engine.evaluate_feats(self.FEATS, {"notes_total": 2000000, "songs_done": 1200})
        assert out == {"notes_total": 1, "songs_done": 0}

    def test_no_counter_feat_never_auto_unlocks(self):
        out = engine.evaluate_feats(self.FEATS, {"notes_total": 99999999})
        assert "secret_combo" not in out


class TestDiffUnlocks:
    def test_first_unlock(self):
        assert engine.diff_unlocks({}, {"a": 0}) == ["a"]

    def test_tier_advance(self):
        assert engine.diff_unlocks({"a": 0}, {"a": 1}) == ["a"]

    def test_no_change(self):
        assert engine.diff_unlocks({"a": 1}, {"a": 1}) == []


class TestConsecutiveRun:
    def test_seven_consecutive(self):
        dates = ["2026-06-0%d" % d for d in range(1, 8)]
        assert engine.consecutive_run_length(dates) == 7

    def test_break_resets(self):
        assert engine.consecutive_run_length(["2026-06-01", "2026-06-02", "2026-06-05"]) == 2

    def test_dedup_and_unsorted(self):
        assert engine.consecutive_run_length(["2026-06-03", "2026-06-01", "2026-06-02", "2026-06-02"]) == 3
