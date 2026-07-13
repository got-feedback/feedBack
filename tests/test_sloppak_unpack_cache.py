"""The unpack cache is bounded, and reading part of a song doesn't explode it.

`sloppak_cache/` holds every song ever unpacked, fully decompressed. Stems are
already-compressed audio, so an unpacked song is ~1.1x its zip — the cache is a
second copy of the library. It used to have no cap, no LRU, and no cleanup at
all: a tester reached 60 GB from an 1800-song library because one caller looped
the library calling load_song() (rig_builder's library-wide tone batch), which
unpacks the WHOLE pack — stems included — to read a few KB of tone JSON.

Pins, so neither half can silently come back:
  - resolve_source_dir() evicts LRU songs to stay under the cap,
  - it never evicts the song the caller just asked for,
  - an evicted song is dropped from _source_cache too (otherwise the media route
    keeps serving a path that no longer exists and 404s every stem instead of
    re-unpacking),
  - get_cached_source_dir() self-heals if the cache dir is deleted by hand,
  - read_member_bytes() reads one file WITHOUT unpacking anything.
"""

import importlib
import zipfile

import pytest
import yaml

import sloppak as sloppak_mod


STEM = b"\x00" * (400 * 1024)   # 400 KB of "audio" — the bulk of a real pack
ARR = b'{"tones": {"definitions": [{"Key": "clean"}]}}'


def _zip_pack(path, stem_bytes=STEM):
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("manifest.yaml", yaml.safe_dump({
            "title": path.stem,
            "arrangements": [{"file": "arrangements/lead.json", "name": "Lead"}],
            "stems": [{"id": "full", "file": "stems/audio.ogg"}],
        }))
        zf.writestr("arrangements/lead.json", ARR)
        zf.writestr("stems/audio.ogg", stem_bytes)
    return path


@pytest.fixture(autouse=True)
def _fresh_module_state():
    # _source_cache is module state and would leak across tests.
    importlib.reload(sloppak_mod)
    yield
    importlib.reload(sloppak_mod)


def _cap_mb(monkeypatch, mb):
    monkeypatch.setenv("FEEDBACK_SLOPPAK_CACHE_MAX_MB", str(mb))


def test_read_member_bytes_does_not_unpack(tmp_path, monkeypatch):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    cache = tmp_path / "cache"
    cache.mkdir()
    pack = _zip_pack(dlc / "song.feedpak")

    data = sloppak_mod.read_member_bytes(pack, "arrangements/lead.json")

    assert data == ARR
    assert list(cache.iterdir()) == [], (
        "reading one member must not unpack the pack — this is the whole point: "
        "load_song() would have written the 400 KB stem to disk to get 45 bytes of JSON"
    )


def test_read_member_bytes_missing_member_is_none(tmp_path):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    pack = _zip_pack(dlc / "song.feedpak")
    assert sloppak_mod.read_member_bytes(pack, "arrangements/nope.json") is None
    assert sloppak_mod.read_member_bytes(pack, "") is None


def test_unpack_cache_evicts_lru_to_stay_under_cap(tmp_path, monkeypatch):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    cache = tmp_path / "cache"
    cache.mkdir()
    _cap_mb(monkeypatch, 1)                       # 1 MB — holds ~2 of our 400 KB packs

    for i in range(6):
        _zip_pack(dlc / f"song{i}.feedpak")

    for i in range(6):
        sloppak_mod.resolve_source_dir(f"song{i}.feedpak", dlc, cache)

    total = sum(f.stat().st_size for f in cache.rglob("*") if f.is_file())
    assert total <= 1 * 1024 * 1024, (
        f"unpack cache ran to {total/1e6:.1f} MB against a 1 MB cap — this is the "
        "unbounded growth that reached 60 GB in the field"
    )
    # The most recent song must survive; the oldest must not.
    names = {d.name for d in cache.iterdir()}
    assert "song5.feedpak" in names, "the song just resolved must never be evicted"
    assert "song0.feedpak" not in names, "the least-recently-used song should go first"


