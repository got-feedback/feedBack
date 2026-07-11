// Section practice — the practice-a-section bar, its phrase parts, and the popover
// that drives them.
//
// THE FIRST SLICE OUT OF app.js's STRONGLY-CONNECTED CORE. It could not be cut by
// dependency closure: seeding a closure from section-practice, from loops, from
// count-in, or from the JUCE seek shim all return the SAME 178-function set, because
// setLoop() and practiceSection() call each other. So it is cut BY NAME, and
// everything it calls back into app.js goes through the host seam.
//
// It owns its own state — the _sectionPractice* / _sectionParents* scalars are read
// nowhere else and move in with it. It needs 11 hooks from app.js, and four of those
// are read-only GETTERS: loopA / loopB / _audioSeekGen / _loopMutationGen are only
// ever READ here, never written, so app.js keeps owning them and no state container
// is needed.
//
// app.js used to reach IN and reset this module's state directly (clearLoop() zeroed
// the selection; changeArrangement() invalidated the parent count). It cannot now — an
// imported binding is read-only — so those are exported as resetSelection() and
// invalidateParentCount(). That is strictly better: the module owns its own invariants
// instead of trusting two callers on the far side of the file to zero the right fields.
//
// ON THE SEAM: see ./host.js. Reading an unwired hook THROWS — there are no no-op
// defaults, because a host seam that can silently no-op is a trap. The plugin loader's
// seam had exactly that shape, and a dropped wiring line would have left the viz picker
// quietly not refreshing, with nothing to notice. tests/js/host_contract.test.js then
// fails CI if the hooks used here and the hooks wired in app.js ever drift apart — the
// layer that catches it on the paths a smoke test never runs.
import { audio } from './audio-el.js';
import { esc } from './dom.js';
import { _audioDuration, _audioTime, audioSeekGen } from './transport.js';
import { formatTime } from './format.js';
import { host } from './host.js';

export function _sectionPracticeBarContains(el) {
    if (!el) return false;
    const bar = document.getElementById('section-practice-bar');
    return !!(bar && bar.contains(el));
}

// ── Section Practice Bar ────────────────────────────────────────────────
// One-click looping over song section markers (highway.getSections —
// same array as 3D highway bundle.sections / "Now / Up Next").
// Reuses setLoop() so manual A/B controls and saved loops stay canonical.
let _sectionPracticeRanges = [];
let _sectionPracticeSelected = -1;
let _sectionPracticeFollowParent = -1;
let _sectionPracticeDurSynced = false;
let _sectionPracticeLogged = false;
let _sectionPracticeHooked = false;
let _sectionPracticeRetryTimer = null;
let _sectionPracticeLastPlayableCount = 0;
let _sectionPracticePlayablePopulateRerendered = false;
// Last-rendered parent count, so the bar can re-render when the parent layout
// changes after the initial render — notably when the synthetic "Start" section
// appears as notes-before-the-first-marker stream in late.
let _sectionPracticeLastParentCount = -1;
// Start-time identity of the active parent, tracked so it can be remapped to the
// correct index when the parent layout shifts (a late "Start" prepend moves every
// real parent by one) instead of leaving the raw index pointing at the wrong one.
let _sectionPracticeActiveParentStart = NaN;
let _sectionPracticeMode = false;
let _sectionPracticeActiveParent = -1;
let _sectionPracticeWholeSection = false;
let _sectionPracticeSavedPartIndex = 0;
// Monotonic token to cancel stale practiceSection() retries: a newer click
// (or a song/arrangement change, which also bumps _audioSeekGen) supersedes
// any in-flight retry loop so it can't re-arm the wrong loop/count-in.
let _sectionPracticeRequestGen = 0;
// >0 while a practiceSection() request is awaiting its loop. While set,
// _syncSectionPracticeFromLoop() (e.g. from a mid-await bar re-render) must not
// reconcile against the half-applied / previous loop — practiceSection owns the
// section state and applies it once its own gen check passes.
let _sectionPracticeRequestInFlight = 0;

export function _setSectionPracticeMode(on, opts = {}) {
    const next = !!on;
    if (next === _sectionPracticeMode && !opts.force) return;
    _sectionPracticeMode = next;
    const cb = document.getElementById('section-practice-mode');
    if (cb) cb.checked = _sectionPracticeMode;
    // Surface the "looping" state on the collapsed pill so the user can tell
    // Section Practice is armed without opening the popover.
    const pill = document.getElementById('section-practice-pill');
    if (pill) pill.classList.toggle('section-practice-pill--active', _sectionPracticeMode);
    _sectionPracticeFollowParent = -1;
    if (_sectionPracticeMode) {
        if (opts.defaultWholeOn) {
            _sectionPracticeWholeSection = true;
        }
        _updateSectionPracticeHighlight(_audioTime());
        if (opts.defaultWholeOn) {
            _syncSectionPracticePieceUi();
        }
    } else {
        // Turning the feature off must cancel any in-flight practiceSection()
        // retry: otherwise a stale setLoop() that lands after the user unchecks
        // Section Practice would re-arm the loop, flip the mode back on via
        // _syncSectionPracticeFromLoop(), and restart playback through
        // startCountIn(). Bumping the request gen makes the pending retry bail.
        _sectionPracticeRequestGen++;
        // Cancel any pending count-in: every section-practice teardown routes
        // through here (mode toggle off, clearLoop, and _hideSectionPracticeBar
        // on song/arrangement change), so a countdown started by a prior section
        // click must not resume playback after the user has turned practice off.
        host._cancelCountIn();
        _sectionPracticeSelected = -1;
        _sectionPracticeWholeSection = false;
        _sectionPracticeSavedPartIndex = 0;
        _updateSectionPracticeHighlight(_audioTime());
        if (!opts.skipClearLoop && (host.loopA() !== null || host.loopB() !== null)) {
            host.clearLoop();
        }
    }
}

export function onSectionPracticeModeChange() {
    const cb = document.getElementById('section-practice-mode');
    if (!cb) return;
    const turningOn = cb.checked && !_sectionPracticeMode;
    _setSectionPracticeMode(cb.checked, { defaultWholeOn: turningOn });
}

export function _resetSectionPracticeLog() {
    _sectionPracticeLogged = false;
    _sectionPracticeLastPlayableCount = 0;
    _sectionPracticePlayablePopulateRerendered = false;
}

function _sectionPracticeHighway() {
    return window.highway || (typeof highway !== 'undefined' ? highway : null);
}

