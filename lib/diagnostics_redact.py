"""Redaction primitives for diagnostic bundles.

A `Redactor` carries the per-bundle salt and substitution caches so that
identical inputs (e.g. the same song path appearing in 50 log lines)
produce identical output tokens (`<song:a3f1c2>`). Different bundles get
different salts so tokens cannot be cross-correlated between exports.

Stable token grammar (see docs/diagnostics-bundle-spec.md):
    <DLC_DIR>          — DLC root path
    <HOME>             — user's home directory
    <CONFIG_DIR>       — feedBack config dir
    <song:hash8>       — song filename / basename (8 hex chars)
    <ip:hash6>          — IPv4 / IPv6 address (6 hex chars)
    <redacted>          — bearer tokens, key=/token= query strings
"""

from __future__ import annotations

import hashlib
import re
import secrets
from pathlib import Path


_IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_IPV6_RE = re.compile(
    r"(?<![A-Fa-f0-9:])"
    r"(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}"
    r"(?![A-Fa-f0-9:])"
)
_BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-+/=]+")
_URL_USERINFO_RE = re.compile(r"(?i)(https?://)[^@/\s]+@")
_QSTRING_SECRET_RE = re.compile(
    r"(?i)\b(api[_-]?key|key|token|secret|password|pwd|auth)=([^\s&\"']+)"
)
_SONG_FILENAME_RE = re.compile(
    r"\b[\w()'\-+&,.!?\[\]]+\.(?:psarc|sloppak|wem|ogg|mp3|wav)\b",
    re.IGNORECASE,
)


class Redactor:
    def __init__(
        self,
        dlc_dir: Path | None = None,
        home_dir: Path | None = None,
        config_dir: Path | None = None,
    ) -> None:
        self._salt = secrets.token_hex(8)
        self._dlc_dir = self._normalize(dlc_dir)
        self._home_dir = self._normalize(home_dir)
        self._config_dir = self._normalize(config_dir)
        self._song_cache: dict[str, str] = {}
        self._ip_cache: dict[str, str] = {}
        self.counts: dict[str, int] = {
            "paths_replaced": 0,
            "ips_replaced": 0,
            "song_names_replaced": 0,
            "secrets_replaced": 0,
        }

    @staticmethod
    def _normalize(p: Path | None) -> str | None:
        if p is None:
            return None
        # Resolve only when the path exists, so callers can pass a
        # synthetic prefix (tests, container-mapped paths) without
        # having Path.resolve() rewrite a missing /dlc/songs to
        # C:\dlc\songs on Windows.
        try:
            if p.exists():
                s = str(p.resolve())
            else:
                s = str(p)
        except (OSError, RuntimeError):
            s = str(p)
        return s if s and s != "." else None

    def _hash(self, value: str, n: int) -> str:
        h = hashlib.sha256()
        h.update(self._salt.encode())
        h.update(value.encode())
        return h.hexdigest()[:n]

    def _replace_path_prefix(self, text: str, prefix: str | None, token: str) -> str:
        if not prefix:
            return text
        # Match both forward- and backslash variants — Windows paths
        # appear with backslashes in tracebacks, Linux with slashes.
        candidates = {prefix, prefix.replace("/", "\\"), prefix.replace("\\", "/")}
        replaced = text
        for cand in candidates:
            if not cand:
                continue
            count = replaced.count(cand)
            if count:
                replaced = replaced.replace(cand, token)
                self.counts["paths_replaced"] += count
        return replaced

    def _redact_song(self, m: re.Match) -> str:
        name = m.group(0)
        token = self._song_cache.get(name)
        if token is None:
            token = f"<song:{self._hash(name, 8)}>"
            self._song_cache[name] = token
        self.counts["song_names_replaced"] += 1
        return token

    def _redact_ip(self, m: re.Match) -> str:
        ip = m.group(0)
        # Skip obvious non-IPs: dotted version numbers, sloppy fragments.
        if ip.count(".") == 3:
            try:
                if not all(0 <= int(p) <= 255 for p in ip.split(".")):
                    return ip
            except ValueError:
                return ip
        token = self._ip_cache.get(ip)
        if token is None:
            token = f"<ip:{self._hash(ip, 6)}>"
            self._ip_cache[ip] = token
        self.counts["ips_replaced"] += 1
        return token

    def _redact_secret_qstring(self, m: re.Match) -> str:
        self.counts["secrets_replaced"] += 1
        return f"{m.group(1)}=<redacted>"

    def _redact_bearer(self, _m: re.Match) -> str:
        self.counts["secrets_replaced"] += 1
        return "Bearer <redacted>"

    def _redact_url_userinfo(self, m: re.Match) -> str:
        self.counts["secrets_replaced"] += 1
        return f"{m.group(1)}<redacted>@"

    def redact_text(self, text: str) -> str:
        if not isinstance(text, str) or not text:
            return text
        # Path prefixes first (longest-match) so song-name regex never
        # eats a path component.
        text = self._replace_path_prefix(text, self._dlc_dir, "<DLC_DIR>")
        text = self._replace_path_prefix(text, self._config_dir, "<CONFIG_DIR>")
        text = self._replace_path_prefix(text, self._home_dir, "<HOME>")
        text = _SONG_FILENAME_RE.sub(self._redact_song, text)
        text = _IPV6_RE.sub(self._redact_ip, text)
        text = _IPV4_RE.sub(self._redact_ip, text)
        # URL userinfo before query-string secrets so user:pass@ is caught
        # even when the URL also has token= in the query string.
        text = _URL_USERINFO_RE.sub(self._redact_url_userinfo, text)
        text = _QSTRING_SECRET_RE.sub(self._redact_secret_qstring, text)
        text = _BEARER_RE.sub(self._redact_bearer, text)
        return text

    def redact_lines(self, lines):
        for line in lines:
            yield self.redact_text(line)
