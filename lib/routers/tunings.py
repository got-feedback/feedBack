"""The merged tuning catalog (/api/tunings).

Extracted verbatim from server.py (R3) except @app->@router, CONFIG_DIR->
appstate.config_dir, _load_config imported from lib/appconfig, and the tuning
registry read through the appstate seam (appstate.tuning_providers — the same
instance plugins register into via the plugin_context in server.py).
"""

from fastapi import APIRouter

import appstate
from appconfig import _load_config
from tunings import DEFAULT_REFERENCE_PITCH, freqs_to_midis, open_midis_to_freqs, _build_preset_midis, instrument_key

router = APIRouter()


@router.get("/api/tunings")
def get_tunings():
    cfg = _load_config(appstate.config_dir / "config.json") or {}
    ref = cfg.get("reference_pitch", DEFAULT_REFERENCE_PITCH)
    try:
        ref = float(ref)
        if not (430.0 <= ref <= 450.0):
            ref = DEFAULT_REFERENCE_PITCH
    except (TypeError, ValueError):
        ref = DEFAULT_REFERENCE_PITCH
    merged = appstate.tuning_providers.get_merged(ref)
    # tuningMidis: the same catalog as exact integer MIDI notes (low → high).
    # Built-ins come straight from TUNING_PRESET_MIDIS (no float round-trip);
    # provider-contributed entries are recovered from their frequencies at the
    # served reference pitch. Every consumer today (the v3 badges, plugins)
    # reconstructs midis client-side via log2 — a rounding footgun at non-440
    # references — so serve the integers once, host-side. Additive: the
    # existing referencePitch/tunings shape is unchanged.
    tuning_midis: dict[str, dict[str, list[int]]] = {}
    preset_midis = _build_preset_midis()

    # Merge custom tunings from instrument_overrides in config.json.
    # Custom tunings are stored as offset arrays keyed by instrument_id and
    # string count; they need to be resolved to MIDI via the instrument's
    # standard tuning reference.
    reg = getattr(appstate, "instrument_registry", None)
    overrides = (cfg.get("instrument_overrides") or {}) if isinstance(cfg, dict) else {}
    if reg and overrides:
        for inst_id, ov in overrides.items():
            custom_tunings = ov.get("custom_tunings") if isinstance(ov, dict) else None
            if not custom_tunings or not isinstance(custom_tunings, dict):
                continue
            inst_def = reg.get(inst_id)
            if not inst_def or inst_def.get("kind") != "stringed":
                continue
            std = inst_def.get("standard_tunings") or {}
            for sc_key, named_offsets in custom_tunings.items():
                key = instrument_key(inst_id, int(sc_key))
                std_midis = std.get(sc_key)
                if not std_midis:
                    continue
                for t_name, offsets in named_offsets.items():
                    if isinstance(offsets, list) and len(offsets) == len(std_midis):
                        midis = [int(s + o) for s, o in zip(std_midis, offsets)]
                        if all(0 <= m <= 127 for m in midis):
                            preset_midis.setdefault(key, {})[str(t_name)] = midis

    for key, names in merged.items():
        builtin = preset_midis.get(key, {})
        resolved: dict[str, list[int]] = {}
        for name, freqs in names.items():
            midis = builtin.get(name) or freqs_to_midis(freqs, ref)
            if midis:
                resolved[name] = list(midis)
        if resolved:
            tuning_midis[key] = resolved

    # Ensure every key from preset_midis appears in BOTH tuningMidis and tunings
    # (frequencies). The tuner plugin reads `tunings` for the instrument key
    # list; without this, instrument switches have no effect.
    for key, presets in preset_midis.items():
        builtin_freqs = {}
        for name, midis in presets.items():
            builtin_freqs[name] = open_midis_to_freqs(midis, ref)
        # tuningMidis
        if key not in tuning_midis:
            tuning_midis[key] = {str(k): list(v) for k, v in presets.items()}
        else:
            existing = tuning_midis[key]
            for name, midis in presets.items():
                if name not in existing:
                    existing[str(name)] = list(midis)
        # tunings (frequencies) — add provider data first, then fill gaps
        if key not in merged:
            merged[key] = builtin_freqs
        else:
            for name, freqs in builtin_freqs.items():
                if name not in merged[key]:
                    merged[key][name] = freqs

    return {"referencePitch": ref, "tunings": merged, "tuningMidis": tuning_midis}
