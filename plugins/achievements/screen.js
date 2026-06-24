/*
 * Achievements & Feats of Power — frontend engine (vanilla, constitution P-II).
 *
 * Renders into the two core Profile mount points (achievements epic):
 *   #v3-profile-feats-slot        → earned Feats trophy shelf (hidden-until-earned)
 *   #v3-profile-achievements-mount → full competency catalogue (locked = greyed),
 *                                    grouped by instrument via a secondary pill row.
 * Re-injects on every `v3:profile-rendered` (core wipes the mounts each render).
 *
 * Also exposes the cross-plugin registration API `window.feedBack.achievements`
 * (v1) so source plugins (Virtuoso, notedetect, …) contribute competency defs +
 * report unlocks without us hardcoding their vocabulary. Load-order safe via the
 * `window.__feedBackAchievementsPending` queue + `achievements:ready` event.
 *
 * INTEGRATION LAW: Feats read activity counters only (we POST batched activity on
 * song:ended); competency Achievements are evaluated from progression EVENTS only.
 * The two paths never cross.
 */
(function () {
    'use strict';

    var API = '/api/plugins/achievements';
    var bus = window.feedBack;
    if (!bus) return;  // bus must exist (capabilities.js); nothing to attach to.

    var esc = function (s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    };

    // ── State ────────────────────────────────────────────────────────────────
    var registered = {};   // id -> def (contributed + expanded baseline defs)
    var earned = {};       // id -> { tier, cls, category }
    var baseline = null;   // /catalog baseline blob
    var CAT_KEY = 'v3-profile-ach-cat';
    var INSTRUMENTS = ['guitar', 'bass', 'drums', 'keys'];

    function progState() {
        return (window.v3Progression && window.v3Progression.get()) || null;
    }
    function notedetectPresent() {
        return typeof window.createNoteDetector === 'function';
    }

    // ── Backend I/O ──────────────────────────────────────────────────────────
    function fetchJSON(path, opts) {
        return fetch(API + path, opts).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    }
    function postUnlock(def, tier) {
        return fetch(API + '/report-unlock', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: def.id, kind: def.kind || 'achievement',
                category: def.category || 'global', sourceId: def.sourceId || 'achievements',
                tier: tier || 0,
            }),
        }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    }
    function refreshEarned() {
        return fetchJSON('/earned').then(function (data) {
            earned = {};
            ((data && data.earned) || []).forEach(function (e) { earned[e.id] = e; });
        });
    }

    // ── Tier math (mirrors engine.tier_index_for) ────────────────────────────
    function tierIndexFor(tiers, value) {
        var idx = -1;
        (tiers || []).forEach(function (t, i) { if (value >= t) idx = i; });
        return idx;
    }
    function alreadyEarnedAtLeast(id, tier) {
        var e = earned[id];
        return e && e.tier >= tier;
    }

    // ── Registration API (v1) ────────────────────────────────────────────────
    function register(def) {
        if (!def || !def.id) return;
        registered[def.id] = {
            id: def.id, kind: def.kind || 'achievement', category: def.category || 'global',
            title: def.title || def.id, description: def.description || '',
            secret: !!def.secret, sourceId: def.sourceId || 'unknown',
        };
        scheduleRender();
    }
    function registerAll(defs) { (defs || []).forEach(register); }
    function unlock(id, opts) {
        var def = registered[id] || { id: id, kind: 'achievement', category: 'global', sourceId: 'unknown' };
        var tier = (opts && opts.tier) || 0;
        if (alreadyEarnedAtLeast(id, tier)) return Promise.resolve();
        return postUnlock(def, tier).then(function () {
            return refreshEarned().then(function () {
                // A contributed Feat unlock would enqueue a wall sync here when
                // opted-in (PR2/PR3); competency never syncs (integration law).
                scheduleRender();
            });
        });
    }
    function progress() { /* accepted, optional — display is greyed/earned, not bars */ }

    var api = { version: 1, register: register, registerAll: registerAll, unlock: unlock, progress: progress };
    bus.achievements = api;
    // Drain sources that loaded before us (minigames pending-queue pattern).
    try { (window.__feedBackAchievementsPending || []).forEach(function (fn) {
        try { typeof fn === 'function' ? fn(api) : register(fn); } catch (_) { /* noop */ }
    }); } catch (_) { /* noop */ }
    window.__feedBackAchievementsPending = null;
    try { bus.emit && bus.emit('achievements:ready', { version: 1 }); } catch (_) { /* noop */ }

    // ── Baseline competency: evaluate from progression EVENTS only ────────────
    function expandBaseline() {
        // Register baseline defs (always present — built-in progression is always
        // present) so they render greyed even before they're earned. Per-instrument
        // templates expand across the REAL paths that exist (auto-extends).
        if (!baseline) return;
        (baseline.global || []).forEach(function (d) {
            register({ id: d.id, kind: 'achievement', category: 'global', title: d.title,
                description: d.description, sourceId: 'achievements' });
        });
        var paths = (progState() && progState().paths) || [];
        var pathIds = paths.length ? paths.map(function (p) { return { id: p.id, name: p.name }; })
            : INSTRUMENTS.map(function (i) { return { id: i, name: i.charAt(0).toUpperCase() + i.slice(1) }; });
        (baseline.per_instrument || []).forEach(function (tpl) {
            pathIds.forEach(function (pi) {
                var inst = pi.name;
                register({
                    id: tpl.id + ':' + pi.id, kind: 'achievement', category: pi.id,
                    title: (tpl.title || '').replace(/\{Inst\}/g, inst),
                    description: (tpl.description || '').replace(/\{Inst\}/g, inst),
                    sourceId: 'achievements',
                });
            });
        });
    }

    function evaluateBaseline() {
        var prog = progState();
        if (!prog || !baseline) return;
        var defById = {};
        (baseline.global || []).forEach(function (d) { defById[d.id] = d; });

        // mastery_rank → first_steps / ascendant
        (baseline.global || []).forEach(function (d) {
            var crit = d.criterion || {};
            if (crit.type === 'mastery_rank') {
                var ti = tierIndexFor(crit.tiers || d.tiers, prog.mastery_rank || 0);
                if (ti >= 0) baselineUnlock(d.id, 'global', ti);
            } else if (crit.type === 'paths_at_level') {
                var n = ((prog.paths) || []).filter(function (p) { return (p.level || 0) >= (crit.level || 10); }).length;
                var ti2 = tierIndexFor(crit.tiers || d.tiers, n);
                if (ti2 >= 0) baselineUnlock(d.id, 'global', ti2);
            }
        });

        // per-instrument path_rank → reach Lv 10/25/max in that path
        var tpl = (baseline.per_instrument || []).filter(function (t) { return t.id === 'path_rank'; })[0];
        if (tpl) {
            ((prog.paths) || []).forEach(function (p) {
                var thresholds = (tpl.criterion && tpl.criterion.tiers) || [10, 25, 'max'];
                var resolved = thresholds.map(function (t) { return t === 'max' ? (p.max_level || 9999) : t; });
                var ti = tierIndexFor(resolved, p.level || 0);
                if (ti >= 0) baselineUnlock('path_rank:' + p.id, p.id, ti);
            });
        }
    }

    function baselineUnlock(id, category, tier) {
        if (alreadyEarnedAtLeast(id, tier)) return;
        var def = registered[id] || { id: id, kind: 'achievement', category: category, sourceId: 'achievements' };
        postUnlock(def, tier).then(function () { refreshEarned().then(scheduleRender); });
    }

    // growth-streak + challenger record on real competency events (date ledger /
    // distinct challenge sets) — kept as bookkeeping over EVENTS, never activity.
    function recordGrowthDay() {
        var date = new Date();
        var iso = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
        fetchJSON('/report-criterion', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ criterion_id: 'steady_hands_days', token: iso }),
        }).then(function (res) {
            if (!res) return;
            var d = ((baseline && baseline.global) || []).filter(function (x) { return x.id === 'steady_hands'; })[0];
            var ti = tierIndexFor((d && d.tiers) || [7, 30, 100], res.count || 0);
            if (ti >= 0) baselineUnlock('steady_hands', 'global', ti);
        });
    }

    // ── Activity (Feats): in-memory session counters, flushed on song:ended ───
    var session = { notesTotal: 0 };           // cumulative across this sitting
    var song = { hits: 0, streak: 0, maxStreak: 0, chart: null };
    function resetSong(chart) { song = { hits: 0, streak: 0, maxStreak: 0, chart: chart || null }; }

    function flushActivity(seconds) {
        // No notedetect → song.hits stays 0; notes-based Feats simply don't move
        // (graceful degradation). song_done / seconds / chart still flow so the
        // notedetect-free Feats (Road Warrior, Time Served, Encore) progress.
        var hour = new Date().getHours();
        var isNight = hour >= 2 && hour < 5;
        var d = new Date();
        var iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        var body = {
            notes: song.hits,
            session_notes: session.notesTotal,
            in_song_streak: song.maxStreak,
            song_done: 1,
            seconds: Math.max(0, Math.round(seconds || 0)),
            chart: song.chart,
            night_session: isNight,
            night_date: isNight ? iso : null,
        };
        fetchJSON('/activity', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(function (res) {
            if (res && res.unlocked && res.unlocked.length) {
                // A Feat just unlocked — refresh the shelf + toast via the bus.
                fetchFeatsAndRender();
                res.unlocked.forEach(function (f) {
                    try { bus.emit && bus.emit('achievements:feat-unlocked', f); } catch (_) { /* noop */ }
                });
            }
        });
    }

    // ── Rendering ────────────────────────────────────────────────────────────
    var _renderQueued = false;
    function scheduleRender() {
        if (_renderQueued) return;
        _renderQueued = true;
        (window.requestAnimationFrame || window.setTimeout)(function () { _renderQueued = false; renderAll(); }, 0);
    }

    function renderAll() {
        renderCatalog();
        fetchFeatsAndRender();
    }

    function categoriesForDisplay() {
        var cats = [{ id: 'global', name: 'Global' }];
        var paths = (progState() && progState().paths) || [];
        if (paths.length) {
            paths.forEach(function (p) { cats.push({ id: p.id, name: p.name }); });
        } else {
            // Fallback before progression loads: show the known instrument cats
            // that actually have registered items.
            INSTRUMENTS.forEach(function (i) {
                if (Object.keys(registered).some(function (id) { return registered[id].category === i; })) {
                    cats.push({ id: i, name: i.charAt(0).toUpperCase() + i.slice(1) });
                }
            });
        }
        return cats;
    }

    function itemsForCategory(catId) {
        return Object.keys(registered).map(function (id) { return registered[id]; })
            .filter(function (d) { return (d.category || 'global') === catId; })
            // Hide un-earned secret items (revealed only once earned).
            .filter(function (d) { return !d.secret || earned[d.id]; });
    }

    function renderCatalog() {
        var mount = document.getElementById('v3-profile-achievements-mount');
        if (!mount) return;
        // Hide the core empty-state note now that we own this mount.
        var emptyNote = document.querySelector('[data-empty-for="v3-profile-achievements-mount"]');
        if (emptyNote) emptyNote.style.display = 'none';

        var cats = categoriesForDisplay();
        var saved = null;
        try { saved = localStorage.getItem(CAT_KEY); } catch (_) { /* noop */ }
        // Default to the player's primary path (first path), fallback Global.
        var primary = (progState() && progState().paths && progState().paths[0] && progState().paths[0].id) || 'global';
        var active = cats.some(function (c) { return c.id === saved; }) ? saved
            : (cats.some(function (c) { return c.id === primary; }) ? primary : 'global');

        var pills = cats.map(function (c) {
            var items = itemsForCategory(c.id);
            var got = items.filter(function (d) { return earned[d.id]; }).length;
            return '<button type="button" class="fb-ach-pill' + (c.id === active ? ' active' : '') +
                '" data-cat="' + esc(c.id) + '">' + esc(c.name) +
                ' <span class="fb-ach-pill-badge">' + got + '/' + items.length + '</span></button>';
        }).join('');

        var items = itemsForCategory(active);
        var list = items.length ? items.map(function (d) {
            var got = !!earned[d.id];
            var tier = got ? (earned[d.id].tier || 0) : -1;
            return '<div class="fb-ach-item' + (got ? ' earned' : ' locked') + '">' +
                '<div class="fb-ach-item-icon">' + (got ? '🏅' : '🔒') + '</div>' +
                '<div class="fb-ach-item-body">' +
                '<div class="fb-ach-item-title">' + esc(d.title) +
                (got && tier > 0 ? ' <span class="fb-ach-tier">tier ' + (tier + 1) + '</span>' : '') + '</div>' +
                '<div class="fb-ach-item-desc">' + esc(d.description) + '</div>' +
                '</div></div>';
        }).join('') : '<p class="fb-tabpanel-empty">No achievements in this category yet.</p>';

        mount.innerHTML =
            '<div class="fb-ach-pillrow">' + pills + '</div>' +
            '<div class="fb-ach-list">' + list + '</div>';
        mount.querySelectorAll('[data-cat]').forEach(function (b) {
            b.addEventListener('click', function () {
                try { localStorage.setItem(CAT_KEY, b.dataset.cat); } catch (_) { /* noop */ }
                renderCatalog();
            });
        });
    }

    function fetchFeatsAndRender() {
        return fetchJSON('/feats').then(function (data) { renderFeats((data && data.feats) || []); });
    }

    function renderFeats(feats) {
        var slot = document.getElementById('v3-profile-feats-slot');
        if (!slot) return;
        if (!feats.length) { slot.innerHTML = ''; return; }  // hidden-until-earned
        var cards = feats.map(function (f) {
            return '<div class="fb-feat-card" title="' + esc(f.description) + '">' +
                '<div class="fb-feat-icon">🏆</div>' +
                '<div class="fb-feat-title">' + esc(f.title) + '</div>' +
                '<div class="fb-feat-desc">' + esc(f.description) + '</div>' +
                '</div>';
        }).join('');
        // Opt-out users get a subtle wall hint linking to Settings (PR2 wires it).
        var hint = '';
        slot.innerHTML =
            '<div class="bg-fb-card/80 backdrop-blur rounded-xl p-6 border border-fb-border/50">' +
            '<h3 class="text-lg font-bold text-fb-text mb-3">Feats of Power</h3>' +
            '<div class="fb-feat-shelf">' + cards + '</div>' + hint +
            '</div>';
    }

    // ── Boot ─────────────────────────────────────────────────────────────────
    function init() {
        fetchJSON('/catalog').then(function (data) {
            baseline = (data && data.baseline) || {};
            ((data && data.earned) && (earned = {}, Object.keys(data.earned).forEach(function (id) { earned[id] = data.earned[id]; })));
            expandBaseline();
            evaluateBaseline();
            scheduleRender();
        });
        // Re-inject on every profile entry (core wipes the mounts each render).
        document.addEventListener('v3:profile-rendered', function () { renderAll(); });

        // Competency events → re-expand (paths may have appeared) + re-evaluate.
        ['progression:updated', 'progression:rank-changed', 'progression:path-level-up'].forEach(function (ev) {
            bus.on && bus.on(ev, function () { expandBaseline(); evaluateBaseline(); });
        });
        // A real competency advance ticks the growth-streak day ledger.
        ['progression:rank-changed', 'progression:path-level-up', 'progression:challenge-completed'].forEach(function (ev) {
            bus.on && bus.on(ev, function () { recordGrowthDay(); });
        });
        // challenger:<inst> — clearing a full level-up set for a path.
        bus.on && bus.on('progression:path-level-up', function (e) {
            var pid = e && e.detail && (e.detail.path_id || e.detail.id);
            if (pid) baselineUnlock('challenger:' + pid, pid, 0);
        });

        // Activity (Feats) — in-memory counters, flushed once per song.
        bus.on && bus.on('song:loading', function (e) {
            resetSong(e && e.detail && e.detail.filename);
        });
        bus.on && bus.on('note:hit', function () {
            song.hits++; song.streak++; session.notesTotal++;
            if (song.streak > song.maxStreak) song.maxStreak = song.streak;
        });
        bus.on && bus.on('note:miss', function () { song.streak = 0; });
        bus.on && bus.on('song:ended', function (e) {
            flushActivity(e && e.detail && (e.detail.time || e.detail.audioT));
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
