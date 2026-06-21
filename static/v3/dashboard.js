/*
 * fee[dB]ack v0.3.0 — Dashboard / Home (#v3-home).
 *
 * Composes data from the backends built in other prompts: profile (15),
 * song-stats/recent (14), continue (16), library stats + plugins. Each widget
 * fetches + renders independently and DEGRADES GRACEFULLY — a missing/empty
 * endpoint shows a placeholder, never blocks first paint (design/05 §1).
 * Vanilla JS, fb-* tokens (constitution P-II).
 */
(function () {
    'use strict';
    const sm = window.slopsmith;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const enc = encodeURIComponent;
    const jget = async (u) => { try { const r = await fetch(u); return r.ok ? r.json() : null; } catch (e) { return null; } };

    function libArtUrl(song) {
        const v = song.mtime ? ('?v=' + Math.floor(song.mtime)) : '';
        return '/api/song/' + enc(song.filename) + '/art' + v;
    }

    // A random library song (for the "Pick a song" card when nothing's been played).
    async function randomSong() {
        const stats = await jget('/api/library/stats');
        const total = (stats && (stats.total_songs ?? stats.total)) || 0;
        if (!total) return null;
        const idx = Math.floor(Math.random() * total);
        const data = await jget('/api/library?size=1&page=' + idx);
        return data && data.songs && data.songs[0] ? data.songs[0] : null;
    }

    // Accuracy badge ramp (design/04-badges.md §C): ≥90% good, 50–89% mid, <50% low.
    function accuracyBadge(acc) {
        if (acc == null) return '';
        const pct = Math.round(acc * 100);
        const color = acc >= 0.9 ? 'bg-fb-good' : (acc >= 0.5 ? 'bg-fb-mid' : 'bg-fb-low');
        const text = acc >= 0.5 && acc < 0.9 ? 'text-black' : 'text-white';
        return '<span class="absolute bottom-0 right-0 ' + color + '/90 ' + text +
            ' px-2 py-1 rounded-tl-md text-xs font-bold flex items-center gap-1">' +
            '<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/></svg>' +
            pct + '%</span>';
    }

    function songArt(url, extra) {
        return '<img src="' + esc(url) + '" alt="" class="' + (extra || '') +
            '" onerror="this.style.visibility=\'hidden\'">';
    }

    function tuningChip(name, cls) {
        if (!name) return '';
        return '<span class="' + (cls || '') + ' bg-fb-mid text-black text-xs font-bold px-2 py-1 rounded-sm">' + esc(name) + '</span>';
    }

    // Source format of a song — prefer the server's `format`, fall back to the
    // filename extension. '' = unknown.
    function fmtName(song) {
        let f = ((song && song.format) || '').toLowerCase();
        if (!f) {
            const fn = ((song && song.filename) || '').toLowerCase();
            f = fn.endsWith('.sloppak') ? 'sloppak' : '';
        }
        return f === 'sloppak' ? 'SLOPPAK' : f === 'loose' ? 'FOLDER' : '';
    }
    // Corner badge for art-thumbnail cards (sloppak accented, others muted).
    function fmtBadge(song) {
        const l = fmtName(song);
        if (!l) return '';
        const c = l === 'SLOPPAK' ? 'bg-fb-primary text-white' : 'bg-black/70 text-fb-textDim';
        return '<span class="absolute bottom-0 left-0 ' + c + ' text-[9px] font-bold px-1.5 py-0.5 rounded-tr-md tracking-wide">' + l + '</span>';
    }
    // Inline pill for the hero (Pick/Continue) card, where the art is text-overlaid
    // and a corner badge would collide — sits next to the card's label instead.
    function fmtTag(song) {
        const l = fmtName(song);
        if (!l) return '';
        const c = l === 'SLOPPAK' ? 'bg-fb-primary/20 text-fb-primary' : 'bg-fb-card/80 text-fb-textDim';
        return '<span class="' + c + ' text-[9px] font-bold px-1.5 py-0.5 rounded tracking-wide shrink-0">' + l + '</span>';
    }

    // ── Continue-Playing resume ──────────────────────────────────────────---
    function resume(filename, lastPosition, arrangement) {
        if (typeof window.playSong !== 'function') return;
        // playSong expects an encoded filename (it decodeURIComponent()s it for
        // the highway WS) and takes the arrangement index as its 2nd arg — pass
        // both so resume reopens the exact arrangement the user left, not the
        // default. It has no start-time arg, so play then best-effort seek once
        // the session is up (constitution: highway WS).
        Promise.resolve(window.playSong(enc(filename), arrangement)).then(() => {
            if (Number.isFinite(lastPosition) && lastPosition > 0 && sm && typeof sm.seek === 'function') {
                setTimeout(() => { try { sm.seek(lastPosition, 'continue-playing'); } catch (e) { /* */ } }, 800);
            }
        });
    }

    // ── Render ───────────────────────────────────────────────────────────---
    async function render() {
        const root = document.getElementById('v3-home');
        if (!root) return;

        // Kick off independent fetches.
        const [profile, version, cont, libStats, plugins, recent] = await Promise.all([
            jget('/api/profile'), jget('/api/version'), jget('/api/session/continue'),
            jget('/api/library/stats'), jget('/api/plugins'), jget('/api/stats/recent?limit=6'),
        ]);

        const name = (profile && profile.display_name) || 'there';
        const ver = (version && version.version) || '';
        const changelogUrl = ((version && version.source_url) || 'https://github.com/got-feedback/feedBack') + '/blob/main/CHANGELOG.md';
        const songCount = (libStats && (libStats.total_songs ?? libStats.total)) || 0;
        const pluginCount = Array.isArray(plugins)
            ? plugins.filter((p) => (p && (p.status || 'ready') === 'ready')).length : 0;

        // "Jump back in": scored recents, else fall back to recently-added songs
        // so the section is never empty on a fresh profile.
        let recentList = Array.isArray(recent) ? recent : [];
        if (!recentList.length) {
            const lib = await jget('/api/library?sort=recent&size=6&page=0');
            recentList = ((lib && lib.songs) || []).map((s) => ({
                filename: s.filename, title: s.title, artist: s.artist,
                art_url: libArtUrl(s), best_accuracy: null,
            }));
        }
        // When nothing's been played, the Continue card becomes a random
        // pick-a-song that plays on click.
        const pick = (cont && cont.filename) ? null : await randomSong();

        // Continue card.
        let continueCard;
        if (cont && cont.filename) {
            const dur = cont.duration || 0;
            const segs = 4;
            const filled = dur > 0 ? Math.round((cont.last_position / dur) * segs) : 0;
            const bars = Array.from({ length: segs }, (_, i) =>
                '<span class="flex-1 h-1.5 rounded-full ' + (i < filled ? 'bg-fb-primary' : 'bg-gray-500/40') + '"></span>').join('');
            continueCard =
                '<button id="v3-continue" data-tour="continue" class="group relative text-left rounded-xl overflow-hidden border border-fb-border/50 bg-fb-card aspect-square self-start flex flex-col justify-end">' +
                songArt(cont.art_url, 'absolute inset-0 w-full h-full object-cover opacity-60 group-hover:opacity-70 transition') +
                '<div class="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent"></div>' +
                tuningChip(cont.tuning_name, 'absolute top-3 right-3') +
                '<div class="relative p-4">' +
                '<div class="flex items-center justify-between gap-2 mb-1"><span class="text-xs uppercase tracking-wider text-fb-textDim">Continue Playing</span>' + fmtTag(cont) + '</div>' +
                '<div class="text-fb-text font-bold truncate">' + esc(cont.title) + '</div>' +
                '<div class="text-sm text-fb-textDim truncate mb-3">' + esc(cont.artist) + '</div>' +
                '<div class="flex gap-1">' + bars + '</div></div>' +
                '<span class="absolute top-3 left-3 text-fb-text/80 group-hover:text-fb-text">▶</span></button>';
        } else if (pick) {
            continueCard =
                '<button id="v3-pick" data-tour="continue" data-fn="' + esc(pick.filename) + '" class="group relative text-left rounded-xl overflow-hidden border border-fb-border/50 bg-fb-card aspect-square self-start flex flex-col justify-end">' +
                songArt(libArtUrl(pick), 'absolute inset-0 w-full h-full object-cover opacity-60 group-hover:opacity-70 transition') +
                '<div class="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent"></div>' +
                tuningChip(pick.tuning_name, 'absolute top-3 right-3') +
                '<div class="relative p-4">' +
                '<div class="flex items-center justify-between gap-2 mb-1"><span class="text-xs uppercase tracking-wider text-fb-textDim">Pick a song</span>' + fmtTag(pick) + '</div>' +
                '<div class="text-fb-text font-bold truncate">' + esc(pick.title) + '</div>' +
                '<div class="text-sm text-fb-textDim truncate">' + esc(pick.artist) + '</div></div>' +
                '<span class="absolute top-3 left-3 text-fb-text/80 group-hover:text-fb-text">▶</span></button>';
        } else {
            continueCard =
                '<div data-tour="continue" class="rounded-xl border border-fb-border/50 bg-fb-card/60 aspect-square self-start flex flex-col items-center justify-center text-center p-4">' +
                '<div class="text-fb-textDim text-sm mb-3">Pick a song to get started</div>' +
                '<button id="v3-continue-pick" class="bg-fb-card hover:bg-fb-card/70 border border-fb-border/50 text-fb-text text-sm px-4 py-2 rounded-md">Browse library</button></div>';
        }

        // Recently played.
        let recentSection;
        if (recentList.length) {
            const cards = recentList.map((r) =>
                '<button data-recent="' + esc(r.filename) + '" data-arr="' + esc(r.arrangement != null ? r.arrangement : '') + '" class="group text-left">' +
                '<div class="relative aspect-square rounded-lg overflow-hidden bg-fb-card">' +
                songArt(r.art_url, 'w-full h-full object-cover transition-transform duration-300 group-hover:scale-105') +
                accuracyBadge(r.best_accuracy) + fmtBadge(r) + '</div>' +
                '<div class="mt-1 text-sm text-fb-text truncate">' + esc(r.title) + '</div>' +
                '<div class="text-xs text-fb-textDim truncate">' + esc(r.artist) + '</div></button>').join('');
            recentSection =
                '<section class="mt-10"><h3 class="text-2xl font-bold text-fb-text mb-4">Jump back in!</h3>' +
                '<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">' + cards + '</div></section>';
        } else {
            recentSection =
                '<section class="mt-10"><h3 class="text-2xl font-bold text-fb-text mb-4">Jump back in!</h3>' +
                '<p class="text-fb-textDim text-sm">Play a song to see it here.</p></section>';
        }

        root.innerHTML =
            '<div class="max-w-7xl mx-auto px-6 md:px-8 pb-8">' +
            // (Title "Welcome back, {name}!" lives in the topbar header row.)
            (ver ? '<p class="text-sm text-fb-textDim">Have you read the latest changes in the ' +
                '<a href="' + esc(changelogUrl) + '" target="_blank" rel="noopener" class="text-fb-primary hover:text-fb-primaryHi">Patch Notes for ' + esc(ver) + '</a>?</p>' : '') +
            // Featured grid: hero + continue
            '<div class="grid lg:grid-cols-3 gap-6 mt-6">' +
            '<div id="v3-hero" class="lg:col-span-2 relative rounded-xl overflow-hidden min-h-[480px] flex items-center bg-fb-bg">' +
            // Hero artwork (neon note-highway), right-anchored. Placeholder
            // cropped from the design mock — swap static/v3/brand/hero.png for
            // the designer's high-res original (same path) when available.
            '<img src="/static/v3/brand/hero.png" alt="" aria-hidden="true" ' +
            'class="absolute inset-y-0 right-0 h-full w-2/3 object-cover object-right" ' +
            'onerror="this.style.display=\'none\'">' +
            // 135° gradient overlay: solid navy on the left for text legibility,
            // fading to transparent so the artwork shows through on the right.
            '<div class="absolute inset-0" style="background-image:linear-gradient(135deg,#0f172a 0%,#0f172a 40%,rgba(15,23,42,0.55) 65%,rgba(15,23,42,0.15) 100%);"></div>' +
            '<div class="relative p-8 max-w-md">' +
            '<h3 class="text-4xl font-bold leading-tight text-fb-text">Turn any song into practice.</h3>' +
            '<p class="text-fb-textDim mt-2">Play along to your library, track your accuracy, and rank up.</p>' +
            '<div class="flex gap-3 mt-5">' +
            '<button id="v3-start" class="bg-fb-primary hover:bg-fb-primaryHi text-white px-6 py-2 rounded-md font-medium shadow-lg shadow-fb-primary/20">Start Playing</button>' +
            '<button id="v3-lessons-btn" class="bg-transparent border border-fb-textDim hover:border-white text-white px-6 py-2 rounded-md font-medium">Lessons</button>' +
            '</div></div></div>' +
            continueCard +
            '</div>' +
            // Stats row
            '<div class="grid md:grid-cols-3 gap-6 mt-6">' +
            audioRoutingCard() +
            statCard(String(songCount), 'songs', 'text-fb-gold') +
            statCard(String(pluginCount), 'active', 'text-fb-good') +
            '</div>' +
            recentSection +
            '</div>';

        // Wire interactions.
        const startBtn = root.querySelector('#v3-start');
        if (startBtn) startBtn.addEventListener('click', () => {
            if (cont && cont.filename) resume(cont.filename, cont.last_position, cont.arrangement);
            else if (pick) window.playSong && window.playSong(enc(pick.filename));
            else window.showScreen && window.showScreen('v3-songs');
        });
        root.querySelector('#v3-continue')?.addEventListener('click', () => resume(cont.filename, cont.last_position, cont.arrangement));
        root.querySelector('#v3-pick')?.addEventListener('click', () => window.playSong && window.playSong(enc(pick.filename)));
        root.querySelector('#v3-continue-pick')?.addEventListener('click', () => window.showScreen && window.showScreen('v3-songs'));
        root.querySelector('#v3-lessons-btn')?.addEventListener('click', () => window.showScreen && window.showScreen('v3-lessons'));
        root.querySelectorAll('[data-recent]').forEach((b) =>
            b.addEventListener('click', () => {
                if (!window.playSong) return;
                // /api/stats/recent rows are arrangement-specific — reopen the
                // arrangement that was actually played, not the default.
                const arr = b.getAttribute('data-arr');
                window.playSong(enc(b.getAttribute('data-recent')), arr === '' || arr == null ? undefined : Number(arr));
            }));

        // Let prompt 18 enhance the audio-routing card once it exists.
        if (window.v3AudioRouting && typeof window.v3AudioRouting.render === 'function') {
            try { window.v3AudioRouting.render(document.getElementById('v3-audio-routing')); } catch (e) { /* */ }
        }
    }

    function statCard(value, unit, unitColor) {
        return '<div class="bg-fb-card/80 backdrop-blur rounded-lg p-4 border border-fb-border/50 flex flex-col justify-center">' +
            '<div class="text-2xl font-bold text-fb-text">' + esc(value) +
            ' <span class="text-sm font-medium ' + unitColor + '">' + esc(unit) + '</span></div></div>';
    }

    // Audio-routing widget placeholder (prompt 18 replaces #v3-audio-routing's
    // body via window.v3AudioRouting). Until then: "Not Connected".
    function audioRoutingCard() {
        return '<div id="v3-audio-routing" class="bg-fb-card/80 backdrop-blur rounded-lg p-4 border border-fb-border/50">' +
            '<div class="flex items-center justify-between text-xs text-fb-textDim mb-2"><span>Audio Routing</span></div>' +
            '<div class="flex items-center gap-2 text-xs text-fb-textDim">' +
            '<span>Input</span><span class="flex-1 border-t border-dashed border-fb-border"></span>' +
            '<span class="w-2 h-2 rounded-full bg-gray-500"></span>' +
            '<span>VST/NAM/IR</span><span class="flex-1 border-t border-dashed border-fb-border"></span>' +
            '<span class="w-2 h-2 rounded-full bg-gray-500"></span><span>Output</span></div>' +
            '<div class="mt-2 text-sm font-medium text-fb-textDim">Not Connected</div></div>';
    }

    window.v3Dashboard = { render: render };
    if (sm && typeof sm.on === 'function') {
        sm.on('screen:changed', (e) => { if (e && e.detail && e.detail.id === 'v3-home') render(); });
        sm.on('v3:profile-updated', () => render());
    }
    function boot() { render(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
