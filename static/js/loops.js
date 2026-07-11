// The A–B loop — set / clear / persist, and the saved-loops list.
//
// The second slice out of app.js's strongly-connected core, and it owns the loop
// state: loopA, loopB, _loopMutationGen. Nothing outside this module writes them
// (restartCurrentSong() looked like it did, but it declares its own local shadows).
//
// DIRECTION MATTERS HERE. loops and section-practice are mutually dependent — the
// SCC in miniature. clearLoop() has to drop section-practice's selection, and
// practiceSection() has to call setLoop(). Both directions cannot be imports or the
// no-cycle gate (rightly) rejects it. So the edge is oriented:
//
//     section-practice  ->  reaches loops through the HOST SEAM (host.setLoop, …)
//     loops             ->  imports section-practice DIRECTLY
//
// section-practice is the higher-level feature — it is a consumer of loops, not the
// other way round — so it is the one that gets the indirection. app.js wires this
// module's exports into the seam for it.
//
// See ./host.js: reading an unwired hook THROWS, and tests/js/host_contract.test.js
// fails CI if the hooks used here and the hooks app.js wires ever drift apart.
import { esc, uiPrompt } from './dom.js';
import { _audioSeek, _audioTime } from './transport.js';
import { formatTime } from './format.js';
import { host } from './host.js';
import {
    _setSectionPracticeMode,
    _syncSectionPracticeFromLoop,
    _updateSectionPracticeHighlight,
    practiceSection,
    resetSelection,
} from './section-practice.js';

// ── A-B Loop ────────────────────────────────────────────────────────────
export let loopA = null;
export let loopB = null;
// Bumped on every NON-practiceSection loop mutation (direct setLoop from Saved
// Loops / the plugin API, and clearLoop). practiceSection() captures it and bails
// if it changes mid-retry, so a stale section retry can't overwrite a loop the
// user just set/cleared by another path. practiceSection's own setLoop calls pass
// skipSectionSync and do NOT bump it (they must not supersede themselves).
export let _loopMutationGen = 0;

export function setLoopStart() {
    loopA = _audioTime();
    document.getElementById('btn-loop-a').className = 'px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
    updateLoopUI();
}

export function setLoopEnd() {
    if (loopA === null) return;
    loopB = _audioTime();
    if (loopB <= loopA) { loopB = null; return; }
    document.getElementById('btn-loop-b').className = 'px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
    updateLoopUI();
    // Manual A/B arming is a loop mutation like setLoop()'s — emit the same
    // transport event so event-driven consumers (note_detect drill sync) see
    // button-armed loops without having to poll getLoop().
    window.feedBack?.playback?.transportEvent?.('loop-set', { requesterId: 'core.loop', loopA, loopB, loop: { startTime: loopA, endTime: loopB, enabled: true, state: 'active' } });
}

export function clearLoop(options) {
    const { emitTransportEvent = true } = options || {};
    // playSong() clears the loop on every song load, so only signal a
    // loop-cleared transport event when a loop was actually active —
    // otherwise every song switch emits a spurious playback:loop-cleared.
    const hadLoop = loopA !== null || loopB !== null;
    _setSectionPracticeMode(false, { skipClearLoop: true });
    loopA = null;
    loopB = null;
    document.getElementById('btn-loop-a').className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition';
    document.getElementById('btn-loop-b').className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition';
    document.getElementById('btn-loop-clear').classList.add('hidden');
    document.getElementById('btn-loop-save').classList.add('hidden');
    document.getElementById('loop-label').textContent = '';
    document.getElementById('saved-loops').value = '';
    resetSelection();
    _updateSectionPracticeHighlight(_audioTime());
    if (hadLoop && emitTransportEvent && typeof window !== 'undefined') {
        window.feedBack?.playback?.transportEvent?.('loop-cleared', {
            requesterId: 'core.loop',
            reason: 'app loop cleared',
            loop: { enabled: false, state: 'inactive' },
        });
    }
}

