"""Regression: the GP→arrangement-XML writers must pin UTF-8.

A bare ``Path.write_text(xml_str)`` uses the platform's *default* text
encoding. On Windows that is cp1252, which encodes a non-ASCII metadata
character — e.g. the © in an album name like "Chrysalis©1982" — as the lone
byte 0xA9. The XML is then read back as UTF-8 (expat's default), where 0xA9
is an invalid start byte, so parsing dies with

    not well-formed (invalid token): line N, column 22

CI runs on Linux (UTF-8 default), so the bug is invisible there and a plain
functional test would pass on the old code too. These assertions instead pin
the locale-independent contract directly.
"""

import inspect
import re
import xml.etree.ElementTree as ET

import gp2rs
import gp2rs_gpx


def test_arrangement_xml_writes_specify_utf8():
    # Every write of the arrangement XML string must pass encoding="utf-8"
    # so non-ASCII metadata survives regardless of the host locale.
    for mod in (gp2rs, gp2rs_gpx):
        src = inspect.getsource(mod)
        bare = re.findall(r"\.write_text\(\s*xml_str\s*\)", src)
        assert not bare, (
            f"{mod.__name__}: XML write must pass encoding=\"utf-8\" — a bare "
            f"write_text() uses the platform default (cp1252 on Windows) and "
            f"mangles non-ASCII metadata into invalid UTF-8"
        )
        assert 'write_text(xml_str, encoding="utf-8")' in src, (
            f"{mod.__name__}: expected a UTF-8-pinned arrangement XML write"
        )


def test_utf8_write_round_trips_non_ascii_album():
    # The behavioural end of the contract: a © album name written as UTF-8
    # parses cleanly and reads back intact (the cp1252 write does not).
    from pathlib import Path
    import tempfile

    xml_str = (
        '<?xml version="1.0"?>\n<song>\n'
        "  <albumName>Chrysalis©1982</albumName>\n</song>\n"
    )
    path = Path(tempfile.mkdtemp()) / "arr.xml"
    path.write_text(xml_str, encoding="utf-8")
    root = ET.parse(path).getroot()
    assert root.findtext("albumName") == "Chrysalis©1982"