function _sectionPracticeDuration() {
    const d = _audioDuration();
    if (d && Number.isFinite(d) && d > 0) return d;
    const cd = window.feedBack?.currentSong?.duration;
    return (cd && Number.isFinite(cd) && cd > 0) ? cd : 0;
}

export function _sectionPracticeSourceSections() {
    const hw = _sectionPracticeHighway();
    if (!hw || typeof hw.getSections !== 'function') return [];
    const raw = hw.getSections();
    return Array.isArray(raw) ? raw : [];
}

export function _sectionPracticeStartTime(s) {
    const t = s.time ?? s.startTime ?? s.start_time ?? s.start;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
}

function _sectionPracticeBaseName(rawName, fallbackIndex) {
    let s = (typeof rawName === 'string' ? rawName : '').trim();
    if (!s) s = `Section ${fallbackIndex + 1}`;
    // Normalise separators and strip common trailing digits like "Chorus 2"
    s = s.replace(/_/g, ' ');
    s = s.replace(/\s*\d+$/u, '');
    const lower = s.toLowerCase();
    const canonical = {
        intro: 'Intro',
        verse: 'Verse',
        chorus: 'Chorus',
        bridge: 'Bridge',
        solo: 'Solo',
        riff: 'Riff',
        outro: 'Outro',
    }[lower];
    if (canonical) return canonical;
    // Fallback: title-case words
    return lower.split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || `Section ${fallbackIndex + 1}`;
}

const _SECTION_PRACTICE_START_GAP_SEC = 0.05;

function _sectionPracticeNoteTime(note) {
    const t = note?.t ?? note?.time ?? note?.start_time ?? note?.start;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
}

function _sectionPracticePlayableCount() {
    const hw = _sectionPracticeHighway();
    if (!hw) return 0;
    let count = 0;
    if (typeof hw.getNotes === 'function') {
        const notes = hw.getNotes();
        if (notes?.length) count += notes.length;
    }
    if (typeof hw.getChords === 'function') {
        const chords = hw.getChords();
        if (chords?.length) count += chords.length;
    }
    return count;
}

function _sectionPracticeHasNotesBefore(beforeTime) {
    const hw = _sectionPracticeHighway();
    if (!hw) return false;
    const cutoff = Number(beforeTime);
    if (!Number.isFinite(cutoff)) return false;
    const sources = [];
    if (typeof hw.getNotes === 'function') {
        const notes = hw.getNotes();
        if (notes?.length) sources.push(notes);
    }
    if (typeof hw.getChords === 'function') {
        const chords = hw.getChords();
        if (chords?.length) sources.push(chords);
    }
    for (let s = 0; s < sources.length; s++) {
        const items = sources[s];
        for (let i = 0; i < items.length; i++) {
            const t = _sectionPracticeNoteTime(items[i]);
            if (Number.isFinite(t) && t < cutoff) return true;
        }
    }
    return false;
}

function _maybeRerenderSectionPracticeOnPlayableLoad() {
    const count = _sectionPracticePlayableCount();
    const prev = _sectionPracticeLastPlayableCount;
    _sectionPracticeLastPlayableCount = count;
    if (!_sectionPracticeSourceSections().length || !_sectionPracticeBarIsReady()) return;
    // Re-render whenever the parent layout changes after the bar is up — the
    // synthetic "Start" section can appear (±1 parent) once a note before the
    // first marker streams in, which would otherwise leave the DOM chip indices
    // out of sync with _buildSectionParents() (clicks/highlights hitting the
    // wrong section). _buildSectionParents() is memoized, so this is cheap.
    const parents = _buildSectionParents();
    const parentCount = parents.length;
    if (parentCount !== _sectionPracticeLastParentCount) {
        // Remap the active parent by start-time identity before re-rendering: a
        // late "Start" prepend shifts every real parent's index, so the raw
        // index would otherwise point at the wrong section (mis-highlighting and
        // breaking whole/prev/next). Selected/part indices are within-parent and
        // unaffected. Skip when no active parent or no prior snapshot.
        if (_sectionPracticeActiveParent >= 0 && Number.isFinite(_sectionPracticeActiveParentStart)) {
            const remapped = parents.findIndex(
                (p) => Math.abs(p.start - _sectionPracticeActiveParentStart) < 0.001,
            );
            if (remapped >= 0) _sectionPracticeActiveParent = remapped;
        }
        _sectionPracticeLastParentCount = parentCount;
        renderSectionPracticeBar();
        _sectionPracticeActiveParentStart =
            (_sectionPracticeActiveParent >= 0 && parents[_sectionPracticeActiveParent])
                ? parents[_sectionPracticeActiveParent].start : NaN;
        return;
    }
    // Keep the active-parent start snapshot fresh while the layout is stable, so
    // it holds the correct pre-change value when the layout next shifts.
    _sectionPracticeActiveParentStart =
        (_sectionPracticeActiveParent >= 0 && parents[_sectionPracticeActiveParent])
            ? parents[_sectionPracticeActiveParent].start : NaN;
    if (_sectionPracticePlayablePopulateRerendered) return;
    if (prev !== 0 || count === 0) return;
    _sectionPracticePlayablePopulateRerendered = true;
    renderSectionPracticeBar();
}

// _buildSectionParents() runs on the 60 Hz highlight path, so memoize it.
// The parent layout is a pure function of the highway's section list (a
// stable array reference per song), the song duration, and whether any
// notes/chords precede the first marker (the synthetic "Start" section).
// That last input can flip while WS note chunks are still streaming in, so
// the note/chord counts are part of the key; once a song is fully loaded
// all four inputs stabilize and the per-frame call becomes a cache hit.
// Every call site uses the result read-only, so returning the cached array
// reference is safe.
let _sectionParentsCache = null;
let _sectionParentsCacheRaw = null;
let _sectionParentsCacheDur = -1;
let _sectionParentsCacheNoteLen = -1;
let _sectionParentsCacheChordLen = -1;

