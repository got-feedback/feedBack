import logging

log = logging.getLogger("feedBack.instruments")

_INSTRUMENT_KINDS = frozenset({"stringed", "percussion", "keyboard", "vocal", "custom"})
_DETECT_STRATEGIES = frozenset({"pitch", "onset", "midi", "none"})
_PATH_FLAGS = frozenset({"path_lead", "path_rhythm", "path_bass"})
_PROFILE_PATHWAYS = ("songs", "practice", "learn", "studio")


def _validate_str(value, field_name, max_len=128):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be a non-empty string")
    if len(value) > max_len:
        raise ValueError(f"{field_name} must be <= {max_len} chars")
    return value.strip()


def _validate_optional_str(value, field_name, max_len=256):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a string or null")
    if len(value) > max_len:
        raise ValueError(f"{field_name} must be <= {max_len} chars")
    return value


def _validate_float_range(value, field_name, lo, hi):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(f"{field_name} must be a number")
    v = float(value)
    if v < lo or v > hi:
        raise ValueError(f"{field_name} must be in [{lo}, {hi}]")
    return v


def _validate_midi_list(lst, field_name, expected_len):
    if not isinstance(lst, list):
        raise ValueError(f"{field_name} must be a list")
    if len(lst) != expected_len:
        raise ValueError(f"{field_name} must have {expected_len} entries, got {len(lst)}")
    result = []
    for i, v in enumerate(lst):
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError(f"{field_name}[{i}] must be an integer")
        midi = int(v)
        if midi < 0 or midi > 127:
            raise ValueError(f"{field_name}[{i}] is out of MIDI range (0-127)")
        result.append(midi)
    return result


def _validate_offset_list(lst, field_name, expected_len):
    if not isinstance(lst, list):
        raise ValueError(f"{field_name} must be a list of offsets")
    if len(lst) != expected_len:
        raise ValueError(f"{field_name} must have {expected_len} entries, got {len(lst)}")
    result = []
    for i, v in enumerate(lst):
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError(f"{field_name}[{i}] must be an integer")
        off = int(v)
        if off < -12 or off > 12:
            raise ValueError(f"{field_name}[{i}] offset {off} out of range [-12, 12]")
        result.append(off)
    return result


