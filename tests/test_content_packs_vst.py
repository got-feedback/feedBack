"""VST-pack slicing (tools/content_packs.build_vst_pack): each platform pack
keeps only its own binaries + the shared bundle files, drops the rest, and is
reproducible."""
import zipfile
from pathlib import Path

from tools import content_packs


def _fake_vst_tree(root: Path):
    # One fat .vst3 with all three platform binaries + shared files, plus a
    # src/ build tree that must never ship.
    c = root / "amps" / "Foo.vst3" / "Contents"
    (c / "MacOS").mkdir(parents=True)
    (c / "x86_64-win").mkdir(parents=True)
    (c / "x86_64-linux").mkdir(parents=True)
    (c / "Resources").mkdir(parents=True)
    (c / "MacOS" / "Foo").write_bytes(b"mac-binary")
    (c / "x86_64-win" / "Foo.vst3").write_bytes(b"win-binary")
    (c / "x86_64-linux" / "Foo.so").write_bytes(b"linux-binary")
    (c / "Info.plist").write_bytes(b"<plist/>")
    (c / "Resources" / "moduleinfo.json").write_bytes(b"{}")
    (root / "src" / "build").mkdir(parents=True)
    (root / "src" / "build" / "junk.o").write_bytes(b"objfile")


def _names(zip_path):
    with zipfile.ZipFile(zip_path) as zf:
        return set(zf.namelist())


def test_slice_keeps_target_platform_and_shared_drops_foreign(tmp_path):
    root = tmp_path / "vst"
    _fake_vst_tree(root)
    content_packs.build_vst_pack(root, tmp_path / "mac.zip", "mac")
    names = _names(tmp_path / "mac.zip")

    base = "amps/Foo.vst3/Contents"
    assert f"{base}/MacOS/Foo" in names                 # target binary kept
    assert f"{base}/Info.plist" in names                # shared kept
    assert f"{base}/Resources/moduleinfo.json" in names  # shared kept
    assert f"{base}/x86_64-win/Foo.vst3" not in names    # foreign dropped
    assert f"{base}/x86_64-linux/Foo.so" not in names    # foreign dropped
    assert not any(n.startswith("src/") for n in names)  # build trees never ship


def test_each_platform_gets_its_own_binary(tmp_path):
    root = tmp_path / "vst"
    _fake_vst_tree(root)
    wanted = {"mac": "MacOS/Foo", "win": "x86_64-win/Foo.vst3", "linux": "x86_64-linux/Foo.so"}
    for plat, rel in wanted.items():
        content_packs.build_vst_pack(root, tmp_path / f"{plat}.zip", plat)
        names = _names(tmp_path / f"{plat}.zip")
        assert f"amps/Foo.vst3/Contents/{rel}" in names
        others = [v for k, v in wanted.items() if k != plat]
        for o in others:
            assert f"amps/Foo.vst3/Contents/{o}" not in names


def test_slice_is_reproducible(tmp_path):
    root = tmp_path / "vst"
    _fake_vst_tree(root)
    a = content_packs.build_vst_pack(root, tmp_path / "a.zip", "linux")
    b = content_packs.build_vst_pack(root, tmp_path / "b.zip", "linux")
    assert a == b and a["sha256"]


def test_slice_pins_create_system_for_cross_runner_reproducibility(tmp_path, monkeypatch):
    # ZipInfo defaults create_system from the host OS (0 on Windows, 3 on Unix),
    # and it lands in the central directory — so without an explicit pin the same
    # tree hashes differently on a Windows runner, breaking the precomputable-hash
    # guarantee exactly where it matters (native .vst3 are built on Windows). A
    # same-machine reproducibility test can't catch that; simulate win32 and
    # assert the pin forces 3 regardless.
    monkeypatch.setattr(zipfile.sys, "platform", "win32")
    root = tmp_path / "vst"
    _fake_vst_tree(root)
    content_packs.build_vst_pack(root, tmp_path / "w.zip", "linux")
    with zipfile.ZipFile(tmp_path / "w.zip") as zf:
        assert all(i.create_system == 3 for i in zf.infolist())


def test_unknown_platform_rejected(tmp_path):
    root = tmp_path / "vst"
    _fake_vst_tree(root)
    try:
        content_packs.build_vst_pack(root, tmp_path / "x.zip", "bsd")
    except ValueError as e:
        assert "unknown platform" in str(e)
    else:
        raise AssertionError("build_vst_pack accepted an unknown platform")
