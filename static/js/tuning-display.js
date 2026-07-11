// Tuning display — naming, string counts, and target frequencies.
//
// Carved verbatim out of static/app.js (R3a). A LEAF module: imports nothing.
//
// Turns raw per-string semitone offsets into things a human reads: a tuning NAME
// ("Drop D", "Eb Standard", or a raw-offsets fallback), whether an arrangement is
// bass, its effective string count, and the target FREQUENCIES + note names the
// tuner checks against. Pure functions over a small MIDI/note-name table.
//
// The window / window.feedBack assignments for these stay in app.js — they are the
// public contract (constitution II names window.feedBack), and app.js re-exposes
// the imported bindings from exactly where it always did, so nothing about the
// surface or its ordering changes.

// Display-only tuning label helpers — never mutate offsets or affect playback.
function _looksLikeRawTuningOffsets(str) {
    if (!str || typeof str !== 'string') return false;
    const s = str.trim();
    if (!s) return false;
    if (/^-?\d+$/.test(s)) return true;
    if (/^-?\d+(?: -?\d+)+$/.test(s)) return true;
    if (/^-?\d+(?:,-?\d+)+$/.test(s)) return true;
    if (/^-?\d+(-?\d+){2,}$/.test(s)) return true;
    return false;
}

function _tuningNameFromOffsets(offsets) {
    if (!offsets || !offsets.length) return '';
    const standard = {
        0: 'E Standard', '-1': 'Eb Standard', '-2': 'D Standard',
        '-3': 'C# Standard', '-4': 'C Standard', '-5': 'B Standard',
        '-6': 'Bb Standard', '-7': 'A Standard',
        1: 'F Standard', 2: 'F# Standard',
    };
    // Uniform offsets across 4 (bass) / 5 / 6 strings name the same Standard;
    // a 4-string bass [0,0,0,0] must read "E Standard", not "Custom Tuning".
    if (offsets.length >= 4 && offsets.every((o) => o === offsets[0])) {
        const name = standard[offsets[0]];
        if (name) return name;
    }
    if (offsets.length >= 4 && offsets[0] === offsets[1] - 2
            && offsets.slice(1).every((o) => o === offsets[1])) {
        const noteNames = ['E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B', 'C', 'C#', 'D', 'Eb'];
        return 'Drop ' + noteNames[((offsets[0] % 12) + 12) % 12];
    }
    const named = {
        '-2,0,0,0,0,0': 'Drop D',
        '-4,-2,-2,-2,-2,-2': 'Drop C',
        '-2,-2,0,0,0,0': 'Double Drop D',
        '0,0,0,-1,0,0': 'Open G',
        '-2,-2,0,0,-2,-2': 'Open D',
        '-2,0,0,0,-2,0': 'DADGAD',
        '0,2,2,1,0,0': 'Open E',
        '-2,0,0,2,3,2': 'Open D (alt)',
    };
    if (offsets.length === 6) {
        const key = offsets.join(',');
        if (named[key]) return named[key];
    }
    return 'Custom Tuning';
}

export function displayTuningName(value, offsets) {
    // Explicit offsets win — always name them.
    if (Array.isArray(offsets) && offsets.length > 0) {
        return _tuningNameFromOffsets(offsets);
    }
    if (value && typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed || trimmed === 'Unknown') return '';
        if (!_looksLikeRawTuningOffsets(trimmed)) {
            return trimmed;
        }
        // A raw offset string (now served by the API) — parse and name it so a
        // known tuning like "-1 -1 -1 -1 -1 -1" reads "Eb Standard" rather than
        // collapsing to "Custom Tuning".
        const parsed = (typeof parseRawTuningOffsets === 'function')
            ? parseRawTuningOffsets(trimmed) : null;
        if (parsed && parsed.length) return _tuningNameFromOffsets(parsed);
        return 'Custom Tuning';
    }
    return '';
}

export function isBassArrangement(context) {
    const ctx = context && typeof context === 'object' ? context : {};
    if (typeof ctx.isBass === 'boolean') return ctx.isBass;
    const label = ((ctx.arrangement || '') + ' ' + (ctx.arrangement_smart_name || '')).toLowerCase();
    if (/\bbass\b/.test(label)) return true;
    if (/\b(lead|rhythm|combo|guitar)\b/.test(label)) return false;
    return false;
}

export function effectiveStringCount(offsets, context) {
    if (!Array.isArray(offsets) || !offsets.length) return 0;
    const ctx = context && typeof context === 'object' ? context : {};
    const isBass = isBassArrangement(ctx);
    let sc = ctx.stringCount > 0 ? Number(ctx.stringCount) : 0;
    if (!isBass) {
        if (sc > 0 && sc <= 5 && offsets.length >= 6) sc = 6;
        if (!sc) sc = offsets.length >= 6 ? offsets.length : 6;
    } else if (!sc) {
        sc = offsets.length >= 5 ? offsets.length : 4;
    }
    return Math.min(sc, offsets.length);
}