// Resync #saved-loops + #btn-loop-delete with the currently-active
// loopA/loopB. Used by both setLoop's success path (so plugin-driven
// loops show up correctly in the dropdown) and loadSavedLoop's
// failure path (so a cancelled selection reverts to the still-active
// loop). Without this sync, deleteSelectedLoop could target a stale
// option that doesn't match the active loop.
function _syncSavedLoopSelection() {
    const sel = document.getElementById('saved-loops');
    const delBtn = document.getElementById('btn-loop-delete');
    if (!sel || !delBtn) return;
    let selected = '';
    if (loopA !== null && loopB !== null) {
        for (const opt of sel.options) {
            if (Number(opt.dataset.start) === loopA && Number(opt.dataset.end) === loopB) {
                selected = opt.value;
                break;
            }
        }
    }
    sel.value = selected;
    delBtn.classList.toggle('hidden', !selected);
}

// Programmatically set both loop endpoints and seek to A. The dropdown
// path (loadSavedLoop) and the plugin-API path (window.feedBack.setLoop)
// both funnel through here so the UI state stays canonical regardless of
// who triggered the loop.
//
// Returns true if the seek landed at A and the loop is now active;
// returns false if the seek was cancelled by teardown or landed off-target
// (JUCE clamp / HTML5 snap > 50ms from A). On false, loopA/loopB are NOT
// committed and the UI is not painted — the prior loop (if any) stays
// active. Throws on invalid inputs.
export async function setLoop(a, b, options) {
    const { emitTransportEvent = true, skipSectionSync = false, commitGuard = null } = options || {};
    const aNum = Number(a);
    const bNum = Number(b);
    if (!Number.isFinite(aNum) || !Number.isFinite(bNum) || bNum <= aNum) {
        throw new Error(`setLoop: requires finite a and b with b > a (got a=${a}, b=${b})`);
    }
    // Don't arm loopA/loopB before the seek lands — the 60Hz tick's wrap
    // detector (`ct >= loopB`) would trigger startCountIn against
    // half-applied state.
    const r = await _audioSeek(aNum, 'loop-set');
    if (!r.completed || Math.abs(r.to - aNum) > 0.05) return false;
    // Caller-owned staleness gate, re-checked after the awaited seek and before
    // we commit loopA/loopB. practiceSection() passes this so a superseded retry
    // (newer section click, mode turned off, or song/arrangement teardown that
    // happened during the seek) does not arm a stale loop. Returning false here
    // leaves the prior loop (if any) untouched, same as the off-target path.
    if (typeof commitGuard === 'function' && !commitGuard()) return false;
    loopA = aNum;
    loopB = bNum;
    // A direct (non-practice) loop set supersedes any in-flight practiceSection
    // retry; practiceSection passes skipSectionSync and is exempt so it doesn't
    // cancel itself.
    if (!skipSectionSync) _loopMutationGen++;
    document.getElementById('btn-loop-a').className = 'px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
    document.getElementById('btn-loop-b').className = 'px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
    updateLoopUI();
    // Sync the saved-loops dropdown so a plugin-driven setLoop call
    // surfaces the matching saved option (and Delete button) — otherwise
    // the dropdown can stay on a stale selection and deleteSelectedLoop
    // would target the wrong record.
    _syncSavedLoopSelection();
    // practiceSection() passes skipSectionSync: it sets its own section state
    // under a request-gen guard, so the shared setLoop path must NOT re-sync
    // here — otherwise a stale (superseded / mode-off) practiceSection retry
    // that lands inside setLoop would re-arm the loop and flip the mode back on
    // before the caller's gen check can bail. Direct callers (Saved Loops,
    // window.feedBack.setLoop) still sync so their chip selection tracks.
    if (!skipSectionSync && typeof _syncSectionPracticeFromLoop === 'function') {
        _syncSectionPracticeFromLoop();
    }
    if (emitTransportEvent && typeof window !== 'undefined') {
        window.feedBack?.playback?.transportEvent?.('loop-set', { requesterId: 'core.loop', loopA, loopB, loop: { startTime: loopA, endTime: loopB, enabled: true, state: 'active' } });
    }
    return true;
}

