from pathlib import Path

from diagnostics_redact import Redactor


def test_dlc_path_replaced():
    r = Redactor(dlc_dir=Path("/dlc/songs"))
    out = r.redact_text("loaded from /dlc/songs/foo.archive")
    assert "<DLC_DIR>" in out
    assert "/dlc/songs" not in out
    assert r.counts["paths_replaced"] == 1


def test_song_filename_redacted_consistently():
    r = Redactor()
    a = r.redact_text("Loading Test-Artist_Test-Song.archive")
    b = r.redact_text("Replaying Test-Artist_Test-Song.archive again")
    token_a = a.split("Loading ")[1].strip()
    token_b = b.split("Replaying ")[1].split(" ")[0]
    assert token_a == token_b
    assert token_a.startswith("<song:") and token_a.endswith(">")
    assert r.counts["song_names_replaced"] == 2


def test_ipv4_redacted():
    r = Redactor()
    out = r.redact_text("client 192.168.1.42 connected")
    assert "192.168.1.42" not in out
    assert "<ip:" in out
    assert r.counts["ips_replaced"] == 1


def test_invalid_ipv4_left_alone():
    r = Redactor()
    out = r.redact_text("version 1.2.3.999 not an ip")
    assert "1.2.3.999" in out
    assert r.counts["ips_replaced"] == 0


def test_bearer_token_redacted():
    r = Redactor()
    out = r.redact_text("Authorization: Bearer abc123def456")
    assert "abc123def456" not in out
    assert "<redacted>" in out
    assert r.counts["secrets_replaced"] == 1


def test_qstring_secret_redacted():
    r = Redactor()
    out = r.redact_text("GET /api?api_key=supersecret&foo=bar")
    assert "supersecret" not in out
    assert "api_key=<redacted>" in out
    assert "foo=bar" in out


def test_home_dir_replaced():
    r = Redactor(home_dir=Path("/home/alice"))
    out = r.redact_text("config at /home/alice/.config/feedBack")
    assert "/home/alice" not in out
    assert "<HOME>" in out


def test_different_redactors_produce_different_tokens():
    a = Redactor()
    b = Redactor()
    out_a = a.redact_text("Foo.archive")
    out_b = b.redact_text("Foo.archive")
    assert out_a != out_b


def test_redact_lines_iterator():
    r = Redactor()
    lines = ["client 10.0.0.1", "client 10.0.0.1 again"]
    out = list(r.redact_lines(lines))
    assert out[0] != lines[0]
    assert out[0].split("client ")[1] == out[1].split("client ")[1].split(" ")[0]


def test_non_string_passes_through():
    r = Redactor()
    assert r.redact_text("") == ""
    assert r.redact_text(None) is None


def test_url_userinfo_redacted():
    """Credentials embedded as URL userinfo (user:pass@host) must be redacted."""
    r = Redactor()
    out = r.redact_text("connecting to https://admin:secret@myhost.example.com/api")
    assert "admin" not in out
    assert "secret" not in out
    assert "<redacted>@myhost.example.com" in out
    assert r.counts["secrets_replaced"] == 1


def test_url_userinfo_redacted_http():
    """URL userinfo redaction also applies to http:// URLs."""
    r = Redactor()
    out = r.redact_text("http://user:pass@192.168.1.1:8080/path")
    assert "user:pass" not in out
    assert "<redacted>@" in out


def test_url_no_userinfo_unchanged():
    """A plain URL without userinfo must not be altered by the userinfo redactor."""
    r = Redactor()
    url = "https://myhost.example.com/api/stream"
    out = r.redact_text(url)
    assert out == url
    assert r.counts["secrets_replaced"] == 0
