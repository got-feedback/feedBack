// Resume last session — the snapshot taken when you leave a song, and the pill that
// offers it back.
//
// The fifth slice out of app.js's strongly-connected core. Small and self-contained:
// ONE hook (playSong) plus a currentFilename getter.
//
// The armed resume request itself lives on the shared container as S.pendingResume,
// not here, because app.js WRITES it — playSong({ resume }) arms it and the song:ready
// listener consumes it — while this module reads it. An imported binding is read-only,
// so shared mutable state has to live on the container. Same reason isPlaying does.
//
// See ./host.js: reading an unwired hook THROWS, and tests/js/host_contract.test.js
// fails CI if the hooks used here and the hooks app.js wires ever drift apart.
import { host } from './host.js';
import { _curPlaybackSpeed } from './player-controls.js';
import { S } from './player-state.js';

// ── Resume last session ────────────────────────────────────────────────────
// Leaving a song snapshots where you were — song, arrangement, position, and
// speed — so an exit (especially an accidental one, now that Escape reliably
// leaves regardless of focus) is recoverable instead of restarting from bar 1.
// The snapshot is offered back through a non-blocking "Resume" pill; it never
// gates, blocks, or auto-acts. Cleared on natural song-end and once consumed.
// (This is the player-session slice; the broader nav/state-resume work — e.g.
// returning to a song after wandering into Settings → Tone Builder — is a
// separate, larger track.)
const _RESUME_KEY = 'feedBack.resumeSession';
const _RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;   // a day-old snapshot is stale
const _RESUME_MIN_POSITION_S = 3;                  // ignore barely-started songs
const _RESUME_END_GUARD_S = 5;                      // ignore basically-finished songs
let _resumePillDismissed = false;                   // per-session: user waved off the current snapshot

// Snapshot the live session. Called from showScreen()'s teardown before
// window.highway.stop()/audio unload, while getSongInfo() + position are still valid.
export function _snapshotResumeSession(position) {
    try {
        if (!host.currentFilename()) return;
        const si = (window.highway && typeof window.highway.getSongInfo === 'function')
            ? (window.highway.getSongInfo() || {}) : {};
        const dur = Number(si.duration) || 0;
        const pos = Number(position) || 0;
        // Only worth resuming a song you were genuinely mid-way through — not a
        // glance at the first seconds, and not one that already basically ended.
        if (pos < _RESUME_MIN_POSITION_S) { _clearResumeSession(); return; }
        if (dur && pos > dur - _RESUME_END_GUARD_S) { _clearResumeSession(); return; }
        const snap = {
            f: host.currentFilename(),
            a: (typeof si.arrangement_index === 'number' && si.arrangement_index >= 0)
                ? si.arrangement_index : undefined,
            t: pos,
            sp: _curPlaybackSpeed(),
            title: si.title || '',
            artist: si.artist || '',
            ts: Date.now(),
        };
        localStorage.setItem(_RESUME_KEY, JSON.stringify(snap));
        // A fresh snapshot earns one offer — undo any earlier dismissal.
        _resumePillDismissed = false;
    } catch (_) { /* storage unavailable — resume is best-effort */ }
}

export function _readResumeSession() {
    try {
        const raw = localStorage.getItem(_RESUME_KEY);
        if (!raw) return null;
        const snap = JSON.parse(raw);
        if (!snap || !snap.f || !(Number(snap.t) > 0)) return null;
        if (!snap.ts || Date.now() - snap.ts > _RESUME_MAX_AGE_MS) { _clearResumeSession(); return null; }
        return snap;
    } catch (_) { return null; }
}

export function _clearResumeSession() {
    try { localStorage.removeItem(_RESUME_KEY); } catch (_) {}
}

// Re-enter the snapshotted song and restore arrangement + position + speed.
export async function resumeLastSession() {
    const snap = _readResumeSession();
    if (!snap) { _hideResumePill(); return false; }
    _hideResumePill();
    try {
        await host.playSong(snap.f, snap.a, {
            resume: { position: Number(snap.t) || 0, speed: Number(snap.sp) || 1 },
        });
    } catch (err) {
        // A transient load/connect failure must not strand the user: keep the
        // snapshot so the pill can re-offer it on the next non-player screen,
        // rather than consuming the only copy before the song actually loaded.
        console.warn('[app] resume failed to load; keeping snapshot:', err);
        S.pendingResume = null;
        return false;
    }
    _clearResumeSession();   // consumed only after a successful load
    return true;
}

// ── Resume pill (non-blocking "continue where you left off") ────────────────
// Self-contained, inline-styled, body-appended so it works identically in the
// classic (v2) and v3 shells with no Tailwind rebuild. It only ever appears off
// the player screen, never blocks, and a dismiss forgets the current snapshot
// for the session.
export function _hideResumePill() {
    const el = document.getElementById('fb-resume-pill');
    if (el) el.remove();
}

export function _maybeShowResumePill() {
    const active = document.querySelector('.screen.active');
    if (active && active.id === 'player') { _hideResumePill(); return; }
    if (_resumePillDismissed) return;
    const snap = _readResumeSession();
    if (!snap) { _hideResumePill(); return; }
    if (document.getElementById('fb-resume-pill')) return;   // already shown

    const label = (snap.title || decodeURIComponent(snap.f || 'your last song')).toString();
    const pill = document.createElement('div');
    pill.id = 'fb-resume-pill';
    pill.setAttribute('role', 'status');
    pill.style.cssText = [
        'position:fixed', 'left:16px', 'bottom:16px', 'z-index:120',
        'display:flex', 'align-items:center', 'gap:10px',
        'max-width:min(90vw,360px)', 'padding:10px 12px',
        'background:rgba(17,24,39,0.96)', 'color:#e5e7eb',
        'border:1px solid rgba(148,163,184,0.25)', 'border-radius:10px',
        'box-shadow:0 6px 24px rgba(0,0,0,0.4)',
        'font:13px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    ].join(';');

    const text = document.createElement('div');
    text.style.cssText = 'flex:1;min-width:0';
    const t1 = document.createElement('div');
    t1.textContent = 'Resume practice';
    t1.style.cssText = 'font-weight:600;color:#fff';
    const t2 = document.createElement('div');
    t2.textContent = label;
    t2.style.cssText = 'opacity:0.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    text.appendChild(t1); text.appendChild(t2);

    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.textContent = 'Resume ▸';
    resumeBtn.style.cssText = 'flex:none;padding:6px 10px;border:0;border-radius:7px;background:#4080e0;color:#fff;font-weight:600;cursor:pointer';
    resumeBtn.addEventListener('click', () => { resumeLastSession(); });

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.setAttribute('aria-label', 'Dismiss');
    dismissBtn.textContent = '✕';
    dismissBtn.style.cssText = 'flex:none;padding:4px 6px;border:0;border-radius:7px;background:transparent;color:#9ca3af;cursor:pointer;font-size:14px';
    dismissBtn.addEventListener('click', () => { _resumePillDismissed = true; _hideResumePill(); });

    pill.appendChild(text);
    pill.appendChild(resumeBtn);
    pill.appendChild(dismissBtn);
    (document.body || document.documentElement).appendChild(pill);
}