export function songTuningContext(songInfo) {
    if (!songInfo || typeof songInfo !== 'object') return {};
    return {
        stringCount: songInfo.stringCount,
        arrangement: songInfo.arrangement,
        arrangement_smart_name: songInfo.arrangement_smart_name,
    };
}

// Open-string target notes (display only) — mirrors plugins/tuner/utils/tuning-utils.js.
const _TUNING_BASE_MIDI = {
    4: [28, 33, 38, 43],
    5: [23, 28, 33, 38, 43],
    6: [40, 45, 50, 55, 59, 64],
    7: [35, 40, 45, 50, 55, 59, 64],
    8: [30, 35, 40, 45, 50, 55, 59, 64],
};

const _TUNING_NOTE_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const _TUNING_NOTE_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

function _tuningMidiToFreq(m) {
    return Math.pow(2, (m - 69) / 12) * 440;
}

function _tuningOffsetsToFreqs(offsets, isBass) {
    const len = offsets.length;
    let base;
    if (len === 4 || len === 5) {
        base = isBass ? _TUNING_BASE_MIDI[len] : _TUNING_BASE_MIDI[6];
    } else {
        base = _TUNING_BASE_MIDI[len] || _TUNING_BASE_MIDI[6];
    }
    return offsets.map((offset, i) => {
        const root = i < base.length ? base[i] : base[base.length - 1];
        return _tuningMidiToFreq(root + offset);
    });
}

function _noteNameFromFreq(freq, useFlats) {
    const midi = 69 + 12 * Math.log2(freq / 440);
    const rounded = Math.round(midi);
    const names = useFlats ? _TUNING_NOTE_FLAT : _TUNING_NOTE_SHARP;
    return names[((rounded % 12) + 12) % 12];
}

function _octaveNoteFromFreq(freq, useFlats) {
    const midi = 69 + 12 * Math.log2(freq / 440);
    const rounded = Math.round(midi);
    const octave = Math.floor(rounded / 12) - 1;
    return _noteNameFromFreq(freq, useFlats) + octave;
}

function _stringOrdinalLabel(n) {
    const v = n % 100;
    if (v >= 11 && v <= 13) return n + 'th';
    const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
    return n + suffix;
}

function _tuningTargetFreqs(offsets, context) {
    if (!Array.isArray(offsets) || !offsets.length) return [];
    const ctx = context && typeof context === 'object' ? context : {};
    const stringCount = effectiveStringCount(offsets, ctx);
    const trimmed = offsets.slice(0, stringCount);
    if (!trimmed.length) return [];
    const isBass = isBassArrangement(ctx);
    try {
        return _tuningOffsetsToFreqs(trimmed, isBass);
    } catch (_) {
        return [];
    }
}

// Flat vs sharp spelling. A caller that knows the preference can pass
// ctx.useFlats; otherwise we infer from a flat-keyed tuning name. The v3
// card/HUD pass "Custom Tuning" (raw offsets carry no key), so those default
// to sharps unless an explicit useFlats is supplied.
function _resolveTargetUseFlats(ctx) {
    if (typeof ctx.useFlats === 'boolean') return ctx.useFlats;
    return typeof ctx.tuningName === 'string' && /\b[A-G]b\b/.test(ctx.tuningName);
}

export function displayTuningTargetDetails(offsets, context) {
    const ctx = context && typeof context === 'object' ? context : {};
    const useFlats = _resolveTargetUseFlats(ctx);
    const freqs = _tuningTargetFreqs(offsets, ctx);
    return freqs.map((f, i) => {
        const stringNumber = freqs.length - i;
        const note = _noteNameFromFreq(f, useFlats);
        const octaveNote = _octaveNoteFromFreq(f, useFlats);
        return {
            stringNumber,
            note,
            octaveNote,
            title: _stringOrdinalLabel(stringNumber) + ' string: ' + octaveNote,
        };
    });
}

export function displayTuningTargets(offsets, context) {
    const ctx = context && typeof context === 'object' ? context : {};
    const useFlats = _resolveTargetUseFlats(ctx);
    const freqs = _tuningTargetFreqs(offsets, ctx);
    if (!freqs.length) return '';
    return freqs.map((f) => _noteNameFromFreq(f, useFlats)).join(' ');
}

export function parseRawTuningOffsets(value) {
    if (Array.isArray(value) && value.length) return value;
    if (!value || typeof value !== 'string') return null;
    const s = value.trim();
    if (/^-?\d+(?: -?\d+)+$/.test(s)) {
        return s.split(/\s+/).map((n) => Number(n));
    }
    if (/^-?\d+(?:,-?\d+)+$/.test(s)) {
        return s.split(',').map((n) => Number(n));
    }
    return null;
}