class InstrumentRegistry:
    def __init__(self):
        self._instruments: dict[str, dict] = {}

    def register(self, definition: dict):
        inst_id = _validate_str(definition.get("id"), "instrument.id")
        if inst_id in self._instruments:
            raise ValueError(f"instrument {inst_id!r} is already registered")
        label = _validate_str(definition.get("label", inst_id), "instrument.label")
        kind = _validate_str(definition.get("kind", "custom"), "instrument.kind")
        if kind not in _INSTRUMENT_KINDS:
            raise ValueError(f"instrument.kind must be one of {sorted(_INSTRUMENT_KINDS)}")
        icon = _validate_optional_str(definition.get("icon"), "instrument.icon")
        detect_strategy = definition.get("detect_strategy", "none")
        if detect_strategy not in _DETECT_STRATEGIES:
            raise ValueError(f"instrument.detect_strategy must be one of {sorted(_DETECT_STRATEGIES)}")
        ref_pitch = _validate_float_range(
            definition.get("reference_pitch", 440.0), "instrument.reference_pitch", 430, 450,
        )

        string_counts = definition.get("string_counts")
        if kind == "stringed":
            if not isinstance(string_counts, list) or not string_counts:
                raise ValueError("instrument.string_counts must be a non-empty list for stringed instruments")
            sc_list = []
            for v in string_counts:
                if isinstance(v, bool) or not isinstance(v, (int, float)):
                    raise ValueError("instrument.string_counts entries must be integers")
                sc_list.append(int(v))
            string_counts = sorted(set(sc_list))
        else:
            string_counts = []

        default_sc = definition.get("default_string_count", 0)
        if kind == "stringed":
            if default_sc not in string_counts:
                raise ValueError(f"instrument.default_string_count {default_sc} not in string_counts {string_counts}")
        else:
            default_sc = 0

        key_counts = definition.get("key_counts")
        if kind == "keyboard":
            if not isinstance(key_counts, list) or not key_counts:
                raise ValueError("instrument.key_counts must be a non-empty list for keyboard instruments")
            kc_list = []
            for v in key_counts:
                if isinstance(v, bool) or not isinstance(v, (int, float)):
                    raise ValueError("instrument.key_counts entries must be integers")
                kc_list.append(int(v))
            key_counts = sorted(set(kc_list))
        else:
            key_counts = []

        default_kc = definition.get("default_key_count", 0)
        if kind == "keyboard":
            if default_kc not in key_counts:
                raise ValueError(f"instrument.default_key_count {default_kc} not in key_counts {key_counts}")
        else:
            default_kc = 0

        standard_tunings = {}
        raw_std = definition.get("standard_tunings") or {}
        if kind == "stringed":
            if not isinstance(raw_std, dict):
                raise ValueError("instrument.standard_tunings must be a dict")
            for sc in string_counts:
                key = str(sc)
                if key not in raw_std:
                    raise ValueError(f"instrument.standard_tunings missing key {key!r}")
                standard_tunings[key] = _validate_midi_list(raw_std[key], f"standard_tunings[{key}]", sc)
        else:
            standard_tunings = {}

        tunings = {}
        raw_tunes = definition.get("tunings") or {}
        if kind == "stringed":
            if not isinstance(raw_tunes, dict):
                raise ValueError("instrument.tunings must be a dict")
            for sc in string_counts:
                key = str(sc)
                sc_tunings = raw_tunes.get(key) or {}
                if "Standard" not in sc_tunings:
                    raise ValueError(f"instrument.tunings[{key}] must include 'Standard'")
                resolved = {}
                for t_name, t_offsets in sc_tunings.items():
                    resolved[_validate_str(t_name, f"tunings[{key}].name")] = _validate_offset_list(
                        t_offsets, f"tunings[{key}][{t_name!r}]", sc,
                    )
                tunings[key] = resolved
        else:
            tunings = {}

        roles = []
        role_ids = set()
        has_default = False
        raw_roles = definition.get("roles") or []
        if not isinstance(raw_roles, list):
            raise ValueError("instrument.roles must be a list")
        for i, role in enumerate(raw_roles):
            if not isinstance(role, dict):
                raise ValueError(f"instrument.roles[{i}] must be an object")
            r_id = _validate_str(role.get("id"), f"roles[{i}].id", 32)
            if r_id in role_ids:
                raise ValueError(f"duplicate role id {r_id!r}")
            role_ids.add(r_id)
            r_label = _validate_str(role.get("label", r_id), f"roles[{i}].label", 32)
            r_flags = role.get("arrangement_flags") or []
            if not isinstance(r_flags, list):
                raise ValueError(f"roles[{i}].arrangement_flags must be a list")
            for flag in r_flags:
                if flag not in _PATH_FLAGS:
                    raise ValueError(f"roles[{i}].arrangement_flags: unknown flag {flag!r}")
            r_names = role.get("arrangement_names") or []
            if not isinstance(r_names, list):
                raise ValueError(f"roles[{i}].arrangement_names must be a list")
            r_default = bool(role.get("default"))
            if r_default:
                if has_default:
                    raise ValueError("only one role can have default: true")
                has_default = True
            roles.append({
                "id": r_id,
                "label": r_label,
                "arrangement_flags": list(set(r_flags)),
                "arrangement_names": [n.strip().lower() for n in r_names if isinstance(n, str) and n.strip()],
                "default": r_default,
            })
        if roles and not has_default:
            roles[0]["default"] = True

        normalized = {
            "id": inst_id,
            "label": label,
            "kind": kind,
            "icon": icon,
            "_plugin_id": definition.get("_plugin_id"),
            "string_counts": string_counts,
            "default_string_count": default_sc,
            "key_counts": key_counts,
            "default_key_count": default_kc,
            "detect_strategy": detect_strategy,
            "reference_pitch": ref_pitch,
            "standard_tunings": standard_tunings,
            "tunings": tunings,
            "roles": roles,
        }
        self._instruments[inst_id] = normalized
        log.info("registered instrument %r (%s)", inst_id, label)

    def unregister(self, instrument_id: str):
        if instrument_id in self._instruments:
            del self._instruments[instrument_id]
            log.info("unregistered instrument %r", instrument_id)

    def get(self, instrument_id: str) -> dict | None:
        return self._instruments.get(instrument_id)

    def get_all(self) -> list[dict]:
        return list(self._instruments.values())

    def compute_tuning_midis(self, instrument_id: str, string_count: int, tuning_name: str) -> list[int] | None:
        inst = self._instruments.get(instrument_id)
        if not inst or inst["kind"] != "stringed":
            return None
        key = str(string_count)
        std = inst["standard_tunings"].get(key)
        offsets = (inst["tunings"].get(key) or {}).get(tuning_name)
        if not std or not offsets or len(std) != len(offsets):
            return None
        return [s + o for s, o in zip(std, offsets)]

    def get_tuning_names(self, instrument_id: str, string_count: int) -> list[str]:
        inst = self._instruments.get(instrument_id)
        if not inst or inst["kind"] != "stringed":
            return []
        return list((inst["tunings"].get(str(string_count)) or {}).keys())

    def get_standard_midis(self, instrument_id: str, string_count: int) -> list[int] | None:
        inst = self._instruments.get(instrument_id)
        if not inst or inst["kind"] != "stringed":
            return None
        return inst["standard_tunings"].get(str(string_count))

    def get_default_role(self, instrument_id: str) -> str | None:
        inst = self._instruments.get(instrument_id)
        if not inst:
            return None
        for role in inst["roles"]:
            if role["default"]:
                return role["id"]
        if inst["roles"]:
            return inst["roles"][0]["id"]
        return None

    def find_role_by_arrangement(self, instrument_id: str, arr_name: str, arr_flags: dict = None) -> str | None:
        inst = self._instruments.get(instrument_id)
        if not inst:
            return None
        name_lower = (arr_name or "").strip().lower()
        for role in inst["roles"]:
            if name_lower in role["arrangement_names"]:
                return role["id"]
            if arr_flags:
                for flag in role["arrangement_flags"]:
                    if arr_flags.get(flag):
                        return role["id"]
        return None

    def instrument_id_for_arrangement(self, arr_name: str, arr_flags: dict = None) -> str | None:
        name_lower = (arr_name or "").strip().lower()
        for inst in self._instruments.values():
            for role in inst["roles"]:
                if name_lower in role["arrangement_names"]:
                    return inst["id"]
                if arr_flags:
                    for flag in role["arrangement_flags"]:
                        if arr_flags.get(flag):
                            return inst["id"]
        return None
