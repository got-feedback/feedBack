#!/usr/bin/env python3
"""Build & publish opt-in content packs (career venue media, rig VST slices).

Flat-zips a pack directory, sha256s it, and emits the ``{url, sha256, bytes}``
block that the career and rig_builder download paths consume
(``plugins/career/routes.py`` ``_download_pack``). Two modes:

  --local <dir>    write zips + a file:// manifest (dev/CI/tests; no network)
  --publish        create/upload each pack's per-pack release; emit release URLs

The zip is flat (files at the archive root) to satisfy career's zip-slip guard
(``PACK_FILENAME_RE``) and ``_validate_pack_dir``. This module is the reusable
core the content-packs CI workflow calls, so building packs is automation —
never a person's manual job.

Run ``python tools/content_packs.py --selfcheck`` for the built-in round-trip.
"""

import argparse
import hashlib
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

REPO = "got-feedBack/feedBack"  # where the content-packs release lives (public)

# Must mirror career's download-time whitelist (plugins/career/routes.py
# PACK_FILENAME_RE). If the builder packs a name the downloader rejects (e.g. a
# stray .DS_Store), the published pack fails _validate_pack_dir for every client.
PACK_FILENAME_RE = re.compile(r"^[a-z0-9_-]{1,64}\.(mp4|webm|mp3|json)$")