export function _buildSectionParents() {
    const raw = _sectionPracticeSourceSections();
    if (!raw.length) return [];
    const dur = _sectionPracticeDuration();
    const hw = _sectionPracticeHighway();
    const noteLen = (hw && typeof hw.getNotes === 'function' && hw.getNotes()?.length) || 0;
    const chordLen = (hw && typeof hw.getChords === 'function' && hw.getChords()?.length) || 0;
    if (_sectionParentsCache !== null
        && _sectionParentsCacheRaw === raw
        && _sectionParentsCacheDur === dur
        && _sectionParentsCacheNoteLen === noteLen
        && _sectionParentsCacheChordLen === chordLen) {
        return _sectionParentsCache;
    }
    const sorted = [...raw].sort((a, b) => _sectionPracticeStartTime(a) - _sectionPracticeStartTime(b));
    // Step 1: collapse consecutive same-name markers into logical groups.
    const groups = [];
    for (let i = 0; i < sorted.length; i++) {
        const start = _sectionPracticeStartTime(sorted[i]);
        if (!Number.isFinite(start)) continue;
        const baseName = _sectionPracticeBaseName(sorted[i].name, groups.length);
        const prev = groups[groups.length - 1];
        if (prev && prev.baseName === baseName) {
            prev.lastIndex = i;
        } else {
            groups.push({ baseName, firstIndex: i, lastIndex: i });
        }
    }
    if (!groups.length) return [];
    // Step 2: assign musician-friendly labels with counters (Verse 1, Verse 2, …).
    const counters = Object.create(null);
    const ranges = [];
    for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const base = g.baseName;
        const count = (counters[base] || 0) + 1;
        counters[base] = count;
        const label = `${base} ${count}`;
        const firstSec = sorted[g.firstIndex];
        const start = _sectionPracticeStartTime(firstSec);
        if (!Number.isFinite(start)) continue;
        let end;
        if (gi + 1 < groups.length) {
            const nextFirst = sorted[groups[gi + 1].firstIndex];
            end = _sectionPracticeStartTime(nextFirst);
        } else {
            end = dur;
        }
        if (!Number.isFinite(end) || end <= start) {
            end = dur > start ? dur : start + 4;
        }
        ranges.push({ name: label, start, end });
    }
    if (ranges.length > 0) {
        const firstStart = Number(ranges[0].start);
        if (Number.isFinite(firstStart) && firstStart > _SECTION_PRACTICE_START_GAP_SEC
            && _sectionPracticeHasNotesBefore(firstStart)) {
            ranges.unshift({ name: 'Start', start: 0, end: firstStart });
        }
    }
    _sectionParentsCache = ranges;
    _sectionParentsCacheRaw = raw;
    _sectionParentsCacheDur = dur;
    _sectionParentsCacheNoteLen = noteLen;
    _sectionParentsCacheChordLen = chordLen;
    return ranges;
}

function _sectionPracticeResetSelectionUi() {
    _sectionPracticeActiveParent = -1;
    _sectionPracticeSelected = -1;
    _sectionPracticeWholeSection = false;
    _sectionPracticeSavedPartIndex = 0;
    _sectionPracticeRanges = [];
}

function _sectionPracticeSourcePhrases() {
    const hw = _sectionPracticeHighway();
    if (!hw || typeof hw.getPracticePhrases !== 'function') return null;
    const raw = hw.getPracticePhrases();
    return (raw && raw.length) ? raw : null;
}

function _buildPhrasePartsForParent(parent) {
    if (!parent) return [];
    const dur = _sectionPracticeDuration();
    const windowStart = parent.start;
    const windowEnd = parent.end;
    const phrases = _sectionPracticeSourcePhrases();
    const parts = [];

    if (phrases) {
        const inWindow = phrases.filter(
            (ph) => ph.start_time >= windowStart - 0.001 && ph.start_time < windowEnd - 0.001,
        );
        if (inWindow.length) {
            for (let i = 0; i < inWindow.length; i++) {
                const ph = inWindow[i];
                let start = ph.start_time;
                let end = ph.end_time;
                if (!Number.isFinite(end) || end > windowEnd) end = windowEnd;
                if (!Number.isFinite(start) || end <= start) continue;
                if (dur && Number.isFinite(dur) && end > dur) end = dur;
                parts.push({ name: parent.name, start, end });
            }
            // Snap first part to section start so the loop aligns with the selected marker
            // when the first in-window phrase iteration begins later (e.g. Chorus 2).
            if (parts.length > 0 && parts[0].start > windowStart) {
                parts[0].start = windowStart;
            }
            return parts;
        }
    }

    let start = windowStart;
    let end = windowEnd;
    if (dur && Number.isFinite(dur) && end > dur) end = dur;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        parts.push({ name: parent.name, start, end });
    }
    return parts;
}

function _buildSectionPracticeRanges() {
    if (_sectionPracticeActiveParent < 0) return [];
    const parents = _buildSectionParents();
    const parent = parents[_sectionPracticeActiveParent];
    if (!parent) return [];
    return _buildPhrasePartsForParent(parent);
}

function _sectionPracticeActiveParentRange() {
    if (_sectionPracticeActiveParent < 0) return null;
    const parents = _buildSectionParents();
    const parent = parents[_sectionPracticeActiveParent];
    if (!parent) return null;
    const dur = _sectionPracticeDuration();
    let end = Number(parent.end);
    const start = Number(parent.start);
    if (dur && Number.isFinite(dur) && end > dur) end = dur;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return { name: parent.name, start, end };
}

function _sectionPracticeResolveLoopTarget(index, opts = {}) {
    if (opts.whole) {
        return _sectionPracticeActiveParentRange();
    }
    return _sectionPracticeRanges[index] ?? null;
}

function _formatSectionPracticeName(name) {
    return name.replace(/_/g, ' ');
}

const _SECTION_PRACTICE_CHIP_KINDS = new Set([
    'intro', 'verse', 'chorus', 'bridge', 'solo', 'riff', 'outro',
]);

function _sectionPracticeChipKindClass(name, index) {
    const base = _sectionPracticeBaseName(name, index);
    const kind = base.toLowerCase();
    if (!_SECTION_PRACTICE_CHIP_KINDS.has(kind)) return '';
    return ` section-practice-chip--${kind}`;
}

function _sectionPracticeWholeCheckboxHtml() {
    return '<label class="section-practice-whole-wrap" title="Loop the whole selected section">'
        + '<input type="checkbox" id="section-practice-whole" onchange="onSectionPracticeWholeChange()">'
        + '<span class="section-practice-whole-text">Full section</span>'
        + '</label>';
}

function _sectionPracticePieceRowHtml() {
    return '<div id="section-practice-piece-row" class="section-practice-row section-practice-piece-row">'
        + '<span id="section-practice-piece-label" class="section-practice-piece-label" aria-live="polite">Part — of —</span>'
        + '<button type="button" id="section-practice-piece-prev" class="section-practice-chip" onclick="onPhrasePrev()">◀ Previous</button>'
        + '<button type="button" id="section-practice-piece-next" class="section-practice-chip" onclick="onPhraseNext()">Next ▶</button>'
        + '</div>';
}

function _sectionPracticeMainRow() {
    const bar = document.getElementById('section-practice-bar');
    if (!bar) return null;
    return bar.querySelector('.section-practice-controls-row')
        || bar.querySelector('.section-practice-primary-row')
        || bar.querySelector('.section-practice-row:not(.section-practice-piece-row):not(.section-practice-chips-row)');
}

