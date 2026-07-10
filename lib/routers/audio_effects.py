"""Audio-effects mapping API — the core-owned song/tone -> provider routing index.

Extracted verbatim from ``server.py`` (R3); only the decorator receiver
(``@app`` -> ``@router``) and the singleton read (``audio_effect_mappings`` ->
``appstate.audio_effect_mappings``) changed. The read must stay a module
attribute so a re-imported ``server`` re-publishes a fresh DB into the seam and
`monkeypatch.setattr` reaches this module — see ``appstate.py``.
"""

from fastapi import APIRouter, Body, Query
from fastapi.responses import JSONResponse

import appstate

router = APIRouter()


def _audio_effects_error(exc: Exception):
    return JSONResponse({"error": str(exc)}, status_code=400)


@router.get("/api/audio-effects/mappings")
def list_audio_effect_mappings(
    song_key: str = Query(""),
    filename: str = Query(""),
    tone_key: str = Query(""),
    provider_id: str = Query(""),
):
    try:
        return {
            "mappings": appstate.audio_effect_mappings.list(
                song_key=song_key,
                filename=filename,
                tone_key=tone_key,
                provider_id=provider_id,
            )
        }
    except ValueError as exc:
        return _audio_effects_error(exc)


@router.post("/api/audio-effects/mappings")
def upsert_audio_effect_mapping(data: dict = Body(...)):
    try:
        mapping = appstate.audio_effect_mappings.upsert(data)
    except ValueError as exc:
        return _audio_effects_error(exc)
    return {"ok": True, "mapping": mapping}


@router.delete("/api/audio-effects/mappings/{mapping_id}")
def delete_audio_effect_mapping(mapping_id: int, provider_id: str = Query("")):
    try:
        deleted = appstate.audio_effect_mappings.delete(mapping_id, provider_id=provider_id)
    except ValueError as exc:
        return _audio_effects_error(exc)
    if not deleted:
        return JSONResponse({"error": "mapping not found"}, status_code=404)
    return {"ok": True}


@router.post("/api/audio-effects/mappings/{mapping_id}/activate")
def activate_audio_effect_mapping(mapping_id: int, data: dict = Body(default_factory=dict)):
    try:
        provider_id = data.get("provider_id") if "provider_id" in data else data.get("providerId")
        mapping = appstate.audio_effect_mappings.activate(mapping_id, provider_id="" if provider_id is None else provider_id)
    except ValueError as exc:
        return _audio_effects_error(exc)
    if not mapping:
        return JSONResponse({"error": "mapping not found"}, status_code=404)
    return {"ok": True, "mapping": mapping}


@router.delete("/api/audio-effects/active-mapping")
def clear_audio_effect_active_mapping(song_key: str = Query(...), tone_key: str = Query("")):
    try:
        cleared = appstate.audio_effect_mappings.clear_active(song_key=song_key, tone_key=tone_key)
    except ValueError as exc:
        return _audio_effects_error(exc)
    return {"ok": True, "cleared": cleared}
