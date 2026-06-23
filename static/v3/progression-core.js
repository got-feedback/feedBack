/*
 * fee[dB]ack v0.3.0 — progression core (spec 010).
 *
 * Shared client state for /api/progression (mastery rank, paths/challenges,
 * quests, Decibels wallet) AND the owner of the `progression` capability
 * domain (kind: command, safety: safe), so plugins coordinate through the
 * capability pipeline instead of private globals:
 *
 *   inspect                       → the full progression state
 *   record-event {type, payload}  → whitelisted event intake (minigame_run);
 *                                   song_completed is server-derived and denied
 *   list-shop / buy-item / equip-item
 *                                   (buy/equip require authorization:'user-action')
 *
 * Lifecycle events are emitted on the capability surface and mirrored on
 * window.feedBack as `progression:*` for non-capability consumers:
 * challenge-completed, quest-completed, quest-progressed, path-level-up,
 * path-progressed, rank-changed, db-changed, calibration-completed,
 * cosmetic-equipped (+ progression:updated whenever fresh state lands).
 * quest-progressed / path-progressed are the partial-advance counterparts to
 * the *-completed / *-level-up events (the achievement-toast feed).
 *
 * Vanilla JS, no framework (constitution P-II).
 */
(function () {
    'use strict';
    const sm = window.feedBack = window.feedBack || {};

    let _state = null;       // last /api/progression payload
    let _fetching = null;    // in-flight refresh (coalesced)

    function _emit(name, detail) {
        const capabilities = sm.capabilities;
        if (capabilities && capabilities.version === 1 && typeof capabilities.emitEvent === 'function') {
            try { capabilities.emitEvent('progression', name, detail || {}); } catch (e) { /* non-fatal */ }
        }
        if (typeof sm.emit === 'function') {
            try { sm.emit('progression:' + name, detail || {}); } catch (e) { /* non-fatal */ }
        }
    }

    // Index quests by "period:id" so a refresh can be diffed against the last
    // state (period_type isn't on the per-quest payload, so carry it here).
    function _questIndex(state) {
        const out = {};
        const quests = (state && state.quests) || {};
        ['daily', 'weekly'].forEach((period) => {
            (((quests[period] || {}).quests) || []).forEach((item) => {
                if (item && item.id != null) out[period + ':' + item.id] = { period, item };
            });
        });
        return out;
    }

    function _diff(prev, next) {
        if (!prev || !next) return;
        if (prev.mastery_rank !== next.mastery_rank) {
            _emit('rank-changed', { from: prev.mastery_rank, to: next.mastery_rank });
        }
        const before = (prev.wallet || {}).balance;
        const after = (next.wallet || {}).balance;
        if (before !== after) _emit('db-changed', { from: before, to: after, wallet: next.wallet });

        // Quest "advance" — a still-incomplete quest whose count rose since the
        // last state. The increment that COMPLETES a quest is intentionally left
        // to quest-completed (emitted from notify()'s summary) so a finished
        // quest surfaces once, not twice. A period rollover (count resets to 0,
        // or a brand-new quest id) produces no event.
        const prevQuests = _questIndex(prev);
        const nextQuests = _questIndex(next);
        Object.keys(nextQuests).forEach((key) => {
            const pq = prevQuests[key];
            const nq = nextQuests[key];
            if (pq && !nq.item.completed && Number(nq.item.count) > Number(pq.item.count)) {
                _emit('quest-progressed', Object.assign({ period_type: nq.period }, nq.item));
            }
        });

        // Path "progress" — a challenge toward the next level completed
        // (next.completed rose) WITHOUT a level-up. The level-up itself is
        // emitted as path-level-up from notify()'s summary, so it surfaces once.
        const prevPaths = {};
        (prev.paths || []).forEach((p) => { if (p && p.id != null) prevPaths[p.id] = p; });
        (next.paths || []).forEach((np) => {
            const pp = prevPaths[np && np.id];
            if (!pp || !np.next || !pp.next) return;
            if (np.level === pp.level && Number(np.next.completed) > Number(pp.next.completed)) {
                _emit('path-progressed', {
                    id: np.id, name: np.name, level: np.level,
                    next_level: np.next.level,
                    completed: np.next.completed, required: np.next.required,
                });
            }
        });
    }

    async function refresh() {
        if (_fetching) return _fetching;
        _fetching = (async () => {
            try {
                const r = await fetch('/api/progression');
                if (r.ok) {
                    const prev = _state;
                    _state = await r.json();
                    _diff(prev, _state);
                    _contributeDiagnostics();
                    if (typeof sm.emit === 'function') sm.emit('progression:updated', _state);
                }
            } catch (e) { /* offline — keep last-known state */ }
            _fetching = null;
            return _state;
        })();
        return _fetching;
    }

    // Fan a record-event / stats outcome summary out as lifecycle events, then
    // refresh the cached state. Anything that receives a summary payload
    // (stats-recorder, the minigames hub, the events command) feeds this.
    function notify(summary) {
        if (summary && typeof summary === 'object') {
            (summary.challenges_completed || []).forEach((c) => _emit('challenge-completed', c));
            (summary.quests_completed || []).forEach((q) => _emit('quest-completed', q));
            (summary.level_ups || []).forEach((l) => _emit('path-level-up', l));
            if (summary.calibration_completed) {
                // Capture the pre-completion status NOW, before refresh() below
                // flips the cached calibration_status to 'completed'. The handler
                // prefers detail.prior_calibration_status over the cache, so this
                // keeps the success modal correct even if the event is delivered
                // after a refresh has already landed.
                const prior = (_state && _state.onboarding && _state.onboarding.calibration_status) || null;
                _emit('calibration-completed', { prior_calibration_status: prior });
            }
        }
        return refresh();   // rank-changed / db-changed fall out of the diff
    }

    async function _post(url, body) {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}),
        });
        let data = {};
        try { data = await r.json(); } catch (e) { /* empty body */ }
        return { ok: r.ok, status: r.status, data };
    }

    // ── Diagnostics (redaction-safe: counts + totals only, no song names) ────
    function _contributeDiagnostics() {
        const diagnostics = sm.diagnostics;
        if (!diagnostics || typeof diagnostics.contribute !== 'function' || !_state) return;
        try {
            diagnostics.contribute('progression', {
                schema: 'feedBack.progression.diag.v1',
                mastery_rank: _state.mastery_rank,
                calibration_status: (_state.onboarding || {}).calibration_status,
                paths: (_state.paths || []).map((p) => ({ id: p.id, level: p.level, max_level: p.max_level })),
                quests: {
                    daily: ((_state.quests || {}).daily || {}).quests
                        ? _state.quests.daily.quests.filter((q) => q.completed).length + '/' + _state.quests.daily.quests.length
                        : null,
                    weekly: ((_state.quests || {}).weekly || {}).quests
                        ? _state.quests.weekly.quests.filter((q) => q.completed).length + '/' + _state.quests.weekly.quests.length
                        : null,
                },
                wallet: _state.wallet || null,
            });
        } catch (e) { /* diagnostics must never break progression */ }
    }

    // ── Capability domain owner ──────────────────────────────────────────────
    const _handled = (payload) => ({ outcome: 'handled', payload: payload || {} });
    const _denied = (reason, payload) => ({ outcome: 'denied', reason, payload: payload || {} });
    const _failed = (reason) => ({ outcome: 'failed', reason });

    function _registerOwner() {
        const capabilities = sm.capabilities;
        if (!capabilities || capabilities.version !== 1 || typeof capabilities.registerOwner !== 'function') return;
        capabilities.registerOwner('progression', {
            pluginId: 'core.progression',
            kind: 'command',
            ownership: 'exclusive-owner',
            safety: 'safe',
            commands: ['inspect', 'record-event', 'list-shop', 'buy-item', 'equip-item'],
            events: ['challenge-completed', 'quest-completed', 'quest-progressed',
                     'path-level-up', 'path-progressed', 'rank-changed',
                     'db-changed', 'calibration-completed', 'cosmetic-equipped'],
            description: 'Owns player progression: mastery rank, instrument-path challenges, daily/weekly quests, the Decibels wallet, and the cosmetics shop.',
            handlers: {
                inspect: async () => _handled((await refresh()) || {}),
                'record-event': async (ctx) => {
                    const payload = (ctx && ctx.payload) || {};
                    try {
                        const r = await _post('/api/progression/events',
                            { type: payload.type, payload: payload.payload || {} });
                        if (!r.ok) return _denied(r.data.error || ('HTTP ' + r.status));
                        notify(r.data.progression);
                        return _handled(r.data.progression);
                    } catch (e) { return _failed('progression event intake unreachable'); }
                },
                'list-shop': async () => {
                    try {
                        const r = await fetch('/api/shop');
                        if (!r.ok) return _failed('HTTP ' + r.status);
                        return _handled(await r.json());
                    } catch (e) { return _failed('shop unreachable'); }
                },
                'buy-item': async (ctx) => {
                    if (!ctx || ctx.authorization !== 'user-action') {
                        return _denied('buy-item requires authorization: user-action');
                    }
                    try {
                        const r = await _post('/api/shop/buy', { item_id: (ctx.payload || {}).item_id });
                        if (!r.ok) return _denied(r.data.error || ('HTTP ' + r.status), r.data);
                        refresh();
                        return _handled(r.data);
                    } catch (e) { return _failed('shop unreachable'); }
                },
                'equip-item': async (ctx) => {
                    if (!ctx || ctx.authorization !== 'user-action') {
                        return _denied('equip-item requires authorization: user-action');
                    }
                    const payload = ctx.payload || {};
                    try {
                        const r = await _post('/api/shop/equip',
                            { slot: payload.slot, item_id: payload.item_id == null ? null : payload.item_id });
                        if (!r.ok) return _denied(r.data.error || ('HTTP ' + r.status), r.data);
                        _emit('cosmetic-equipped', { slot: payload.slot, item_id: payload.item_id == null ? null : payload.item_id });
                        return _handled(r.data);
                    } catch (e) { return _failed('shop unreachable'); }
                },
            },
        });
    }

    // ── Public API + boot ────────────────────────────────────────────────────
    window.v3Progression = {
        refresh,
        notify,
        get: () => _state,
    };

    _registerOwner();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { refresh(); }, { once: true });
    } else {
        refresh();
    }
})();
