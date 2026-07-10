"""Core-owned song/tone -> audio-effect-provider mapping index.

Extracted verbatim from ``server.py`` (R3). ``server.py`` still owns the
``audio_effect_mappings`` singleton; this module only supplies the class, so
nothing here touches config paths at import time — the caller passes
``config_dir`` in.
"""

import json
import sqlite3
import threading
from pathlib import Path


class AudioEffectsMappingDB:
    """Core-owned public song/tone -> provider mapping index.

    Providers own the preset/chain rows addressed by provider_ref. Core owns
    the cross-provider routing index and the active mapping per song/tone.
    """

    def __init__(self, config_dir: Path):
        config_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = str(config_dir / "audio_effects.db")
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS audio_effect_mappings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                song_key TEXT NOT NULL,
                filename TEXT NOT NULL DEFAULT '',
                tone_key TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                provider_ref TEXT NOT NULL,
                label TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT 'manual',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(song_key, tone_key, provider_id)
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS audio_effect_active_mappings (
                song_key TEXT NOT NULL,
                tone_key TEXT NOT NULL,
                mapping_id INTEGER NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (song_key, tone_key),
                FOREIGN KEY (mapping_id) REFERENCES audio_effect_mappings(id) ON DELETE CASCADE
            )
        """)
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_audio_effect_mappings_provider "
            "ON audio_effect_mappings(provider_id)"
        )
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_audio_effect_mappings_filename "
            "ON audio_effect_mappings(filename)"
        )
        self.conn.commit()
        self._lock = threading.Lock()

    @staticmethod
    def _text(value, *, field: str, limit: int, allow_empty: bool = False) -> str:
        if value is None:
            text = ""
        elif not isinstance(value, str):
            raise ValueError(f"{field} must be a string")
        else:
            text = value.strip()
        if not text and not allow_empty:
            raise ValueError(f"{field} is required")
        if len(text) > limit:
            raise ValueError(f"{field} is too long")
        return text

    @staticmethod
    def _mapping_id(value) -> int | None:
        # Bind only values SQLite can store as an INTEGER; an out-of-range id is a
        # clean miss (404), not a 500 at bind time.
        if isinstance(value, int) and not isinstance(value, bool) and -(2 ** 63) <= value < 2 ** 63:
            return value
        return None

    @staticmethod
    def _field(data: dict, *keys):
        # Select the first present snake/camel alias by key, not by truthiness, so a
        # falsey non-string value (false/0) still reaches _text() and is rejected
        # instead of being silently swallowed by an `or` chain.
        for key in keys:
            if key in data:
                return data[key]
        return None

    @staticmethod
    def _metadata(value) -> str:
        if value is None:
            return "{}"
        if not isinstance(value, dict):
            raise ValueError("metadata must be an object")
        encoded = json.dumps(value, ensure_ascii=True, sort_keys=True)
        if len(encoded) > 8192:
            raise ValueError("metadata is too large")
        return encoded

    @staticmethod
    def _row(row) -> dict | None:
        if row is None:
            return None
        metadata = {}
        try:
            metadata = json.loads(row[8]) if row[8] else {}
        except Exception:
            metadata = {}
        return {
            "id": int(row[0]),
            "song_key": row[1],
            "filename": row[2] or "",
            "tone_key": row[3],
            "provider_id": row[4],
            "provider_ref": row[5],
            "label": row[6] or "",
            "source": row[7] or "manual",
            "metadata": metadata if isinstance(metadata, dict) else {},
            "created_at": row[9] or "",
            "updated_at": row[10] or "",
            "active": bool(row[11]),
        }

    def _select_sql(self) -> str:
        return """
            SELECT m.id, m.song_key, m.filename, m.tone_key, m.provider_id,
                   m.provider_ref, m.label, m.source, m.metadata_json,
                   m.created_at, m.updated_at,
                   CASE WHEN a.mapping_id IS NULL THEN 0 ELSE 1 END AS active
            FROM audio_effect_mappings m
            LEFT JOIN audio_effect_active_mappings a
              ON a.song_key = m.song_key AND a.tone_key = m.tone_key AND a.mapping_id = m.id
        """

    def list(self, *, song_key: str = "", filename: str = "", tone_key: str = "", provider_id: str = "") -> list[dict]:
        clauses: list[str] = []
        params: list[str] = []
        song_key = self._text(song_key, field="song_key", limit=240, allow_empty=True)
        filename = self._text(filename, field="filename", limit=500, allow_empty=True)
        tone_key = self._text(tone_key, field="tone_key", limit=160, allow_empty=True)
        provider_id = self._text(provider_id, field="provider_id", limit=96, allow_empty=True)
        if song_key and filename:
            clauses.append("(m.song_key = ? OR m.filename = ?)")
            params.extend([song_key, filename])
        elif song_key:
            clauses.append("m.song_key = ?")
            params.append(song_key)
        elif filename:
            clauses.append("(m.song_key = ? OR m.filename = ?)")
            params.extend([filename, filename])
        if tone_key:
            clauses.append("m.tone_key = ?")
            params.append(tone_key)
        if provider_id:
            clauses.append("m.provider_id = ?")
            params.append(provider_id)
        sql = self._select_sql()
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY m.song_key COLLATE NOCASE, m.tone_key COLLATE NOCASE, m.provider_id COLLATE NOCASE"
        with self._lock:
            rows = self.conn.execute(sql, params).fetchall()
        return [self._row(row) for row in rows]

    def get(self, mapping_id: int) -> dict | None:
        mapping_id = self._mapping_id(mapping_id)
        if mapping_id is None:
            return None
        with self._lock:
            row = self.conn.execute(self._select_sql() + " WHERE m.id = ?", (mapping_id,)).fetchone()
        return self._row(row)

    def upsert(self, data: dict) -> dict:
        if not isinstance(data, dict):
            raise ValueError("mapping body must be an object")
        filename = self._text(data.get("filename", ""), field="filename", limit=500, allow_empty=True)
        song_key_raw = self._field(data, "song_key", "songKey")
        if song_key_raw is None or song_key_raw == "":
            song_key_raw = filename
        song_key = self._text(song_key_raw, field="song_key", limit=240)
        tone_key = self._text(self._field(data, "tone_key", "toneKey"), field="tone_key", limit=160, allow_empty=True)
        provider_id = self._text(self._field(data, "provider_id", "providerId"), field="provider_id", limit=96)
        provider_ref = self._text(self._field(data, "provider_ref", "providerRef"), field="provider_ref", limit=240)
        label = self._text(data.get("label", ""), field="label", limit=160, allow_empty=True)
        source = self._text(data.get("source", "manual"), field="source", limit=40, allow_empty=True) or "manual"
        metadata_json = self._metadata(data.get("metadata", {}))
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO audio_effect_mappings
                    (song_key, filename, tone_key, provider_id, provider_ref, label, source, metadata_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(song_key, tone_key, provider_id) DO UPDATE SET
                    -- Only overwrite filename when a non-empty one was supplied; an
                    -- omitted/empty filename must preserve the stored value (it's an
                    -- alternate lookup key for list(..., filename=...)).
                    filename=CASE WHEN excluded.filename <> '' THEN excluded.filename ELSE audio_effect_mappings.filename END,
                    provider_ref=excluded.provider_ref,
                    label=excluded.label,
                    source=excluded.source,
                    metadata_json=excluded.metadata_json,
                    updated_at=datetime('now')
                """,
                (song_key, filename, tone_key, provider_id, provider_ref, label, source, metadata_json),
            )
            row = self.conn.execute(
                "SELECT id FROM audio_effect_mappings WHERE song_key = ? AND tone_key = ? AND provider_id = ?",
                (song_key, tone_key, provider_id),
            ).fetchone()
            if row is None:
                raise ValueError("failed to create audio-effects mapping")
            mapping_id = int(row[0])
            if data.get("active") is True:
                self.conn.execute(
                    """
                    INSERT INTO audio_effect_active_mappings (song_key, tone_key, mapping_id, updated_at)
                    VALUES (?, ?, ?, datetime('now'))
                    ON CONFLICT(song_key, tone_key) DO UPDATE SET
                        mapping_id=excluded.mapping_id,
                        updated_at=datetime('now')
                    """,
                    (song_key, tone_key, mapping_id),
                )
            self.conn.commit()
        return self.get(mapping_id)

    def delete(self, mapping_id: int, *, provider_id: str = "") -> bool:
        mapping_id = self._mapping_id(mapping_id)
        if mapping_id is None:
            return False
        provider_id = self._text(provider_id, field="provider_id", limit=96, allow_empty=True)
        with self._lock:
            if provider_id:
                cur = self.conn.execute(
                    "DELETE FROM audio_effect_mappings WHERE id = ? AND provider_id = ?",
                    (mapping_id, provider_id),
                )
            else:
                cur = self.conn.execute("DELETE FROM audio_effect_mappings WHERE id = ?", (mapping_id,))
            self.conn.commit()
            return cur.rowcount > 0

    def activate(self, mapping_id: int, *, provider_id: str = "") -> dict | None:
        mapping_id = self._mapping_id(mapping_id)
        if mapping_id is None:
            return None
        provider_id = self._text(provider_id, field="provider_id", limit=96, allow_empty=True)
        with self._lock:
            row = self.conn.execute(
                self._select_sql() + " WHERE m.id = ?",
                (mapping_id,),
            ).fetchone()
            mapping = self._row(row)
            if not mapping or (provider_id and mapping["provider_id"] != provider_id):
                return None
            self.conn.execute(
                """
                INSERT INTO audio_effect_active_mappings (song_key, tone_key, mapping_id, updated_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(song_key, tone_key) DO UPDATE SET
                    mapping_id=excluded.mapping_id,
                    updated_at=datetime('now')
                """,
                (mapping["song_key"], mapping["tone_key"], mapping_id),
            )
            self.conn.commit()
            selected = self.conn.execute(self._select_sql() + " WHERE m.id = ?", (mapping_id,)).fetchone()
        return self._row(selected)

    def clear_active(self, *, song_key: str, tone_key: str) -> bool:
        song_key = self._text(song_key, field="song_key", limit=240)
        tone_key = self._text(tone_key, field="tone_key", limit=160, allow_empty=True)
        with self._lock:
            cur = self.conn.execute(
                "DELETE FROM audio_effect_active_mappings WHERE song_key = ? AND tone_key = ?",
                (song_key, tone_key),
            )
            self.conn.commit()
            return cur.rowcount > 0