def test_eviction_drops_the_source_cache_entry(tmp_path, monkeypatch):
    """An evicted song must not keep being handed out by get_cached_source_dir().

    media.py only falls back to resolve_source_dir() when this returns None. If a
    stale path survives, every stem 404s for the rest of the process instead of
    re-unpacking — a silently broken song, not a slow one.
    """
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    cache = tmp_path / "cache"
    cache.mkdir()
    _cap_mb(monkeypatch, 1)

    for i in range(6):
        _zip_pack(dlc / f"song{i}.feedpak")
    for i in range(6):
        sloppak_mod.resolve_source_dir(f"song{i}.feedpak", dlc, cache)

    evicted = sloppak_mod.get_cached_source_dir("song0.feedpak")
    assert evicted is None, "an evicted song must be dropped from _source_cache"

    # ...and asking for it again just re-unpacks it. Self-healing, not broken.
    again = sloppak_mod.resolve_source_dir("song0.feedpak", dlc, cache)
    assert (again / "stems" / "audio.ogg").is_file()


def test_get_cached_source_dir_self_heals_after_manual_delete(tmp_path, monkeypatch):
    """Telling a user to delete sloppak_cache/ to reclaim disk must be safe."""
    import shutil
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    cache = tmp_path / "cache"
    cache.mkdir()
    _cap_mb(monkeypatch, 0)                       # eviction off — isolate the delete
    _zip_pack(dlc / "song.feedpak")

    src = sloppak_mod.resolve_source_dir("song.feedpak", dlc, cache)
    assert sloppak_mod.get_cached_source_dir("song.feedpak") == src

    shutil.rmtree(src)                            # the user clears the folder

    assert sloppak_mod.get_cached_source_dir("song.feedpak") is None, (
        "a path that no longer exists must not be served — the caller would 404 "
        "every stem instead of re-unpacking"
    )
    assert (sloppak_mod.resolve_source_dir("song.feedpak", dlc, cache)
            / "stems" / "audio.ogg").is_file()


def test_cap_of_zero_disables_eviction(tmp_path, monkeypatch):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    cache = tmp_path / "cache"
    cache.mkdir()
    _cap_mb(monkeypatch, 0)
    for i in range(4):
        _zip_pack(dlc / f"song{i}.feedpak")
    for i in range(4):
        sloppak_mod.resolve_source_dir(f"song{i}.feedpak", dlc, cache)
    assert len(list(cache.iterdir())) == 4, "cap 0 must mean 'never evict'"


def test_read_member_bytes_normalizes_non_canonical_names(tmp_path):
    """A manifest may name a member './arrangements/lead.json' — valid, and it
    resolved fine once unpacked. Reading the zip member by the raw string would
    KeyError and silently report no tones. Same trap read_cover_bytes already hit."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    pack = _zip_pack(dlc / "song.feedpak")

    assert sloppak_mod.read_member_bytes(pack, "./arrangements/lead.json") == ARR
    assert sloppak_mod.read_member_bytes(pack, "stems/../arrangements/lead.json") == ARR
    assert sloppak_mod.read_member_bytes(pack, "arrangements\\lead.json") == ARR


def test_read_member_bytes_rejects_zip_slip(tmp_path):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    pack = _zip_pack(dlc / "song.feedpak")
    assert sloppak_mod.read_member_bytes(pack, "../../etc/passwd") is None
    assert sloppak_mod.read_member_bytes(pack, "/etc/passwd") is None
    assert sloppak_mod.read_member_bytes(pack, ".") is None


def test_eviction_never_deletes_an_in_flight_unpack(tmp_path, monkeypatch):
    """Two unpacks run concurrently (_UNPACK_MAX_CONCURRENCY = 2). One finishing
    must not rmtree the other's half-written dir — that resolver would then cache
    an incomplete song and serve a broken pack.

    Sized so the sweep genuinely has to reach the in-flight directory: each pack
    is ~700 KB against a 1 MB cap, so once `keep` is protected the sweep must
    delete EVERY other dir to get under the cap — including the one being written.
    (A naive version of this test passes even without the guard, because a
    freshly-created dir is the most-recently-used and the sweep never gets to it.)
    """
    import threading

    big = b"\x00" * (700 * 1024)
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    cache = tmp_path / "cache"
    cache.mkdir()
    _cap_mb(monkeypatch, 1)
    for i in range(3):
        _zip_pack(dlc / f"song{i}.feedpak", stem_bytes=big)

    victim = cache / "song2.feedpak"
    started = threading.Event()
    release = threading.Event()
    real_unpack = sloppak_mod._unpack_zip

    def slow_unpack(zip_path, dest):
        real_unpack(zip_path, dest)          # dir now exists — "half written"
        if dest == victim:
            started.set()
            release.wait(5)                  # hold it open while the other sweeps

    monkeypatch.setattr(sloppak_mod, "_unpack_zip", slow_unpack)

    t = threading.Thread(target=sloppak_mod.resolve_source_dir,
                         args=("song2.feedpak", dlc, cache))
    t.start()
    assert started.wait(5), "victim unpack did not start"

    # song0 lands and sweeps: keep=song0, cache holds song0+song2 = 1.4 MB > 1 MB,
    # so the sweep MUST try to delete song2 — which is still being written.
    sloppak_mod.resolve_source_dir("song0.feedpak", dlc, cache)
    in_flight_survived = victim.is_dir()

    release.set()
    t.join(5)

    assert in_flight_survived, (
        "eviction deleted a directory another thread was still unpacking into — "
        "that resolver caches an incomplete song and serves a broken pack"
    )


def test_read_member_bytes_finds_backslash_members(tmp_path):
    """Windows-authored packs store members as 'arrangements\\lead.json'.
    _unpack_zip() normalizes those on extract, so unpack-then-read found them.
    An exact getinfo() would not — and we'd silently report the song has no tones."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    pack = dlc / "win.feedpak"
    with zipfile.ZipFile(pack, "w") as zf:
        zf.writestr("manifest.yaml", yaml.safe_dump({"title": "w"}))
        zf.writestr("arrangements\\lead.json", ARR)      # backslash member name

    assert sloppak_mod.read_member_bytes(pack, "arrangements/lead.json") == ARR