def build_pack(src_dir: Path, out_zip: Path) -> dict:
    """Flat-zip every file directly under src_dir; return {sha256, bytes}.

    Only regular files at the top level are included (venue packs are flat).
    Subdirectories are skipped — a nested tree would trip career's zip-slip
    guard on download anyway.

    The build is REPRODUCIBLE: identical file contents always yield a
    byte-identical zip (fixed name order, fixed mtime, fixed permissions,
    ZIP_STORED). So a sha256 computed on any machine matches the zip the CI
    workflow or another contributor produces — anyone can precompute the
    manifest values without having to be the one who uploads the asset.
    """
    files = sorted((p for p in src_dir.iterdir() if p.is_file()),
                   key=lambda p: p.name)
    if not files:
        raise ValueError(f"no files to pack in {src_dir}")
    bad = [p.name for p in files if not PACK_FILENAME_RE.fullmatch(p.name)]
    if bad:
        raise ValueError(
            f"{src_dir}: files the downloader will reject: {bad} "
            f"(allowed: {PACK_FILENAME_RE.pattern})")
    out_zip.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_STORED) as zf:
        # ZIP_STORED: the media (mp4/mp3) and .vst3 binaries are already
        # compressed; deflating just burns CPU for ~0 gain.
        for p in files:
            # Fixed mtime (the zip epoch, 1980-01-01) + fixed perms so the
            # bytes don't depend on the checkout's file timestamps.
            info = zipfile.ZipInfo(p.name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            # Pin create_system: ZipInfo defaults it from the host OS (0 on
            # Windows, 3 on Unix), which would otherwise make the same pack
            # hash differently across runners. 3 = Unix.
            info.create_system = 3
            info.external_attr = 0o644 << 16
            zf.writestr(info, p.read_bytes())
    data = out_zip.read_bytes()
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


# rig_builder ships "fat" .vst3 bundles carrying all three platforms inside
# Contents/. A pack for one platform keeps that platform's binary dir + the
# shared bundle files, and drops the other two.
VST_PLATFORM_DIRS = {"mac": "MacOS", "win": "x86_64-win", "linux": "x86_64-linux"}


def build_vst_pack(vst_root: Path, out_zip: Path, platform: str) -> dict:
    """Reproducibly zip the VST tree keeping only `platform`'s binaries.

    Slices each fat .vst3: everything is kept except the two foreign platform
    dirs (MacOS / x86_64-win / x86_64-linux) and the vst/src build trees. Arc
    names are relative to vst_root so the download endpoint extracts straight
    into <plugin>/vst/. Same reproducible-build guarantees as build_pack.
    """
    if platform not in VST_PLATFORM_DIRS:
        raise ValueError(f"unknown platform {platform!r} (want mac/win/linux)")
    foreign = set(VST_PLATFORM_DIRS.values()) - {VST_PLATFORM_DIRS[platform]}
    files = []
    for p in sorted(vst_root.rglob("*"), key=lambda q: q.as_posix()):
        if not p.is_file():
            continue
        rel = p.relative_to(vst_root)
        if rel.parts and rel.parts[0] == "src":      # skip C++/JUCE build trees
            continue
        if set(rel.parts) & foreign:                 # drop foreign-platform binaries
            continue
        files.append((p, rel))
    if not files:
        raise ValueError(f"no VST files to pack for {platform} in {vst_root}")
    out_zip.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_STORED) as zf:
        for p, rel in files:
            info = zipfile.ZipInfo(rel.as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            # Pin create_system like build_pack: ZipInfo defaults it from the
            # host OS (0 on Windows, 3 on Unix), which would otherwise make the
            # same pack hash differently across runners. VST packs are the most
            # likely to be built on Windows (native .vst3), so without this pin
            # the precomputable-hash guarantee breaks exactly where it's needed.
            info.create_system = 3
            info.external_attr = 0o644 << 16
            zf.writestr(info, p.read_bytes())
    data = out_zip.read_bytes()
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def manifest_entry(out_zip: Path, url: str) -> dict:
    """Pack info as the download-path expects it: {url, sha256, bytes}."""
    return {"url": url,
            "sha256": hashlib.sha256(out_zip.read_bytes()).hexdigest(),
            "bytes": out_zip.stat().st_size}


# Per-pack, versioned, immutable release convention (matches what the team
# already published, e.g. tag `venue-arena-v1` / asset `arena-pack-v1.zip`).
def pack_tag(pack_id: str, version: int) -> str:
    return f"venue-{pack_id}-v{version}"


def pack_asset(pack_id: str, version: int) -> str:
    return f"{pack_id}-pack-v{version}.zip"


def pack_url(pack_id: str, version: int, repo: str = REPO) -> str:
    return (f"https://github.com/{repo}/releases/download/"
            f"{pack_tag(pack_id, version)}/{pack_asset(pack_id, version)}")


# VST packs use the same immutable per-pack convention, keyed by platform:
# tag `vst-<plat>-v<N>`, asset `vst-<plat>-pack-v<N>.zip`. The manifest they
# emit is keyed by platform (mac/win/linux) — the shape the rig_builder plugin's
# data/vst_packs.json consumes.
def vst_tag(platform: str, version: int) -> str:
    return f"vst-{platform}-v{version}"


def vst_asset(platform: str, version: int) -> str:
    return f"vst-{platform}-pack-v{version}.zip"


def vst_url(platform: str, version: int, repo: str = REPO) -> str:
    return (f"https://github.com/{repo}/releases/download/"
            f"{vst_tag(platform, version)}/{vst_asset(platform, version)}")


def _publish_release(tag: str, zip_path: Path, title: str, notes: str,
                     repo: str = REPO) -> None:
    """Create the per-pack release if missing, then upload the versioned zip.

    Tags are immutable: a media change means a new version (v1 → v2), never a
    re-upload — so no --clobber. gh errors if the asset already exists, which is
    the right guard against overwriting a published, referenced pack.
    """
    if subprocess.run(["gh", "release", "view", tag, "--repo", repo],
                      capture_output=True).returncode != 0:
        subprocess.run(
            ["gh", "release", "create", tag, "--repo", repo, "--latest=false",
             "--title", title, "--notes", notes],
            check=True)
    subprocess.run(
        ["gh", "release", "upload", tag, str(zip_path), "--repo", repo], check=True)


def publish(pack_id: str, version: int, zip_path: Path, repo: str = REPO) -> None:
    _publish_release(pack_tag(pack_id, version), zip_path,
                     f"{pack_id.capitalize()} venue pack v{version}",
                     "Opt-in career venue pack. Not a code release.", repo)


def _pack_id(src_dir: Path) -> str:
    return src_dir.name


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("src", nargs="*", type=Path,
                    help="pack source dirs (e.g. plugins/career/venue-packs/club)")
    ap.add_argument("--version", type=int, default=1,
                    help="pack version (tag venue-<id>-v<N>); default 1")
    ap.add_argument("--local", type=Path, metavar="DIR",
                    help="write zips here + a file:// manifest.json; no upload")
    ap.add_argument("--publish", action="store_true",
                    help="create/upload the per-pack release; emit release URLs")
    ap.add_argument("--vst", action="store_true",
                    help="slice one rig VST root (src[0]) into per-platform "
                         "vst-<plat>-v<N> packs; manifest keyed by platform "
                         "(the shape rig_builder's data/vst_packs.json wants)")
    ap.add_argument("--repo", default=REPO,
                    help=f"GitHub repo to publish releases to AND reference in the "
                         f"emitted manifest URLs (default {REPO}). The upload "
                         f"target and the URL always use this same repo — a pack "
                         f"is downloaded from whatever the manifest says, so they "
                         f"must not diverge.")
    ap.add_argument("--manifest", type=Path,
                    help="write the {id: {url,sha256,bytes}} map here (default: stdout)")
    ap.add_argument("--selfcheck", action="store_true", help="run the round-trip demo and exit")
    args = ap.parse_args(argv)

    if args.selfcheck:
        return _selfcheck()
    if not args.src or (not args.local and not args.publish):
        ap.error("need one or more src dirs and either --local or --publish")

    out_dir = args.local if args.local else Path(args.src[0]).parent / "_packs"
    manifest = {}
    if args.vst:
        vst_root = args.src[0]
        for plat in VST_PLATFORM_DIRS:
            zip_path = out_dir / vst_asset(plat, args.version)
            build_vst_pack(vst_root, zip_path, plat)
            if args.publish:
                # --repo MUST reach both, or the manifest advertises a repo the
                # asset was never uploaded to (every client download 404s).
                _publish_release(vst_tag(plat, args.version), zip_path,
                                 f"Rig VST pack ({plat}) v{args.version}",
                                 "Opt-in per-platform rig VST pack. Not a code release.",
                                 args.repo)
                url = vst_url(plat, args.version, args.repo)
            else:
                url = (out_dir.resolve() / zip_path.name).as_uri()
            manifest[plat] = manifest_entry(zip_path, url)
    else:
        for src in args.src:
            pid = _pack_id(src)
            zip_path = out_dir / pack_asset(pid, args.version)
            build_pack(src, zip_path)
            if args.publish:
                publish(pid, args.version, zip_path, args.repo)
                url = pack_url(pid, args.version, args.repo)
            else:
                url = (out_dir.resolve() / zip_path.name).as_uri()
            manifest[pid] = manifest_entry(zip_path, url)

    out = json.dumps(manifest, indent=2)
    if args.manifest:
        args.manifest.write_text(out + "\n", encoding="utf-8")
    else:
        print(out)
    return 0


def _selfcheck() -> int:
    """Build a pack and confirm build_pack/manifest_entry agree on the digest."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        src = td / "bar"
        src.mkdir()
        (src / "manifest.json").write_text('{"venue":"bar"}')
        (src / "bored.mp4").write_bytes(b"\x00fake-video")
        zip_path = td / pack_asset("bar", 1)
        info = build_pack(src, zip_path)
        # Reproducible: a second build (into a different path) is byte-identical.
        info2 = build_pack(src, td / "again.zip")
        assert info2["sha256"] == info["sha256"], "build is not reproducible"
        entry = manifest_entry(zip_path, pack_url("bar", 1))
        assert entry["sha256"] == info["sha256"], "digest mismatch"
        assert entry["bytes"] == info["bytes"]
        assert entry["url"] == (
            f"https://github.com/{REPO}/releases/download/venue-bar-v1/bar-pack-v1.zip")
        # Round-trip: the zip must be flat (names == basenames).
        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()
        assert set(names) == {"manifest.json", "bored.mp4"}, names

        # VST slice: keep target platform + shared, drop foreign, reproducible.
        c = td / "vst" / "Foo.vst3" / "Contents"
        for d in ("MacOS", "x86_64-win", "x86_64-linux", "Resources"):
            (c / d).mkdir(parents=True)
        (c / "MacOS" / "Foo").write_bytes(b"mac")
        (c / "x86_64-linux" / "Foo.so").write_bytes(b"linux")
        (c / "Info.plist").write_bytes(b"<plist/>")
        vzip = td / vst_asset("linux", 1)
        vinfo = build_vst_pack(td / "vst", vzip, "linux")
        assert vinfo == build_vst_pack(td / "vst", td / "v2.zip", "linux"), \
            "vst slice is not reproducible"
        with zipfile.ZipFile(vzip) as zf:
            vnames = set(zf.namelist())
        assert "Foo.vst3/Contents/x86_64-linux/Foo.so" in vnames
        assert "Foo.vst3/Contents/Info.plist" in vnames
        assert not any("MacOS" in n for n in vnames), vnames
    print("content_packs selfcheck: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
