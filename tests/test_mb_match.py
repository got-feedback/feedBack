"""Unit tests for lib/mb_match.py — the pure text-matching engine (P8).

No network, no database, no server import: denoise/tokenize, similarity,
scoring + tier classification, Lucene query building, and MusicBrainz
response parsing are all exercised as plain functions.
"""

import mb_match as m


# ── denoise / tokenize ────────────────────────────────────────────────────────

def test_denoise_lowercases_and_strips_punct_and_diacritics():
    assert m.denoise("Motörhead") == "motorhead"
    assert m.denoise("Beyoncé!!") == "beyonce"
    assert m.denoise("Guns N' Roses") == "guns n roses"
    assert m.denoise("  Weird   spacing ") == "weird spacing"


def test_denoise_strips_noise_parentheticals():
    # The design's explicit list: author suffixes + (440Hz)/(Live)/(No Lead)/(v2).
    assert m.denoise("Thunderstruck (440Hz)") == "thunderstruck"
    assert m.denoise("Thunderstruck (Live)") == "thunderstruck"
    assert m.denoise("Thunderstruck (No Lead)") == "thunderstruck"
    assert m.denoise("Thunderstruck (v2)") == "thunderstruck"
    assert m.denoise("Thunderstruck [Remastered 2012]") == "thunderstruck"
    assert m.denoise("One (Live at Wembley)") == "one"


def test_denoise_strips_author_credits():
    assert m.denoise("Back in Black (by SomeCharter)") == "back in black"
    assert m.denoise("Back in Black (charted by X99)") == "back in black"
    assert m.denoise("Back in Black - by SomeCharter") == "back in black"


def test_denoise_keeps_meaningful_parentheticals():
    # A parenthetical with no noise term survives (both sides get the same
    # treatment, so symmetric content still matches).
    assert m.denoise("Doin' It (All for My Baby)") == "doin it all for my baby"


def test_denoise_leading_the_is_artist_only():
    assert m.denoise("The Beatles", strip_leading_the=True) == "beatles"
    # Titles keep their "The" — never strip it there.
    assert m.denoise("The Trooper") == "the trooper"


def test_ampersand_folds_to_and():
    assert m.similarity("Angus & Julia Stone", "Angus and Julia Stone", artist=True) == 1.0


# ── similarity ────────────────────────────────────────────────────────────────

def test_similarity_exact_and_empty():
    assert m.similarity("Back in Black", "Back In Black!") == 1.0
    assert m.similarity("", "Anything") == 0.0
    assert m.similarity(None, None) == 0.0


def test_similarity_folds_spelling_drift_via_compaction():
    # The headline case: ACDC / AC DC / AC/DC all name the same artist.
    assert m.similarity("ACDC", "AC/DC", artist=True) == 1.0
    assert m.similarity("AC DC", "ACDC", artist=True) == 1.0
    assert m.similarity("Greenday", "Green Day", artist=True) == 1.0


def test_similarity_partial_overlap():
    s = m.similarity("Highway to Hell", "Highway Hell")
    assert 0.7 < s < 1.0
    assert m.similarity("Back in Black", "Paint It Black") < 0.5


# ── scoring + tiers ───────────────────────────────────────────────────────────

SONG = {"artist": "ACDC", "title": "Thunderstruck (v2)", "album": "The Razors Edge",
        "year": "1990", "duration": 292}


def test_score_exact_match_is_high():
    cand = {"artist": "AC/DC", "title": "Thunderstruck", "year": "1990", "duration": 292}
    s = m.score_candidate(SONG, cand)
    assert s == 1.0
    assert m.classify(SONG, cand, s) == "auto"


def test_score_cover_never_auto():
    # Perfect title, wrong artist (a cover) — must not auto-match.
    cand = {"artist": "Some Cover Band", "title": "Thunderstruck"}
    s = m.score_candidate(SONG, cand)
    assert m.classify(SONG, cand, s) != "auto"


def test_missing_artist_caps_at_review():
    song = {"artist": "", "title": "Thunderstruck", "duration": 292}
    cand = {"artist": "AC/DC", "title": "Thunderstruck", "duration": 292}
    s = m.score_candidate(song, cand)
    # artist half scores 0 → combined ≤ 0.55 + bonuses → review at best.
    assert m.classify(song, cand, s) != "auto"


def test_year_and_duration_corroborate():
    # Fuzzy title so the base sits below the 1.0 cap and bonuses are visible.
    base = {"artist": "AC/DC", "title": "Thunderstruck Thunder"}
    plain = m.score_candidate(SONG, base)
    with_year = m.score_candidate(SONG, dict(base, year="1990"))
    with_dur = m.score_candidate(SONG, dict(base, duration=290))
    assert with_year > plain
    assert with_dur > plain


def test_fuzzy_title_with_corroboration_lands_review_or_auto():
    cand = {"artist": "AC/DC", "title": "Thunderstruck Thunder"}
    s = m.score_candidate(SONG, cand)
    assert m.classify(SONG, cand, s) in ("review", "auto")


def test_unrelated_is_none():
    cand = {"artist": "Norah Jones", "title": "Sunrise"}
    s = m.score_candidate(SONG, cand)
    assert m.classify(SONG, cand, s) == "none"