export function updateLoopUI() {
    const label = document.getElementById('loop-label');
    const hasLoop = loopA !== null && loopB !== null;
    if (hasLoop) {
        label.textContent = `${formatTime(loopA)} → ${formatTime(loopB)}`;
        document.getElementById('btn-loop-clear').classList.remove('hidden');
        document.getElementById('btn-loop-save').classList.remove('hidden');
    } else if (loopA !== null) {
        label.textContent = `${formatTime(loopA)} → ?`;
        document.getElementById('btn-loop-clear').classList.add('hidden');
        document.getElementById('btn-loop-save').classList.add('hidden');
    } else {
        label.textContent = '';
    }
    host._updateEditRegionBtn();
}

export async function loadSavedLoops() {
    const sel = document.getElementById('saved-loops');
    const delBtn = document.getElementById('btn-loop-delete');
    if (!host.currentFilename()) { sel.classList.add('hidden'); delBtn.classList.add('hidden'); return; }

    const resp = await fetch(`/api/loops?filename=${encodeURIComponent(decodeURIComponent(host.currentFilename()))}`);
    const loops = await resp.json();

    sel.innerHTML = '<option value="">Saved Loops</option>';
    for (const l of loops) {
        sel.innerHTML += `<option value="${l.id}" data-start="${l.start}" data-end="${l.end}">${esc(l.name)} (${formatTime(l.start)}→${formatTime(l.end)})</option>`;
    }
    if (loops.length > 0) {
        sel.classList.remove('hidden');
    } else {
        sel.classList.add('hidden');
    }
    delBtn.classList.add('hidden');
}

export async function loadSavedLoop(loopId) {
    const sel = document.getElementById('saved-loops');
    const opt = sel.selectedOptions[0];
    const delBtn = document.getElementById('btn-loop-delete');
    if (!loopId || !opt?.dataset.start) {
        delBtn.classList.add('hidden');
        return;
    }
    let ok = false;
    try {
        // Pass raw strings — setLoop's Number() coercion is stricter than
        // parseFloat (rejects "12abc") so malformed dataset values throw
        // and fall into the catch instead of silently truncating.
        ok = await setLoop(opt.dataset.start, opt.dataset.end);
    } catch (err) {
        // Malformed dataset (server returned bad data): treat the same as
        // a failed seek so the dropdown resyncs and we don't propagate an
        // uncaught rejection out of the onchange handler.
        console.warn('[loadSavedLoop] setLoop threw:', err);
        ok = false;
    }
    if (!ok) {
        // Seek aborted, landed off-target, or input was malformed.
        // Resync the dropdown with the still-active loop so the UI
        // doesn't lie about which loop is loaded.
        _syncSavedLoopSelection();
        return;
    }
    // Success path: setLoop already called _syncSavedLoopSelection,
    // which surfaces the delete button when the new loop matches a
    // saved option (which the dropdown selection guarantees here).
}

export async function saveCurrentLoop() {
    if (loopA === null || loopB === null || !host.currentFilename()) return;
    const name = await uiPrompt({ title: 'Save Loop', label: 'Loop name', value: 'Loop', okLabel: 'Save' });
    if (name === null) return;          // cancelled
    const finalName = name.trim() || 'Loop';   // never persist an empty name
    await fetch('/api/loops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            filename: decodeURIComponent(host.currentFilename()),
            name: finalName,
            start: loopA,
            end: loopB,
        }),
    });
    await loadSavedLoops();
    document.getElementById('btn-loop-save').classList.add('hidden');
}

export async function deleteSelectedLoop() {
    const sel = document.getElementById('saved-loops');
    const loopId = sel.value;
    if (!loopId) return;
    await fetch(`/api/loops/${loopId}`, { method: 'DELETE' });
    clearLoop();
    await loadSavedLoops();
}
