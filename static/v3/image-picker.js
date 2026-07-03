// Cover-art picker (PR-C — multi-candidate "change cover", media-server
// style). ONE component: window.__fbOpenImagePicker({filename, title}),
// reached from the Details drawer's art click and the card ⋮ "Change cover…".
//
// Anatomy mirrors match-review.js (body-appended singleton: overlay +
// centred panel, light focus trap, Esc closes, overlay click closes) but
// layers at z-[200] — the songs.js centered-modal tier — because one of its
// openers is the details drawer (z-[61]), which sits above match-review's
// z-40/50 pair.
//
// The design's key trick (§7-§9/§11 of the launch charrette): a pick never
// grows a new write path. Choosing a CAA candidate POSTs its thumb URL to
// the EXISTING …/art/url route (the override lane: never evicted, survives
// a re-match); "Pack original" DELETEs the override; Upload POSTs the
// existing …/art/upload (GIF stays upload-only + local-only; the server's
// 10MB / http(s) guards apply to URLs). Success is silent (hearing-safe,
// like the match layer): the modal just closes and the art refreshes.
(function () {
    'use strict';

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const enc = encodeURIComponent;

    // Provenance badge text — same vocabulary as the match layer.
    const PROV_LABEL = { yours: 'Yours', pack: 'Pack', matched: 'Matched' };

    let _cur = null;        // {filename, title} while the picker is open
    let _abort = null;      // in-flight candidates fetch — cancelled on close
    let _busy = false;      // an apply is running — ignore further tile clicks
    let _lastFocus = null;

    const artBase = (fn) => '/api/song/' + enc(fn) + '/art';

    // Post-apply refresh — the grid's cache-buster idiom (`?v=`): re-src
    // every rendered <img> pointing at this song's art with a fresh v so the
    // new pick paints everywhere it's currently shown (grid card, drawer
    // preview, list row) without a full reload.
    function refreshArt(fn) {
        const base = artBase(fn);
        document.querySelectorAll('img').forEach((img) => {
            const src = img.getAttribute('src') || '';
            if (src.split('?')[0] === base) {
                img.src = base + '?v=' + Date.now();
                img.style.visibility = 'visible';
            }
        });
    }

    function ensureModal() {
        let m = document.getElementById('v3-imgpick-modal');
        if (m) return m;
        const overlay = document.createElement('div');
        overlay.id = 'v3-imgpick-overlay';
        overlay.className = 'fixed inset-0 bg-black/60 z-[200] hidden';
        overlay.addEventListener('click', close);
        document.body.appendChild(overlay);
        m = document.createElement('div');
        m.id = 'v3-imgpick-modal';
        // Appended after the overlay: same z tier, DOM order paints it above.
        m.className = 'fixed inset-0 z-[200] hidden flex items-center justify-center p-4 pointer-events-none';
        m.innerHTML = '<div id="v3-imgpick-panel" class="pointer-events-auto w-full max-w-2xl max-h-[85vh] bg-fb-sidebar border border-fb-border/50 rounded-xl shadow-2xl flex flex-col" role="dialog" aria-label="Change cover"></div>';
        m.addEventListener('keydown', onKeydown);
        document.body.appendChild(m);
        return m;
    }

    function onKeydown(e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
        if (e.key !== 'Tab') return;
        // Light focus trap: cycle within the panel (mirrors match-review).
        const panel = document.getElementById('v3-imgpick-panel');
        if (!panel) return;
        // Only trap VISIBLE focusables: hidden tiles (?source=pack 404 →
        // onerror .hidden, unloadable candidates, .hidden buttons) must never
        // catch a Tab. offsetParent is null for display:none / .hidden.
        const foci = Array.from(
            panel.querySelectorAll('button:not(.hidden), input:not(.hidden), [tabindex="0"]'),
        ).filter((el) => el.offsetParent !== null);
        if (!foci.length) return;
        const first = foci[0], last = foci[foci.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    function close() {
        if (_abort) { try { _abort.abort(); } catch (_) { /* already done */ } _abort = null; }
        document.getElementById('v3-imgpick-modal')?.classList.add('hidden');
        document.getElementById('v3-imgpick-overlay')?.classList.add('hidden');
        _cur = null;
        _busy = false;
        if (_lastFocus && _lastFocus.isConnected) { try { _lastFocus.focus(); } catch (_) { /* */ } }
        _lastFocus = null;
    }

    // One tile: a 6rem square art/icon face + a caption underneath.
    function tileHtml(attrs, face, label, hidden) {
        return '<button ' + attrs + ' class="group w-24 shrink-0 text-center' + (hidden ? ' hidden' : '') + '">' +
            '<span class="w-24 h-24 rounded-lg overflow-hidden bg-fb-card border border-fb-border/50 hover:border-fb-primary/60 flex items-center justify-center">' + face + '</span>' +
            '<span class="block text-xs text-fb-textDim group-hover:text-fb-text truncate pt-1">' + esc(label) + '</span></button>';
    }
    const imgFace = (src) => '<img src="' + esc(src) + '" alt="" loading="lazy" class="w-full h-full object-cover">';
    const iconFace = (glyph) => '<span class="text-2xl text-fb-textDim">' + glyph + '</span>';

    const SKELETON_TILE = '<span class="w-24 h-24 rounded-lg bg-fb-card animate-pulse shrink-0"></span>';

    function render(panel) {
        const fn = _cur.filename;
        // Fresh ?v so a reopened picker never shows a stale "current".
        const curSrc = artBase(fn) + '?v=' + Date.now();
        panel.innerHTML =
            '<div class="flex items-center justify-between gap-3 p-5 pb-3 border-b border-fb-border/40 shrink-0">' +
            '<div class="min-w-0"><h3 class="text-lg font-semibold text-fb-text">Change cover</h3>' +
            '<div class="text-xs text-fb-textDim truncate">' + esc(_cur.title || fn) + '</div></div>' +
            '<button data-ip-close class="text-fb-textDim hover:text-fb-text" aria-label="Close">✕</button></div>' +

            '<div class="p-5 flex flex-col sm:flex-row items-start gap-5 overflow-y-auto v3-scroll">' +
            // Left: the current cover + its provenance.
            '<div class="shrink-0">' +
            '<img data-ip-current src="' + esc(curSrc) + '" alt="" class="w-24 h-24 rounded-lg object-cover bg-fb-card" onerror="this.style.visibility=\'hidden\'">' +
            '<div class="pt-1 flex items-center gap-1.5">' +
            '<span class="text-xs text-fb-textDim">Current</span>' +
            '<span data-ip-prov class="hidden text-[0.625rem] px-1.5 py-0.5 rounded-full bg-gray-800/70 text-fb-textDim border border-gray-700"></span>' +
            '</div></div>' +
            // Right: the candidate tiles. First row acts instantly; CAA
            // candidates land behind the one /art/candidates fetch.
            '<div class="min-w-0 flex-1 space-y-3">' +
            '<div class="flex flex-wrap gap-3">' +
            tileHtml('data-ip-act="keep"', imgFace(curSrc), 'Current') +
            // Pack tile renders instantly and self-hides when the song ships
            // no art of its own (?source=pack 404s → img onerror); the
            // candidates response reconciles it either way.
            tileHtml('data-ip-act="pack"', imgFace(artBase(fn) + '?source=pack'), 'Pack original') +
            tileHtml('data-ip-act="upload"', iconFace('⤒'), 'Upload') +
            tileHtml('data-ip-act="url"', iconFace('🔗'), 'Paste URL') +
            '</div>' +
            '<div data-ip-caa>' +
            '<div class="flex flex-wrap gap-3">' + SKELETON_TILE + SKELETON_TILE + SKELETON_TILE + '</div>' +
            '<div class="text-xs text-fb-textDim pt-2">Fetching covers… the source is rate-limited.</div>' +
            '</div>' +
            '<div data-ip-status class="hidden text-xs text-fb-accent"></div>' +
            '</div></div>' +
            '<input type="file" accept="image/*" data-ip-file class="hidden">';

        wire(panel);
    }

    function wire(panel) {
        panel.querySelector('[data-ip-close]')?.addEventListener('click', close);
        // The pack tile self-hides when there is no pack art to show.
        const packTile = panel.querySelector('[data-ip-act="pack"]');
        const packImg = packTile ? packTile.querySelector('img') : null;
        if (packImg) packImg.onerror = () => packTile.classList.add('hidden');

        const file = panel.querySelector('[data-ip-file]');
        file?.addEventListener('change', () => {
            const f = file.files && file.files[0];
            if (!f) return;
            const rd = new FileReader();
            rd.onload = (e) => apply('upload', e.target.result);
            rd.readAsDataURL(f);
        });

        panel.querySelectorAll('[data-ip-act]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                if (_busy) return;
                const act = btn.getAttribute('data-ip-act');
                if (act === 'keep') { close(); return; }
                if (act === 'pack') { apply('pack'); return; }
                if (act === 'upload') { file?.click(); return; }
                if (act === 'url') {
                    // window.prompt is a silent no-op in Electron — use the
                    // project's injection-safe async modal; fall back to prompt
                    // only if it isn't loaded (mirrors other v3 callers' guard).
                    const ask = (typeof window.uiPrompt === 'function')
                        ? window.uiPrompt({
                            title: 'Paste URL',
                            label: 'Paste an image link (http or https)',
                            okLabel: 'Set cover',
                            placeholder: 'https://…',
                        })
                        : Promise.resolve(window.prompt('Paste an image link (http or https)'));
                    const u = String((await ask) || '').trim();
                    if (u) apply('url', u);
                }
            });
        });
        panel.querySelector('[data-ip-close]')?.focus();
    }

    // The one candidates fetch, cancelled if the modal closes first. Failure
    // (offline, demo mode, aborted) is silent: the skeletons just clear and
    // the instant tiles remain — never an error wall.
    function loadCandidates(panel) {
        const fn = _cur.filename;
        // Reopening without an intervening close() can leave a prior fetch in
        // flight — cancel it so only the newest request settles the tiles.
        if (_abort) { try { _abort.abort(); } catch (_) { /* already done */ } }
        _abort = new AbortController();
        fetch('/api/song/' + enc(fn) + '/art/candidates', { signal: _abort.signal })
            .then((r) => (r.ok ? r.json() : null))
            .then((body) => { if (_cur && _cur.filename === fn) patchCandidates(panel, body); })
            .catch(() => { if (_cur && _cur.filename === fn) patchCandidates(panel, null); });
    }

    function patchCandidates(panel, body) {
        const wrap = panel.querySelector('[data-ip-caa]');
        if (!wrap) return;
        const list = (body && body.candidates) || [];
        // Reconcile the instant tiles with what the server actually knows.
        const cur = list.find((c) => c.kind === 'current');
        const badge = panel.querySelector('[data-ip-prov]');
        if (badge && cur && PROV_LABEL[cur.provenance]) {
            badge.textContent = PROV_LABEL[cur.provenance];
            badge.classList.remove('hidden');
        }
        const packTile = panel.querySelector('[data-ip-act="pack"]');
        if (packTile) packTile.classList.toggle('hidden', !list.some((c) => c.kind === 'pack'));

        const caa = list.filter((c) => c.kind === 'caa' && c.thumb_url);
        if (!caa.length) { wrap.innerHTML = ''; return; }
        wrap.innerHTML = '<div class="text-xs font-semibold uppercase tracking-wider text-fb-textDim pb-2">Online covers</div>' +
            '<div class="flex flex-wrap gap-3">' +
            caa.map((c, i) => tileHtml(
                'data-ip-cand="' + i + '"',
                imgFace(c.thumb_url),
                c.label || 'Cover')).join('') +
            '</div>';
        wrap.querySelectorAll('[data-ip-cand]').forEach((btn) => {
            // A candidate whose thumb can't load isn't offerable — hide it
            // rather than let a click apply an image nobody saw.
            const img = btn.querySelector('img');
            if (img) img.onerror = () => btn.classList.add('hidden');
            btn.addEventListener('click', () => {
                if (_busy) return;
                const c = caa[Number(btn.getAttribute('data-ip-cand'))];
                if (c) apply('url', c.thumb_url);
            });
        });
    }

    // Apply a pick through the EXISTING routes; silent on success (close +
    // cache-busted refresh), inline note on failure (the modal stays open so
    // another tile can be tried).
    async function apply(kind, arg) {
        const fn = _cur && _cur.filename;
        if (!fn || _busy) return;
        _busy = true;
        let ok = false;
        try {
            let r = null;
            if (kind === 'url') {
                r = await fetch('/api/song/' + enc(fn) + '/art/url', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: arg }),
                });
            } else if (kind === 'upload') {
                r = await fetch('/api/song/' + enc(fn) + '/art/upload', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image: arg }),
                });
            } else if (kind === 'pack') {
                r = await fetch('/api/art/' + enc(fn) + '/override', { method: 'DELETE' });
            }
            if (r && r.ok) {
                // The art routes report soft failures as {error} bodies.
                const body = await r.json().catch(() => ({}));
                ok = !body.error;
            }
        } catch (_) { ok = false; }
        _busy = false;
        if (ok) { close(); refreshArt(fn); return; }
        const status = document.querySelector('#v3-imgpick-panel [data-ip-status]');
        if (status) {
            status.textContent = 'Couldn’t set that cover — try another image.';
            status.classList.remove('hidden');
        }
    }

    function openImagePicker(opts) {
        const filename = opts && opts.filename;
        if (!filename) return;
        _lastFocus = document.activeElement;
        _cur = { filename: filename, title: (opts && opts.title) || filename };
        _busy = false;
        const m = ensureModal();
        const panel = document.getElementById('v3-imgpick-panel');
        render(panel);
        m.classList.remove('hidden');
        document.getElementById('v3-imgpick-overlay')?.classList.remove('hidden');
        loadCandidates(panel);
    }

    window.__fbOpenImagePicker = openImagePicker;
})();