function _migrateSectionPracticeDomLayout(bar) {
    if (!bar || bar.querySelector('.section-practice-controls-row')) return;

    const pieceRow = document.getElementById('section-practice-piece-row');
    const scroll = document.getElementById('section-practice-scroll');
    const modeWrap = bar.querySelector('.section-practice-mode-wrap');
    const wholeWrap = bar.querySelector('.section-practice-whole-wrap');
    let label = bar.querySelector('.section-practice-label');

    const controlsRow = document.createElement('div');
    controlsRow.className = 'section-practice-row section-practice-controls-row';
    if (modeWrap) controlsRow.appendChild(modeWrap);
    if (wholeWrap) controlsRow.appendChild(wholeWrap);
    if (pieceRow) controlsRow.appendChild(pieceRow);

    const chipsRow = document.createElement('div');
    chipsRow.className = 'section-practice-row section-practice-chips-row';
    if (label) {
        chipsRow.appendChild(label);
    } else {
        label = document.createElement('span');
        label.className = 'section-practice-label';
        label.textContent = 'Sections:';
        chipsRow.appendChild(label);
    }
    if (scroll) chipsRow.appendChild(scroll);

    bar.replaceChildren(controlsRow, chipsRow);
}

function _sectionPracticeBarInnerHtml() {
    return '<div class="section-practice-row section-practice-controls-row">'
        + '<label class="section-practice-mode-wrap" title="Loop the selected section until turned off">'
        + '<input type="checkbox" id="section-practice-mode" onchange="onSectionPracticeModeChange()">'
        + '<span class="section-practice-mode-text">Practice Section</span>'
        + '</label>'
        + _sectionPracticeWholeCheckboxHtml()
        + _sectionPracticePieceRowHtml()
        + '</div>'
        + '<div class="section-practice-row section-practice-chips-row">'
        + '<span class="section-practice-label">Sections:</span>'
        + '<div id="section-practice-scroll" class="section-practice-scroll" role="toolbar"></div>'
        + '</div>';
}

function _ensureSectionPracticeWholeCheckbox() {
    const existing = document.getElementById('section-practice-whole');
    const mainRow = _sectionPracticeMainRow();
    if (!mainRow) return;
    if (existing) {
        const wrap = existing.closest('.section-practice-whole-wrap');
        if (wrap && !mainRow.contains(wrap)) {
            const modeWrap = mainRow.querySelector('.section-practice-mode-wrap');
            if (modeWrap) modeWrap.insertAdjacentElement('afterend', wrap);
            else mainRow.insertBefore(wrap, mainRow.firstChild);
        }
        return;
    }
    const modeWrap = mainRow.querySelector('.section-practice-mode-wrap');
    if (modeWrap) {
        modeWrap.insertAdjacentHTML('afterend', _sectionPracticeWholeCheckboxHtml());
    } else {
        mainRow.insertAdjacentHTML('afterbegin', _sectionPracticeWholeCheckboxHtml());
    }
}

function _sectionPracticeCurrentPartIndex() {
    const total = _sectionPracticeRanges.length;
    if (!total) return 0;
    if (!_sectionPracticeWholeSection && _sectionPracticeSelected >= 0) {
        return Math.min(_sectionPracticeSelected, total - 1);
    }
    if (_sectionPracticeSavedPartIndex >= 0) {
        return Math.min(_sectionPracticeSavedPartIndex, total - 1);
    }
    return 0;
}

function _sectionPracticePillHtml() {
    return '<button type="button" id="section-practice-pill" class="section-practice-pill"'
        + ' aria-haspopup="dialog" aria-expanded="false" aria-controls="section-practice-bar"'
        + ' aria-label="Section practice"'
        + ' onclick="toggleSectionPracticePopover()" title="Section practice">'
        + '<span class="section-practice-pill-icon" aria-hidden="true">'
        + '<svg class="v3-rail-svg section-practice-pill-svg" viewBox="0 0 24 24">'
        + '<path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4M12,6A6,6 0 0,0 6,12A6,6 0 0,0 12,18A6,6 0 0,0 18,12A6,6 0 0,0 12,6M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8M12,10A2,2 0 0,0 10,12A2,2 0 0,0 12,14A2,2 0 0,0 14,12A2,2 0 0,0 12,10Z"/>'
        + '</svg></span>'
        + '<span class="section-practice-pill-text">Practice</span>'
        + '<span class="section-practice-pill-caret" aria-hidden="true">▾</span>'
        + '</button>';
}

function _syncSectionPracticePillV3Chrome(isV3) {
    const pill = document.getElementById('section-practice-pill');
    if (!pill) return;
    pill.classList.toggle('v3-rail-icon', isV3);
    let ring = pill.querySelector('.v3-rail-border');
    if (isV3) {
        if (!ring) {
            ring = document.createElement('span');
            ring.className = 'v3-rail-border';
            ring.setAttribute('aria-hidden', 'true');
            pill.insertBefore(ring, pill.firstChild);
        }
        pill.setAttribute('title', 'Practice');
        pill.setAttribute('aria-label', 'Practice');
    } else {
        if (ring) ring.remove();
        pill.setAttribute('title', 'Section practice');
        pill.setAttribute('aria-label', 'Section practice');
    }
}

// Wrap an existing #section-practice-bar in the pill control (creating the
// wrapper + pill if missing). Defensive: works whether the bar came from the
// static markup (already wrapped) or a chrome whose index.html predates the
// pill (e.g. a not-yet-rebased v3 build) — the bar is always reachable as a
// closed popover behind the pill afterward.
function _ensureSectionPracticeControlWrap(bar) {
    if (!bar) return null;
    let ctrl = (bar.closest && bar.closest('.section-practice-control'))
        || document.getElementById('section-practice-control');
    if (ctrl) {
        if (!ctrl.contains(bar)) ctrl.appendChild(bar);
    } else {
        ctrl = document.createElement('div');
        ctrl.id = 'section-practice-control';
        ctrl.className = 'section-practice-control section-practice-control--hidden';
        if (bar.parentNode) bar.parentNode.insertBefore(ctrl, bar);
        ctrl.appendChild(bar);
    }
    if (!ctrl.querySelector('#section-practice-pill')) {
        ctrl.insertAdjacentHTML('afterbegin', _sectionPracticePillHtml());
    }
    // Popover visibility is driven by --open now; clear any legacy hidden class.
    bar.classList.remove('section-practice-bar--hidden');
    _mountSectionPracticeControlSafe(ctrl);
    return ctrl;
}