def test_read_member_bytes_finds_non_canonical_STORED_names(tmp_path):
    """The archive itself may store './arrangements/lead.json'. _unpack_zip()
    normalizes stored names on extract, so unpack-then-read resolved it. Both the
    requested path and the stored name must be normalized, or the tones vanish."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    pack = dlc / "odd.feedpak"
    with zipfile.ZipFile(pack, "w") as zf:
        zf.writestr("manifest.yaml", yaml.safe_dump({"title": "o"}))
        zf.writestr("./arrangements/lead.json", ARR)     # stored non-canonically

    assert sloppak_mod.read_member_bytes(pack, "arrangements/lead.json") == ARR


def test_read_member_bytes_matches_unpack_last_write_wins(tmp_path):
    """If a pack stores two names that normalize to the same file, _unpack_zip
    writes them in order and the LAST one is what ends up on disk. Reading the
    raw member by exact name would hand back the first — stale arrangement data
    that no unpacked read would ever have produced."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    pack = dlc / "dupe.feedpak"
    with zipfile.ZipFile(pack, "w") as zf:
        zf.writestr("manifest.yaml", yaml.safe_dump({"title": "d"}))
        zf.writestr("arrangements/lead.json", b'{"tones": {"definitions": [{"Key": "STALE"}]}}')
        zf.writestr("./arrangements/lead.json", ARR)      # normalizes to the same path

    assert sloppak_mod.read_member_bytes(pack, "arrangements/lead.json") == ARR


def test_failed_unpack_does_not_leave_the_dir_un_evictable(tmp_path, monkeypatch):
    """A dir marked in-flight is skipped by eviction. If a failed unpack leaves the
    marker behind, that dir becomes permanently un-evictable — a slow leak of
    exactly the thing this cap exists to prevent."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    cache = tmp_path / "cache"
    cache.mkdir()
    _cap_mb(monkeypatch, 1)
    _zip_pack(dlc / "boom.feedpak")

    def blow_up(zip_path, dest):
        dest.mkdir(parents=True, exist_ok=True)
        raise OSError("disk full")

    monkeypatch.setattr(sloppak_mod, "_unpack_zip", blow_up)
    with pytest.raises(OSError):
        sloppak_mod.resolve_source_dir("boom.feedpak", dlc, cache)

    assert not sloppak_mod._unpacking, (
        "a failed unpack left its destination marked in-flight — eviction will "
        "skip it forever"
    )
