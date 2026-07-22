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


def publish(pack_id: str, version: int, zip_path: Path, repo: str = REPO) -> None:
    """Create the per-pack release if missing, then upload the versioned zip.

    Tags are immutable: a media change means a new version (v1 → v2), never a
    re-upload — so no --clobber. gh errors if the asset already exists, which is
    the right guard against overwriting a published, referenced pack.
    """
    tag = pack_tag(pack_id, version)
    if subprocess.run(["gh", "release", "view", tag, "--repo", repo],
                      capture_output=True).returncode != 0:
        subprocess.run(
            ["gh", "release", "create", tag, "--repo", repo, "--latest=false",
             "--title", f"{pack_id.capitalize()} venue pack v{version}",
             "--notes", "Opt-in career venue pack. Not a code release."],
            check=True)
    subprocess.run(
        ["gh", "release", "upload", tag, str(zip_path), "--repo", repo], check=True)


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
    for src in args.src:
        pid = _pack_id(src)
        zip_path = out_dir / pack_asset(pid, args.version)
        build_pack(src, zip_path)
        if args.publish:
            publish(pid, args.version, zip_path)
            url = pack_url(pid, args.version)
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
    print("content_packs selfcheck: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