// Mount the pill control so its popover — whose chip <button>s would otherwise
// be matched by a plugin's `#player-controls > button:last-child` injector
// anchor and throw on insertBefore — lives OUTSIDE #player-controls. Prefers
// #player-footer; otherwise inserts as a sibling immediately before
// #player-controls. Idempotent and never throws on layout variants where
// #player-controls isn't a child of #player-footer (it checks parentage before
// using insertBefore). The v3 rail mount in _placeSectionPracticeControlForChrome
// supersedes this, so a control already in the rail is left alone.
function _mountSectionPracticeControlSafe(ctrl) {
    if (!ctrl) return;
    if (ctrl.closest && ctrl.closest('#v3-player-rail')) return;
    const controls = document.getElementById('player-controls');
    const footer = document.getElementById('player-footer');
    if (footer) {
        if (controls && controls.parentNode === footer) {
            if (ctrl.nextSibling !== controls) footer.insertBefore(ctrl, controls);
        } else if (ctrl.parentNode !== footer) {
            footer.appendChild(ctrl);
        }
        return;
    }
    if (controls && controls.parentNode) {
        if (ctrl.parentNode !== controls.parentNode || ctrl.nextSibling !== controls) {
            controls.parentNode.insertBefore(ctrl, controls);
        }
        return;
    }
    // No footer and #player-controls has no parent (degenerate/detached layout):
    // never nest the popover INSIDE #player-controls — that re-arms the injector
    // bug. Fall back to the player container so the chip buttons stay outside it.
    const player = document.getElementById('player');
    if (player && ctrl.parentNode !== player) player.appendChild(ctrl);
}

// In the v3 chrome the pill becomes a left-rail icon (CSS hides its label and
// opens the popover to the right). app.js owns the toggle/dismiss, so this is
// independent of player-chrome.js's own rail-popover wiring.
// Idempotent + reversible: mounts the control into #v3-player-rail under v3,
// or back out to the footer under v2. Safe to call every frame — it only
// touches the DOM when the placement is actually wrong, so a chrome that flips
// uiVersion (or mounts #v3-player-rail) after the bar is "ready" still gets the
// pill relocated on the next draw tick. See the draw hook's ready path.
export function _placeSectionPracticeControlForChrome() {
    const ctrl = document.getElementById('section-practice-control');
    if (!ctrl) return;
    const isV3 = !!(window.feedBack && window.feedBack.uiVersion === 'v3');
    ctrl.classList.toggle('section-practice-control--v3', isV3);
    _syncSectionPracticePillV3Chrome(isV3);
    if (isV3) {
        const rail = document.getElementById('v3-player-rail');
        if (rail) {
            const dot = rail.querySelector('.v3-rail-dot');
            if (dot) {
                // Reorder even when already in the rail but after the dot (or the
                // dot mounted later) so the placement self-corrects each tick.
                if (ctrl.parentElement !== rail || ctrl.nextElementSibling !== dot) {
                    rail.insertBefore(ctrl, dot);
                }
            } else if (ctrl.parentElement !== rail) {
                rail.appendChild(ctrl);
            }
        }
    } else if (ctrl.closest && ctrl.closest('#v3-player-rail')) {
        // Chrome reverted to v2: pull the control out of the rail (detach first
        // so _mountSectionPracticeControlSafe's rail guard doesn't no-op) and
        // re-home it in the footer.
        ctrl.remove();
        _mountSectionPracticeControlSafe(ctrl);
    }
}

function _ensureSectionPracticeDom() {
    let bar = document.getElementById('section-practice-bar');
    if (bar) {
        _ensureSectionPracticeControlWrap(bar);
        _migrateSectionPracticeDomLayout(bar);
        if (!bar.querySelector('#section-practice-piece-row')) {
            const controlsRow = bar.querySelector('.section-practice-controls-row')
                || bar.querySelector('.section-practice-primary-row');
            if (controlsRow) {
                controlsRow.insertAdjacentHTML('beforeend', _sectionPracticePieceRowHtml());
            } else {
                bar.insertAdjacentHTML('beforeend', _sectionPracticePieceRowHtml());
            }
        }
        _ensureSectionPracticeWholeCheckbox();
        bar.querySelector('.section-practice-show-all-wrap')?.remove();
        _placeSectionPracticeControlForChrome();
        return bar;
    }
    const controls = document.getElementById('player-controls');
    const footer = document.getElementById('player-footer');
    if (!footer && !controls) return null;
    bar = document.createElement('div');
    bar.id = 'section-practice-bar';
    bar.className = 'section-practice-bar';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Section practice');
    bar.innerHTML = _sectionPracticeBarInnerHtml();
    const ctrl = document.createElement('div');
    ctrl.id = 'section-practice-control';
    ctrl.className = 'section-practice-control section-practice-control--hidden';
    ctrl.innerHTML = _sectionPracticePillHtml();
    ctrl.appendChild(bar);
    // Mount OUTSIDE #player-controls (in #player-footer, or as its sibling) so
    // the popover's chip <button>s can't be matched by a plugin injector that
    // anchors on `#player-controls > button:last-of-type` (see static/v3/index.html).
    _mountSectionPracticeControlSafe(ctrl);
    _placeSectionPracticeControlForChrome();
    return bar;
}

// "Show" = make the pill available. The bar itself stays a CLOSED popover
// until the user opens it via the pill (toggleSectionPracticePopover).
function _showSectionPracticeBar(bar) {
    const ctrl = (bar && bar.closest && bar.closest('.section-practice-control'))
        || document.getElementById('section-practice-control');
    if (ctrl) ctrl.classList.remove('section-practice-control--hidden');
}

export function _sectionPracticePopoverOpen() {
    const bar = document.getElementById('section-practice-bar');
    return !!(bar && bar.classList.contains('section-practice-bar--open'));
}

function _openSectionPracticePopover() {
    const bar = document.getElementById('section-practice-bar');
    if (!bar) return;
    bar.classList.add('section-practice-bar--open');
    const pill = document.getElementById('section-practice-pill');
    if (pill) pill.setAttribute('aria-expanded', 'true');
    _installSectionPracticeDismiss();
}

function _closeSectionPracticePopover() {
    const bar = document.getElementById('section-practice-bar');
    const pill = document.getElementById('section-practice-pill');
    if (bar) {
        const focusWasInside = bar.contains(document.activeElement);
        bar.classList.remove('section-practice-bar--open');
        // Return focus to the pill if it was inside the popover — otherwise it
        // would be stranded on a now-display:none control, which also makes the
        // shortcut gate treat that stale target as interactive and suppress
        // player keys until focus is moved manually.
        if (focusWasInside && pill) pill.focus();
    }
    if (pill) pill.setAttribute('aria-expanded', 'false');
}

