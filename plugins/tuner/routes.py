"""Tuner plugin — persist last selected tuning and custom tunings in config_dir."""

import json
import logging
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.responses import Response

DEFAULT_TUNING = "Standard"
DEFAULT_INSTRUMENT = "guitar-6"

_INSTRUMENT_BY_STRING_COUNT = {4: "bass-4", 5: "bass-5", 7: "guitar-7", 8: "guitar-8"}


def _migrate_custom_tuning(name: str, value) -> dict:
    """Return {instrument, strings} for both old flat-list and new dict formats."""
    if isinstance(value, list):
        instrument = _INSTRUMENT_BY_STRING_COUNT.get(len(value), "guitar-6")
        return {"instrument": instrument, "strings": value}
    if isinstance(value, dict) and "strings" in value:
        return value
    return {"instrument": "guitar-6", "strings": []}


def setup(app: FastAPI, context: dict):
    config_dir = Path(context["config_dir"])
    config_file = config_dir / "tuner.json"
    log = context.get("log") or logging.getLogger("feedBack.plugin.tuner")

    def _read() -> dict:
        defaults = {
            "lastTuning": DEFAULT_TUNING,
            "lastInstrument": DEFAULT_INSTRUMENT,
            "freeTune": False,
            "customTunings": {},
            "disabledTunings": [],
            "showFloatingButton": True,
            "visualizationMode": "default",
            "audioInputMode": "auto",
        }
        if not config_file.exists():
            return defaults
        try:
            data = json.loads(config_file.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                return defaults

            res = {}
            res["lastTuning"] = str(data.get("lastTuning", DEFAULT_TUNING))
            res["lastInstrument"] = str(data.get("lastInstrument", DEFAULT_INSTRUMENT))
            res["freeTune"] = bool(data.get("freeTune", False))
            res["customTunings"] = data.get("customTunings", {})
            res["disabledTunings"] = data.get("disabledTunings", [])
            res["showFloatingButton"] = bool(data.get("showFloatingButton", True))
            res["visualizationMode"] = str(data.get("visualizationMode", "default"))
            raw_mode = str(data.get("audioInputMode", "auto"))
            res["audioInputMode"] = raw_mode if raw_mode in ("auto", "browser") else "auto"

            if not isinstance(res["customTunings"], dict):
                res["customTunings"] = {}
            if not isinstance(res["disabledTunings"], list):
                res["disabledTunings"] = []

            # Migrate custom tunings from old flat-list format
            res["customTunings"] = {
                name: _migrate_custom_tuning(name, val)
                for name, val in res["customTunings"].items()
            }

            # Strip legacy disabledTunings entries that lack compound "instrument:name" format
            res["disabledTunings"] = [
                e for e in res["disabledTunings"]
                if isinstance(e, str) and ":" in e
            ]

            return res
        except Exception:
            return defaults

    def _write(data: dict) -> None:
        config_dir.mkdir(parents=True, exist_ok=True)
        current = _read()
        # Strip keys that belong to core, not to this plugin's config.
        for key in ("defaultTunings", "referencePitch"):
            data = {k: v for k, v in data.items() if k != key}
        current.update(data)
        config_file.write_text(json.dumps(current, indent=2), encoding="utf-8")

    def _get_custom_tunings() -> dict:
        """Return custom tunings in DEFAULT_TUNINGS format: {instrument: {name: [freqs]}}."""
        cfg = _read()
        result: dict[str, dict] = {}
        for name, val in cfg.get("customTunings", {}).items():
            inst = val.get("instrument", "guitar-6")
            strings = val.get("strings", [])
            if strings:
                result.setdefault(inst, {})[name] = strings
        return result

    # Register this plugin as a tuning provider for its custom tunings.
    context["register_tuning_provider"]("tuner", _get_custom_tunings)
    log.info("tuner: registered custom tuning provider")

    _viz_dir = Path(__file__).parent / "visualization"
    _viz_assets_dir = Path(__file__).parent / "visualization" / "assets"
    _workers_dir = Path(__file__).parent / "workers"
    _utils_dir = Path(__file__).parent / "utils"

    _ASSET_MEDIA_TYPES = {".svg": "image/svg+xml", ".png": "image/png"}

    def _serve_js_from(base_dir: Path, filename: str) -> Response:
        target = (base_dir / filename).resolve()
        try:
            target.relative_to(base_dir.resolve())
        except ValueError:
            return Response("", status_code=404)
        if target.suffix == ".js" and target.is_file():
            return Response(target.read_text(encoding="utf-8"), media_type="application/javascript")
        return Response("", status_code=404)

    def _serve_asset_from(base_dir: Path, filename: str) -> Response:
        target = (base_dir / filename).resolve()
        try:
            target.relative_to(base_dir.resolve())
        except ValueError:
            return Response("", status_code=404)
        media_type = _ASSET_MEDIA_TYPES.get(target.suffix.lower())
        if media_type and target.is_file():
            return Response(target.read_bytes(), media_type=media_type)
        return Response("", status_code=404)

    @app.get("/api/plugins/tuner/visualization/{filename}")
    def get_viz_file(filename: str):
        return _serve_js_from(_viz_dir, filename)

    @app.get("/api/plugins/tuner/viz-assets/{filename}")
    def get_viz_asset(filename: str):
        return _serve_asset_from(_viz_assets_dir, filename)

    @app.get("/api/plugins/tuner/workers/{filename}")
    def get_worker_file(filename: str):
        return _serve_js_from(_workers_dir, filename)

    @app.get("/api/plugins/tuner/utils/{filename}")
    def get_utils_file(filename: str):
        return _serve_js_from(_utils_dir, filename)

    @app.get("/api/plugins/tuner/config")
    def get_config():
        return _read()

    @app.post("/api/plugins/tuner/config")
    async def set_config(req: Request):
        body = await req.json()
        _write(body)
        return {"ok": True}
