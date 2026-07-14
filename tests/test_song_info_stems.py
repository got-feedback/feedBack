"""`/api/song/{f}?stems=1` — the playable stem list, for preloading.

The stems plugin could only learn its stem list from the highway's WS `ready`,
which arrives once the highway is already up. So it decoded the stems and then
copied the whole song's PCM to its audio worklet with the player on screen —
half a gigabyte of memcpy in one frame, ~700 ms, which froze the venue video.

Given the list at `song:loading` it can do all of that BEFORE the highway
appears, behind the loading overlay where a stall costs nothing.

The safety property these tests exist for: the REST payload must be the SAME
list the WS builds. If they disagree, the plugin preloads one graph and then
throws it away and rebuilds another — strictly worse than not preloading. So
they are pinned against each other, not just against a snapshot.
"""

import zipfile

import yaml

import sloppak


def _pak(tmp_path, stems, full=None, name="song.feedpak", original_audio=None):
    manifest = {
        "title": "T", "artist": "A", "duration": 10.0,
        "arrangements": [],
        "stems": stems + ([full] if full else []),
    }
    if original_audio:
        # The deprecated pre-1.15.0 shape: the mixdown lives outside `stems`.
        manifest["original_audio"] = original_audio
    p = tmp_path / name
    with zipfile.ZipFile(p, "w") as z:
        # Real packs carry manifest.yaml — a JSON manifest is not read at all.
        z.writestr("manifest.yaml", yaml.safe_dump(manifest))
        # _legacy_full_mix only returns a path that actually EXISTS on disk.
        if original_audio:
            z.writestr(original_audio, b"\0" * 16)
    return p


def _payload(tmp_path, pak):
    from routers.song import _playable_stems_payload
    import appstate
    cache = tmp_path / "cache"
    cache.mkdir(exist_ok=True)
    appstate.sloppak_cache_dir = cache
    return _playable_stems_payload(pak.name, tmp_path)


def _ws_payload(tmp_path, pak):
    """Rebuild the WS `ready` stems payload exactly as ws_highway.py does."""
    from urllib.parse import quote
    cache = tmp_path / "cache"
    cache.mkdir(exist_ok=True)
    loaded = sloppak.load_song(pak.name, tmp_path, cache)
    q = quote(pak.name, safe="")
    return {
        "stems": [
            {"id": s["id"], "url": f"/api/sloppak/{q}/file/{quote(s['file'])}",
             "default": s["default"]}
            for s in loaded.stems
        ],
        "full_mix_url": f"/api/sloppak/{q}/file/{quote(loaded.full_mix)}" if loaded.full_mix else None,
    }


def test_default_resolution_is_shared_with_load_song():
    assert sloppak.stem_default_on(True) is True
    assert sloppak.stem_default_on(False) is False
    assert sloppak.stem_default_on("off") is False
    assert sloppak.stem_default_on("false") is False
    assert sloppak.stem_default_on("0") is False
    assert sloppak.stem_default_on("no") is False
    assert sloppak.stem_default_on("on") is True
    assert sloppak.stem_default_on(1) is True


def test_rest_matches_the_ws_for_a_reserved_full_stem(tmp_path):
    pak = _pak(tmp_path,
               [{"id": "guitar", "file": "stems/guitar.ogg"},
                {"id": "vocals", "file": "stems/vocals.ogg", "default": "off"}],
               full={"id": "full", "file": "stems/full.ogg"},
               name="Iron Maiden - Phantom.feedpak")
    rest = _payload(tmp_path, pak)
    assert rest == _ws_payload(tmp_path, pak)
    assert [s["id"] for s in rest["stems"]] == ["guitar", "vocals"], "the mixdown is not a layer"
    assert rest["full_mix_url"].endswith("stems/full.ogg")
    assert rest["stems"][1]["default"] is False


def test_rest_matches_the_ws_for_a_LEGACY_original_audio_pack(tmp_path):
    """The one CodeRabbit caught, and the one that matters most in practice.

    load_song falls back to the DEPRECATED `original_audio:` key when a pack has
    no reserved `full` stem — which is every pack written before feedpak 1.15.0,
    i.e. most of a real library. My first version of this payload reimplemented
    the full-mix rule from extract_meta and silently returned None for them: REST
    would say "no full mix" while the WS said there was one. The plugin would then
    preload a graph WITHOUT the pristine mix and, because the signature still
    matched, never rebuild — unity playback silently downgraded to the lossy
    recombination.

    The payload now calls load_song itself, so this cannot drift. Pinned anyway.
    """
    pak = _pak(tmp_path, [
        {"id": "guitar", "file": "stems/guitar.ogg"},
        {"id": "bass", "file": "stems/bass.ogg"},
    ], name="Legacy Pack.feedpak", original_audio="original/full.ogg")

    rest = _payload(tmp_path, pak)
    assert rest == _ws_payload(tmp_path, pak)
    assert rest["full_mix_url"] is not None, (
        "a pre-1.15.0 pack's full mix must survive — dropping it downgrades unity "
        "playback to the lossy stem recombination, silently"
    )
    assert rest["full_mix_url"].endswith("original/full.ogg")


def test_rest_matches_the_ws_for_a_single_full_pack(tmp_path):
    # Its ONE stem IS the mixdown: nothing to be pristine against, so `full` stays
    # the sole playable stem and no separate mixdown is surfaced.
    pak = _pak(tmp_path, [{"id": "full", "file": "stems/full.ogg"}], name="Single.feedpak")
    rest = _payload(tmp_path, pak)
    assert rest == _ws_payload(tmp_path, pak)
    assert [s["id"] for s in rest["stems"]] == ["full"]
    assert rest["full_mix_url"] is None


def test_a_broken_pack_yields_an_empty_list_not_an_error(tmp_path):
    # Preloading is an optimisation: an unreadable pack must fall back to the
    # normal WS-driven path, never break the song-info request.
    from routers.song import _playable_stems_payload
    import appstate
    cache = tmp_path / "cache"
    cache.mkdir()
    appstate.sloppak_cache_dir = cache
    (tmp_path / "bad.feedpak").write_bytes(b"not a zip")
    assert _playable_stems_payload("bad.feedpak", tmp_path) == {"stems": [], "full_mix_url": None}