export function toggleSectionPracticePopover() {
    if (_sectionPracticePopoverOpen()) _closeSectionPracticePopover();
    else _openSectionPracticePopover();
}

let _sectionPracticeDismissBound = false;
function _installSectionPracticeDismiss() {
    if (_sectionPracticeDismissBound) return;
    _sectionPracticeDismissBound = true;
    // Click-outside + Esc close. Bound once on document; the pill's own click is
    // inside #section-practice-control so it never self-closes. Listeners added
    // mid-dispatch don't fire for the opening click, so there's no immediate
    // close race.
    //
    // The click listener uses the CAPTURE phase: the v3 player rail's icon
    // buttons call e.stopPropagation() in their click handler (player-chrome.js
    // wireRail), which kills bubbling before it reaches document. A bubble-phase
    // outside-click dismiss would therefore never fire when the user clicks a
    // rail icon (Plugins, Audio, …) to open another popover, leaving this
    // popover stranded open on top of it. Capture runs before the target's
    // handler, so the stopPropagation can't swallow it. This mirrors the audio
    // mixer popover (audio-mixer.js), which dismisses outside-clicks the same
    // way. (Esc stays bubble-phase — no rail handler stops keydown propagation,
    // so it already reaches us, and capturing it would reorder it ahead of the
    // player's Escape-to-exit handling.)
    document.addEventListener('click', (e) => {
        if (!_sectionPracticePopoverOpen()) return;
        const ctrl = document.getElementById('section-practice-control');
        if (ctrl && ctrl.contains(e.target)) return;
        _closeSectionPracticePopover();
    }, true);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _sectionPracticePopoverOpen()) _closeSectionPracticePopover();
    });
}

export function _hideSectionPracticeBar() {
    _setSectionPracticeMode(false, { skipClearLoop: true });
    _closeSectionPracticePopover();
    const ctrl = document.getElementById('section-practice-control');
    if (ctrl) {
        // Move focus out before hiding the control: a display:none element that
        // still holds focus leaves document.activeElement on it, which the
        // shortcut gate (_shortcutDispatchBlocked) would treat as an interactive
        // target and swallow player keys. Covers the pill (where the close above
        // may have just parked focus) and any bar descendant.
        const ae = document.activeElement;
        if (ae && ctrl.contains(ae) && typeof ae.blur === 'function') ae.blur();
        ctrl.classList.add('section-practice-control--hidden');
    }
    _sectionPracticeRanges = [];
    _sectionPracticeActiveParent = -1;
    _sectionPracticeSelected = -1;
    _sectionPracticeWholeSection = false;
    _sectionPracticeSavedPartIndex = 0;
    _sectionPracticeFollowParent = -1;
    _sectionPracticeDurSynced = false;
    const scroll = document.getElementById('section-practice-scroll');
    if (scroll) scroll.innerHTML = '';
    _syncSectionPracticePieceUi();
}

export function _sectionPracticeBarIsReady() {
    // "Ready" = the pill is available (sections exist) and the popover is
    // populated. Independent of whether the popover is currently open, so the
    // draw-hook retry loop settles even while the bar stays collapsed.
    const ctrl = document.getElementById('section-practice-control');
    if (!ctrl || ctrl.classList.contains('section-practice-control--hidden')) return false;
    const scroll = document.getElementById('section-practice-scroll');
    return !!(scroll && scroll.querySelector('[data-parent-idx]'));
}

export function _installSectionPracticeDrawHook() {
    if (_sectionPracticeHooked) return;
    const hw = _sectionPracticeHighway();
    if (!hw || typeof hw.addDrawHook !== 'function') return;
    _sectionPracticeHooked = true;
    hw.addDrawHook(() => {
        if (_sectionPracticeSourceSections().length === 0) return;
        _maybeRerenderSectionPracticeOnPlayableLoad();
        if (_sectionPracticeBarIsReady()) { _placeSectionPracticeControlForChrome(); return; }
        renderSectionPracticeBar();
    });
}

export function _scheduleSectionPracticeRetries() {
    if (_sectionPracticeRetryTimer) clearTimeout(_sectionPracticeRetryTimer);
    const delays = [0, 50, 200, 500, 1200];
    let i = 0;
    const tick = () => {
        renderSectionPracticeBar();
        i += 1;
        if (i < delays.length && !_sectionPracticeBarIsReady()) {
            _sectionPracticeRetryTimer = setTimeout(tick, delays[i]);
        } else {
            _sectionPracticeRetryTimer = null;
        }
    };
    tick();
}

function _syncSectionPracticePieceUi() {
    const label = document.getElementById('section-practice-piece-label');
    const prev = document.getElementById('section-practice-piece-prev');
    const next = document.getElementById('section-practice-piece-next');
    const wholeCb = document.getElementById('section-practice-whole');
    const total = _sectionPracticeRanges.length;
    const active = _sectionPracticeActiveParent >= 0;
    if (label) {
        if (!active || !total) {
            label.textContent = 'Part — of —';
        } else {
            const idx = _sectionPracticeCurrentPartIndex();
            label.textContent = `Part ${idx + 1} of ${total}`;
        }
    }
    if (wholeCb) {
        wholeCb.checked = _sectionPracticeWholeSection;
    }
    const partIdx = (!active || !total || _sectionPracticeWholeSection)
        ? 0
        : (_sectionPracticeSelected >= 0 ? _sectionPracticeSelected : 0);
    if (prev) {
        prev.disabled = !active || !total || (!_sectionPracticeWholeSection && partIdx <= 0);
    }
    if (next) {
        next.disabled = !active || !total || (!_sectionPracticeWholeSection && partIdx >= total - 1);
    }
}