def test_classify_auto_min_override():
    # The host's "auto-apply confidence" setting: a perfect match autos at
    # any real threshold, and "Always review" (>1.0) sends even it to review.
    cand = {"artist": "AC/DC", "title": "Thunderstruck", "year": "1990", "duration": 292}
    s = m.score_candidate(SONG, cand)
    assert s == 1.0
    assert m.classify(SONG, cand, s, auto_min=0.9) == "auto"
    assert m.classify(SONG, cand, s, auto_min=1.01) == "review"
    # The per-field floors are independent of the threshold: a wrong-artist
    # cover stays non-auto even at a permissive auto_min.
    cover = {"artist": "Some Cover Band", "title": "Thunderstruck"}
    cs = m.score_candidate(SONG, cover)
    assert m.classify(SONG, cover, cs, auto_min=0.5) != "auto"


def test_rank_candidates_orders_by_our_score():
    cands = [
        {"recording_id": "b", "artist": "Someone Else", "title": "Thunderstruck", "mb_score": 100},
        {"recording_id": "a", "artist": "AC/DC", "title": "Thunderstruck", "mb_score": 90},
    ]
    ranked = m.rank_candidates(SONG, cands)
    assert [c["recording_id"] for c in ranked] == ["a", "b"]
    assert all("score" in c for c in ranked)


# ── query building ────────────────────────────────────────────────────────────

def test_build_recording_query_denoises_and_quotes():
    q = m.build_recording_query("ACDC", 'Thunderstruck (v2)')
    assert q == 'recording:"thunderstruck" AND artist:"acdc"'


def test_build_recording_query_escapes_and_handles_missing_artist():
    q = m.build_recording_query("", 'Say "Hello"')
    # Quotes are punct-stripped by denoise, so nothing to escape here — but
    # the artist clause must be absent entirely.
    assert q.startswith('recording:"')
    assert "artist:" not in q


def test_build_recording_query_loose_drops_field_phrases():
    # The strict form (unchanged) locks to the *primary* artist/title phrase.
    assert m.build_recording_query("Junko Ohashi", "Telephone Number") == \
        'recording:"telephone number" AND artist:"junko ohashi"'
    # The loose form has no field scoping and no phrases, so MusicBrainz also
    # searches artist ALIASES — rescues non-Latin-primary artists (大橋純子).
    loose = m.build_recording_query("Junko Ohashi", "Telephone Number", loose=True)
    assert loose == "(telephone number) AND (junko ohashi)"
    assert "artist:" not in loose and '"' not in loose


def test_build_recording_query_loose_missing_artist():
    assert m.build_recording_query("", "Fantasy", loose=True) == "(fantasy)"


# ── MusicBrainz response parsing ──────────────────────────────────────────────

MB_DOC = {
    "id": "rec-123",
    "score": 98,
    "title": "Thunderstruck",
    "length": 292773,
    "isrcs": ["AUAP09000045"],
    "artist-credit": [
        {"name": "AC/DC", "joinphrase": "",
         "artist": {"id": "art-1", "name": "AC/DC", "sort-name": "AC/DC"}},
    ],
    "releases": [
        {"id": "rel-compilation", "title": "Greatest Hits", "status": "Official",
         "date": "2005-01-01", "release-group": {"primary-type": "Compilation"}},
        {"id": "rel-album", "title": "The Razors Edge", "status": "Official",
         "date": "1990-09-24", "release-group": {"primary-type": "Album"}},
        {"id": "rel-boot", "title": "Bootleg", "status": "Bootleg",
         "date": "1989-01-01", "release-group": {"primary-type": "Album"}},
    ],
    "tags": [{"name": "hard rock", "count": 10}, {"name": "rock", "count": 4}],
}


def test_parse_recording_doc_normalizes():
    c = m.parse_recording_doc(MB_DOC)
    assert c["recording_id"] == "rec-123"
    assert c["title"] == "Thunderstruck"
    assert c["artist"] == "AC/DC"
    assert c["artist_id"] == "art-1"
    # Official Album beats the compilation and the bootleg.
    assert c["album"] == "The Razors Edge"
    assert c["release_id"] == "rel-album"
    assert c["year"] == "1990"
    assert c["duration"] == 293
    assert c["isrc"] == "AUAP09000045"
    assert c["genres"] == ["hard rock", "rock"]
    assert c["mb_score"] == 98


def test_parse_recording_doc_joined_artist_credit():
    doc = dict(MB_DOC)
    doc["artist-credit"] = [
        {"name": "Queen", "joinphrase": " & ",
         "artist": {"id": "q", "name": "Queen", "sort-name": "Queen"}},
        {"name": "David Bowie",
         "artist": {"id": "b", "name": "David Bowie", "sort-name": "Bowie, David"}},
    ]
    c = m.parse_recording_doc(doc)
    assert c["artist"] == "Queen & David Bowie"
    assert c["artist_id"] == "q"


def test_parse_recording_doc_rejects_malformed():
    assert m.parse_recording_doc({}) is None
    assert m.parse_recording_doc({"id": "x"}) is None
    assert m.parse_recording_doc(None) is None


def test_parse_search_response():
    body = {"recordings": [MB_DOC, {"bogus": True}]}
    cands = m.parse_search_response(body)
    assert len(cands) == 1
    assert m.parse_search_response({}) == []
    assert m.parse_search_response(None) == []
