/*
 * fee[dB]ack v0.3.0 — song-stats recorder (core glue).
 *
 * Bridges the highway note-detection scorer to the core song_stats store
 * (POST /api/stats). The scorer lives in the OPTIONAL external plugin
 * feedBack-plugin-notedetect, which emits `note:hit` / `note:miss` per note
 * on window.feedBack — note-detection is a DEFERRED capability domain, so we
 * use those legacy events directly (design/05-capability-pipelines.md). If the
 * plugin isn't installed, no note events fire and nothing is recorded
 * (graceful degrade — the dashboard simply shows no accuracy).
 *
 * Two paths:
 *   • Scored session: tally hits/misses (or accept an explicit
 *     `note_detect:session-ended` summary), then POST on song end.
 *   • Resume position: a lightweight POST of the play position (as the
 *     `lastPlayPosition` field, which /api/stats accepts alongside
 *     `last_position`) on pause/stop so Continue-Playing works for non-scored
 *     plays.
 *
 * Score/accuracy formula mirrors lib/song_score.py so badge == server.
 */
(function () {
    'use strict';
    const sm = window.feedBack;
    if (!sm || typeof sm.on !== 'function') return;

    let cur = null;             // active session
    let recordedThisSession = false;

    function reset(filename, arrangement) {
        cur = {
            filename: filename || null,
            arrangement: Number.isFinite(arrangement) ? arrangement : 0,
            hits: 0, misses: 0, streak: 0, bestStreak: 0,
            scored: false, lastTime: 0,
        };
        recordedThisSession = false;
    }

    // accuracy = hits / max(1, hits+misses); score = round(hits*100*accuracy)
    function accuracyOf(hits, misses) { return hits / Math.max(1, hits + misses); }
    function scoreOf(hits, misses) { return Math.round(hits * 100 * accuracyOf(hits, misses)); }

    async function post(body) {
        try {
            const r = await fetch('/api/stats', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            try { return await r.json(); } catch (e) { return null; }
        } catch (e) { return null; /* offline / endpoint absent — non-fatal */ }
    }

    // Fan the scored-POST outcome out to the progression core (challenge/quest
    // completion events + state refresh). Summary may be null (older server).
    // `posted` is the stats body we sent; `natural` is true when the song ran
    // to its end (vs. the user stopping early).
    async function notifyProgression(response, posted, natural) {
        const summary = response && response.progression;
        if (window.v3Progression && typeof window.v3Progression.notify === 'function') {
            // Await the notify promise (which wraps a refresh()) so the profile
            // badge renders post-award rank/dB rather than stale cached values.
            try { await window.v3Progression.notify(summary); } catch (e) { /* non-fatal */ }
        }
        // Calibration attempt feedback (spec 010): the diagnostic sloppak was
        // played to the end with scoring but below 100% — surface it so the UI
        // can offer a retry. Early quits don't prompt (the player bailed on
        // purpose), and neither do replays once calibration is completed.
        try {
            const state = window.v3Progression && window.v3Progression.get && window.v3Progression.get();
            const onboarding = (state && state.onboarding) || {};
            if (natural && posted && posted.filename &&
                posted.filename === onboarding.diagnostic_filename &&
                onboarding.calibration_status !== 'completed' &&
                !(summary && summary.calibration_completed) &&
                typeof posted.accuracy === 'number' && posted.accuracy < 1) {
                sm.emit('progression:calibration-attempt', { accuracy: posted.accuracy });
            }
        } catch (e) { /* feedback must never break stats recording */ }
    }

    function finalizeScored(position, natural) {
        if (!cur || !cur.filename || recordedThisSession) return;
        if (!cur.scored || (cur.hits + cur.misses) <= 0) return;  // no real scoring this session
        recordedThisSession = true;
        const body = {
            filename: cur.filename,
            arrangement: cur.arrangement,
            score: scoreOf(cur.hits, cur.misses),
            accuracy: accuracyOf(cur.hits, cur.misses),
            hits: cur.hits,
            misses: cur.misses,
            bestStreak: cur.bestStreak,
            lastPlayPosition: Number.isFinite(position) ? position : cur.lastTime,
        };
        post(body).then(async (response) => {
            await notifyProgression(response, body, !!natural);
            // Refresh the profile badge AFTER the progression state moved so
            // the rank/dB it renders are post-award values.
            if (window.v3Profile && typeof window.v3Profile.refresh === 'function') {
                window.v3Profile.refresh();
            }
            // Tell the library the song's best score may have changed so its
            // card/list badge refreshes without waiting for a restart.
            sm.emit('stats:recorded', { filename: body.filename, arrangement: body.arrangement });
        });
    }

    function touchPosition(position) {
        if (!cur || !cur.filename) return;
        // Allow 0: restarting a song and stopping at the very beginning must be
        // able to clear a stale Continue offset. Only negatives are invalid.
        if (!Number.isFinite(position) || position < 0) return;
        post({ filename: cur.filename, arrangement: cur.arrangement, lastPlayPosition: position });
    }

    // ── Session lifecycle ─────────────────────────────────────────────────--
    sm.on('song:loading', (e) => {
        const d = (e && e.detail) || {};
        reset(d.filename, d.arrangement == null ? 0 : Number(d.arrangement));
    });
    sm.on('song:arrangement-changed', (e) => {
        const d = (e && e.detail) || {};
        // Arrangement switch restarts scoring — treat as a fresh session.
        reset(d.filename || (cur && cur.filename), d.arrangement == null ? 0 : Number(d.arrangement));
    });

    // ── Per-note tally (from the note_detect plugin) ──────────────────────--
    sm.on('note:hit', () => {
        if (!cur) reset(null, 0);
        cur.scored = true; cur.hits++; cur.streak++;
        if (cur.streak > cur.bestStreak) cur.bestStreak = cur.streak;
    });
    sm.on('note:miss', () => {
        if (!cur) reset(null, 0);
        cur.scored = true; cur.misses++; cur.streak = 0;
    });

    // Track latest position for finalize fallbacks.
    sm.on('song:position-changed', (e) => {
        const t = e && e.detail && e.detail.time;
        if (cur && Number.isFinite(t)) cur.lastTime = t;
    });

    // ── Authoritative explicit summary (if the plugin emits one) ──────────--
    sm.on('note_detect:session-ended', (e) => {
        const d = (e && e.detail) || {};
        if (!d.filename || recordedThisSession) return;
        recordedThisSession = true;
        const body = {
            filename: d.filename,
            arrangement: d.arrangement == null ? 0 : Number(d.arrangement),
            score: d.score, accuracy: d.accuracy,
            hits: d.hits, misses: d.misses, bestStreak: d.bestStreak,
            lastPlayPosition: d.lastPlayPosition,
        };
        post(body).then(async (response) => {
            // The plugin's explicit summary is an authoritative session end —
            // treat it as a natural finish for calibration-retry feedback.
            await notifyProgression(response, body, true);
            if (window.v3Profile && typeof window.v3Profile.refresh === 'function') window.v3Profile.refresh();
            sm.emit('stats:recorded', { filename: body.filename, arrangement: body.arrangement });
        });
    });

    // ── Finalize / resume-position ────────────────────────────────────────--
    sm.on('song:ended', (e) => finalizeScored(e && e.detail && e.detail.time, true));
    sm.on('song:pause', (e) => touchPosition(e && e.detail && e.detail.time));
    sm.on('song:stop', (e) => {
        // Record the scored session if it wasn't already (e.g. user closed the
        // player before the track ended), then persist the resume position.
        // Not a natural end — no calibration-retry prompt for deliberate quits.
        const t = e && e.detail && e.detail.time;
        finalizeScored(t, false);
        touchPosition(t);
    });
})();