export function renderSectionPracticeBar() {
    _installSectionPracticeDrawHook();
    const raw = _sectionPracticeSourceSections();
    if (!_sectionPracticeLogged) {
        _sectionPracticeLogged = true;
    }
    const parents = _buildSectionParents();
    const bar = _ensureSectionPracticeDom();
    const scroll = document.getElementById('section-practice-scroll');
    if (!bar || !scroll) return;
    if (!parents.length) {
        _hideSectionPracticeBar();
        return;
    }
    if (_sectionPracticeActiveParent >= parents.length) {
        _sectionPracticeResetSelectionUi();
    }
    _showSectionPracticeBar(bar);
    scroll.innerHTML = parents.map((p, i) => {
        const label = _formatSectionPracticeName(p.name);
        const tip = `${label} (${formatTime(p.start)}–${formatTime(p.end)})`;
        const kindClass = _sectionPracticeChipKindClass(p.name, i);
        return `<button type="button" class="section-practice-chip${kindClass}" data-parent-idx="${i}" title="${esc(tip)}" onclick="onSectionParentClick(${i})">${esc(label)}</button>`;
    }).join('');
    _sectionPracticeRanges = _buildSectionPracticeRanges();
    // Reconcile any active A-B loop with the (re)rendered section bar. Called
    // unconditionally so a loop that arrived before the section markers — e.g.
    // a Saved Loop or window.feedBack.setLoop() during song load, when no
    // parent was active yet — still re-selects its chip once markers appear.
    // _syncSectionPracticeFromLoop() scans all parents, so it can activate the
    // matching one; run it before the piece UI so that reflects the result.
    _syncSectionPracticeFromLoop();
    _syncSectionPracticePieceUi();
    _updateSectionPracticeHighlight(_audioTime());
}

export async function onSectionParentClick(parentIdx) {
    const parents = _buildSectionParents();
    const idx = Number(parentIdx);
    if (!Number.isFinite(idx) || idx < 0 || idx >= parents.length) return;
    _sectionPracticeActiveParent = idx;
    _sectionPracticeRanges = _buildSectionPracticeRanges();
    _sectionPracticeSelected = -1;
    _sectionPracticeSavedPartIndex = 0;
    _sectionPracticeWholeSection = true;
    _syncSectionPracticePieceUi();
    _updateSectionPracticeHighlight(_audioTime());
    if (_sectionPracticeActiveParentRange() || _sectionPracticeRanges.length) {
        await practiceSection(0, { whole: true });
    }
}

export async function onSectionPracticeWholeChange() {
    const cb = document.getElementById('section-practice-whole');
    if (!cb || _sectionPracticeActiveParent < 0) return;
    const total = _sectionPracticeRanges.length;
    if (!total) return;
    if (cb.checked === _sectionPracticeWholeSection) return;
    _sectionPracticeWholeSection = cb.checked;
    if (cb.checked) {
        await practiceSection(_sectionPracticeCurrentPartIndex(), { whole: true });
        return;
    }
    await practiceSection(0);
}

export async function onPhrasePrev() {
    const total = _sectionPracticeRanges.length;
    if (!total || _sectionPracticeActiveParent < 0) return;
    if (_sectionPracticeWholeSection) {
        _sectionPracticeWholeSection = false;
        _syncSectionPracticePieceUi();
        await practiceSection(0);
        return;
    }
    const cur = _sectionPracticeSelected >= 0 ? _sectionPracticeSelected : 0;
    if (cur <= 0) return;
    await practiceSection(cur - 1);
}

export async function onPhraseNext() {
    const total = _sectionPracticeRanges.length;
    if (!total || _sectionPracticeActiveParent < 0) return;
    if (_sectionPracticeWholeSection) {
        _sectionPracticeWholeSection = false;
        _syncSectionPracticePieceUi();
        await practiceSection(0);
        return;
    }
    const cur = _sectionPracticeSelected >= 0 ? _sectionPracticeSelected : 0;
    if (cur >= total - 1) return;
    await practiceSection(cur + 1);
}

// Find which section parent / phrase part the active A-B loop corresponds to.
// Scans ALL parents (not just the active one) so a loop arriving from Saved
// Loops or window.feedBack.setLoop() can re-select the right chip even when
// its parent isn't the currently-active one. Returns { parentIdx, whole } or
// { parentIdx, whole:false, index } (the matching phrase part), or null.
function _sectionPracticeLoopMatch() {
    if (host.loopA() === null || host.loopB() === null) return null;
    const parents = _buildSectionParents();
    for (let parentIdx = 0; parentIdx < parents.length; parentIdx++) {
        const parent = parents[parentIdx];
        let partMatch = -1;
        const parts = _buildPhrasePartsForParent(parent);
        for (let i = 0; i < parts.length; i++) {
            if (Math.abs(parts[i].start - host.loopA()) < 0.05 && Math.abs(parts[i].end - host.loopB()) < 0.05) {
                partMatch = i;
                break;
            }
        }
        const wholeMatch = Math.abs(parent.start - host.loopA()) < 0.05 && Math.abs(parent.end - host.loopB()) < 0.05;
        if (wholeMatch && partMatch >= 0) {
            // A single-part section's part range coincides with the whole
            // section. Preserve the user's whole/part intent when this is the
            // already-active parent; otherwise default to whole-section.
            if (parentIdx === _sectionPracticeActiveParent && !_sectionPracticeWholeSection) {
                return { parentIdx, whole: false, index: partMatch };
            }
            return { parentIdx, whole: true };
        }
        if (wholeMatch) return { parentIdx, whole: true };
        if (partMatch >= 0) return { parentIdx, whole: false, index: partMatch };
    }
    return null;
}

function _blurSectionPracticeFocusIfNeeded() {
    const ae = document.activeElement;
    const bar = document.getElementById('section-practice-bar');
    if (ae && bar && bar.contains(ae) && typeof ae.blur === 'function') {
        ae.blur();
    }
}

export async function practiceSection(index, opts = {}) {
    const requestGen = ++_sectionPracticeRequestGen;
    const seekGen = audioSeekGen();
    const loopGen = host._loopMutationGen();
    const whole = !!opts.whole;
    const r = _sectionPracticeResolveLoopTarget(index, opts);
    if (!r) return;
    const dur = _sectionPracticeDuration();
    const start = Number(r.start);
    let end = Number(r.end);
    if (dur && Number.isFinite(dur) && end > dur) end = dur;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

    // Mark the request in-flight so a bar re-render that fires during the awaited
    // setLoop below doesn't reconcile section state against the old/half-applied
    // loop. Cleared in finally so every exit path (bail, success, failure) resets.
    _sectionPracticeRequestInFlight++;
    try {
    host._cancelCountIn();
    _setSectionPracticeMode(true, { skipClearLoop: true });

    // setLoop() is seek-gated: it returns false when the seek is cancelled
    // during arrangement switches / teardown-gen bumps, or when the backend
    // clock clamps off-target. Retry briefly to land after the transport
    // becomes ready without forking the loop system.
    let ok = false;
    for (let attempt = 0; attempt < 5; attempt++) {
        // A newer click or a song/arrangement change supersedes this retry.
        if (requestGen !== _sectionPracticeRequestGen || seekGen !== audioSeekGen() || loopGen !== host._loopMutationGen()) return;
        try {
            // skipSectionSync: this function owns the section-practice state and
            // applies it below under the request-gen guard, so a stale retry
            // landing here can't re-sync/re-arm via setLoop's shared path.
            // commitGuard: also prevent a superseded retry from committing
            // loopA/loopB at all — setLoop re-checks this right before arming,
            // after its internal seek await, so a stale loop is never armed.
            ok = await host.setLoop(start, end, {
                skipSectionSync: true,
                commitGuard: () => requestGen === _sectionPracticeRequestGen && seekGen === audioSeekGen() && loopGen === host._loopMutationGen(),
            });
        } catch (err) {
            ok = false;
        }
        if (ok) break;
        await new Promise(res => setTimeout(res, 60 + attempt * 90));
    }
    // Re-check after the awaited retries before applying any loop/count-in state.
    if (requestGen !== _sectionPracticeRequestGen || seekGen !== audioSeekGen() || loopGen !== host._loopMutationGen()) return;

    if (ok) {
        _sectionPracticeWholeSection = whole;
        if (!whole) {
            _sectionPracticeSelected = index;
            _sectionPracticeSavedPartIndex = index;
        }
        _blurSectionPracticeFocusIfNeeded();
        _updateSectionPracticeHighlight(_audioTime());
        host.startCountIn({ immediate: true });
    } else {
        _setSectionPracticeMode(false, { skipClearLoop: true });
    }
    } finally {
        _sectionPracticeRequestInFlight--;
    }
}

export function _syncSectionPracticeFromLoop() {
    // A practiceSection() request owns the section state while it awaits its
    // loop; reconciling here against the prior/half-applied loop would fight it
    // (snapping the active parent back or toggling the mode off mid-request).
    if (_sectionPracticeRequestInFlight > 0) return;
    if (!_buildSectionParents().length) return;
    const match = _sectionPracticeLoopMatch();
    if (match) {
        // The loop may belong to a parent that isn't currently active (e.g.
        // restored from Saved Loops); switch to it and rebuild its parts so
        // the part-level UI reflects the matched section.
        if (match.parentIdx !== _sectionPracticeActiveParent) {
            _sectionPracticeActiveParent = match.parentIdx;
            _sectionPracticeRanges = _buildSectionPracticeRanges();
        }
        _sectionPracticeWholeSection = match.whole;
        if (!match.whole) {
            _sectionPracticeSelected = match.index;
            _sectionPracticeSavedPartIndex = match.index;
        } else {
            _sectionPracticeSelected = -1;
        }
    } else {
        _sectionPracticeWholeSection = false;
        _sectionPracticeSelected = -1;
    }
    if (host.loopA() !== null && host.loopB() !== null) {
        if (match) {
            if (!_sectionPracticeMode) {
                _setSectionPracticeMode(true, { skipClearLoop: true });
            }
        } else if (_sectionPracticeMode) {
            _setSectionPracticeMode(false, { skipClearLoop: true });
        }
    } else if (_sectionPracticeMode) {
        _setSectionPracticeMode(false, { skipClearLoop: true });
    }
    _updateSectionPracticeHighlight(_audioTime());
}

function _sectionPracticeIndexAtTime(t) {
    if (!Number.isFinite(t) || _sectionPracticeRanges.length === 0) return -1;
    for (let i = _sectionPracticeRanges.length - 1; i >= 0; i--) {
        if (t >= _sectionPracticeRanges[i].start) return i;
    }
    return -1;
}

function _sectionPracticeParentIndexAtTime(t) {
    const parents = _buildSectionParents();
    if (!Number.isFinite(t) || parents.length === 0) return -1;
    for (let i = parents.length - 1; i >= 0; i--) {
        if (t >= parents[i].start) return i;
    }
    return -1;
}

function _scrollSectionPracticeChipIntoView(chip) {
    if (!chip) return;
    chip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function _updateSectionPracticeHighlight(ct) {
    const scroll = document.getElementById('section-practice-scroll');
    if (!scroll) return;
    const chips = scroll.querySelectorAll('.section-practice-chip[data-parent-idx]');
    if (!chips.length) return;

    const followEnabled = !_sectionPracticeMode && _sectionPracticeBarIsReady();
    const followParent = followEnabled ? _sectionPracticeParentIndexAtTime(ct) : -1;

    chips.forEach((chip) => {
        const idx = Number(chip.dataset.parentIdx);
        chip.classList.toggle('is-selected', idx === _sectionPracticeActiveParent);
        chip.classList.toggle('is-playing', followEnabled && idx === followParent);
    });

    if (followEnabled && followParent >= 0 && followParent !== _sectionPracticeFollowParent) {
        _sectionPracticeFollowParent = followParent;
        const chip = scroll.querySelector(`.section-practice-chip[data-parent-idx="${followParent}"]`);
        _scrollSectionPracticeChipIntoView(chip);
    } else if (!followEnabled) {
        _sectionPracticeFollowParent = -1;
    }

    _syncSectionPracticePieceUi();
}

export function _maybeRefreshSectionPracticeDuration(dur) {
    if (_sectionPracticeDurSynced || !dur || _sectionPracticeRanges.length === 0) return;
    const rebuilt = _buildSectionPracticeRanges();
    if (!rebuilt.length) return;
    const prevEnd = _sectionPracticeRanges[_sectionPracticeRanges.length - 1].end;
    const nextEnd = rebuilt[rebuilt.length - 1].end;
    if (Math.abs(prevEnd - nextEnd) > 0.05) {
        _sectionPracticeDurSynced = true;
        renderSectionPracticeBar();
    } else {
        _sectionPracticeDurSynced = true;
    }
}

// Re-render when section metadata appears (before audio duration is known).
export function _ensureSectionPracticeBar() {
    if (_sectionPracticeSourceSections().length === 0) return;
    if (!_sectionPracticeBarIsReady()) {
        renderSectionPracticeBar();
    }
}

// ── Resets app.js used to perform by hand ───────────────────────────────────
// clearLoop() and changeArrangement() used to reach in and zero these scalars
// directly. They cannot now (an imported binding is read-only), and they should not
// have to: the module owns its own invariants.

/** Drop the current section selection. Called by app.js's clearLoop(). */
export function resetSelection() {
    _sectionPracticeSelected = -1;
    _sectionPracticeWholeSection = false;
    _sectionPracticeSavedPartIndex = 0;
}

/**
 * Force the next bar render to rebuild its parents, even when the new arrangement
 * happens to have the same parent count. Called by app.js's changeArrangement().
 */
export function invalidateParentCount() {
    _sectionPracticeLastParentCount = -1;
}
