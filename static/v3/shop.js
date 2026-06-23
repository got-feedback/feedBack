/*
 * fee[dB]ack v0.3.0 — Shop screen (spec 010).
 *
 * Cosmetics catalog (themes + avatar frames) bought with Decibels earned by
 * playing — there is deliberately NO real-money path anywhere in this screen.
 * Buy/Equip dogfood the `progression` capability domain (buy-item/equip-item
 * with authorization:'user-action'), falling back to direct fetch when the
 * capability runtime is unavailable. Themes support a live preview via
 * window.v3Theme.apply; leaving the screen restores the equipped look.
 *
 * Vanilla JS, no framework (constitution P-II).
 */
(function () {
    'use strict';
    const sm = window.feedBack;
    const SCREEN_ID = 'v3-shop';

    let _data = null;        // last GET /api/shop payload
    let _previewing = null;  // item id currently previewed (theme slot only)

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmtDb = (n) => Number(n || 0).toLocaleString() + ' dB';

    async function load() {
        try {
            const r = await fetch('/api/shop');
            if (r.ok) _data = await r.json();
        } catch (e) { /* offline — keep stale */ }
        return _data;
    }

    // ── Capability-first actions (fetch fallback) ────────────────────────────
    async function _viaCapability(command, payload) {
        const capabilities = sm && sm.capabilities;
        if (capabilities && capabilities.version === 1) {
            const result = await capabilities.command('progression', command, {
                requester: 'core.shop-screen',
                origin: 'user',
                authorization: 'user-action',
                reason: 'Shop screen user action',
                payload,
            });
            return { ok: result.outcome === 'handled', reason: result.reason, payload: result.payload };
        }
        const url = command === 'buy-item' ? '/api/shop/buy' : '/api/shop/equip';
        const body = command === 'buy-item'
            ? { item_id: payload.item_id }
            : { slot: payload.slot, item_id: payload.item_id == null ? null : payload.item_id };
        try {
            const r = await fetch(url, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, reason: data.error, payload: data };
        } catch (e) { return { ok: false, reason: 'offline' }; }
    }

    async function buy(itemId) {
        const r = await _viaCapability('buy-item', { item_id: itemId });
        if (!r.ok && r.reason) toast(r.reason);
        await refresh();
    }

    async function equip(slot, itemId) {
        _previewing = null;
        const r = await _viaCapability('equip-item', { slot, item_id: itemId });
        if (!r.ok && r.reason) toast(r.reason);
        if (window.v3Theme) window.v3Theme.refresh();
        if (window.v3Profile) window.v3Profile.refresh();
        await refresh();
    }

    function toast(msg) {
        const root = document.getElementById(SCREEN_ID);
        const el = root && root.querySelector('[data-shop-toast]');
        if (!el) return;
        el.textContent = msg;
        el.classList.remove('hidden');
        setTimeout(() => el.classList.add('hidden'), 4000);
    }

    function previewTheme(item) {
        if (!window.v3Theme) return;
        if (_previewing === item.id) {
            _previewing = null;
            window.v3Theme.refresh();   // restore equipped look
        } else {
            _previewing = item.id;
            window.v3Theme.apply(item.payload);
        }
        render();
    }

    function stopPreview() {
        if (_previewing && window.v3Theme) {
            _previewing = null;
            window.v3Theme.refresh();
        }
    }

    // ── Rendering ────────────────────────────────────────────────────────────
    function swatches(item) {
        const c = (item.payload && item.payload.colors) || {};
        const picks = [c.bg, c.card, c.primary, c.accent, c.gold].filter(Boolean);
        if (!picks.length) return '';
        return '<div class="flex gap-1 mt-2">' + picks.map((hex) =>
            '<span class="w-5 h-5 rounded-full border border-fb-border/50" style="background-color:' + esc(hex) + '"></span>').join('') + '</div>';
    }

    function frameDemo(item) {
        const style = String((item.payload && item.payload.frame_style) || '').replace(/[{}<>"]/g, '');
        return '<div class="mt-2"><span class="inline-block w-10 h-10 rounded-xl bg-fb-bg/40" style="' + esc(style) + '"></span></div>';
    }

    function itemCard(item, balance) {
        const affordable = balance >= item.cost;
        let actions = '';
        if (item.equipped) {
            actions = '<button type="button" data-shop-unequip="' + esc(item.slot) + '" ' +
                'class="text-sm text-fb-textDim hover:text-fb-text px-3 py-1.5">Unequip</button>' +
                '<span class="text-sm font-semibold text-fb-good px-3 py-1.5">Equipped</span>';
        } else if (item.owned) {
            actions = '<button type="button" data-shop-equip="' + esc(item.id) + '" data-slot="' + esc(item.slot) + '" ' +
                'class="bg-fb-primary hover:bg-fb-primaryHi text-white text-sm font-medium px-4 py-1.5 rounded-md transition-colors">Equip</button>';
        } else {
            actions = '<button type="button" data-shop-buy="' + esc(item.id) + '" ' + (affordable ? '' : 'disabled ') +
                'class="bg-fb-primary hover:bg-fb-primaryHi disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-1.5 rounded-md transition-colors">' +
                'Buy · ' + fmtDb(item.cost) + '</button>';
        }
        if (item.slot === 'theme') {
            actions = '<button type="button" data-shop-preview="' + esc(item.id) + '" ' +
                'class="text-sm text-fb-primary hover:text-fb-primaryHi px-2 py-1.5">' +
                (_previewing === item.id ? 'Stop preview' : 'Preview') + '</button>' + actions;
        }
        return '<div class="bg-fb-card/80 backdrop-blur rounded-xl p-5 border ' +
            (item.equipped ? 'border-fb-good/50' : 'border-fb-border/50') + '">' +
            '<div class="flex items-start justify-between gap-2">' +
            '<div class="min-w-0"><h4 class="font-bold text-fb-text">' + esc(item.name) + '</h4>' +
            '<p class="text-xs text-fb-textDim mt-0.5">' + esc(item.description) + '</p>' +
            (item.slot === 'theme' ? swatches(item) : frameDemo(item)) + '</div>' +
            (!item.owned ? '<span class="text-xs font-semibold text-fb-gold shrink-0">' + fmtDb(item.cost) + '</span>' : '') +
            '</div>' +
            '<div class="flex items-center justify-end gap-1 mt-3">' + actions + '</div></div>';
    }

    function section(title, items, balance) {
        if (!items.length) return '';
        return '<div><h3 class="text-lg font-bold text-fb-text mb-3">' + title + '</h3>' +
            '<div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">' +
            items.map((i) => itemCard(i, balance)).join('') + '</div></div>';
    }

    function render() {
        const root = document.getElementById(SCREEN_ID);
        if (!root) return;
        if (!_data) {
            root.innerHTML = '<div class="max-w-5xl mx-auto p-6 md:p-8"><p class="text-sm text-fb-textDim">Loading shop…</p></div>';
            return;
        }
        const wallet = _data.wallet || { balance: 0, lifetime_db: 0 };
        const items = _data.items || [];
        root.innerHTML =
            '<div class="max-w-5xl mx-auto p-6 md:p-8 space-y-6">' +
            '<div class="bg-fb-card/80 backdrop-blur rounded-xl p-5 border border-fb-border/50 flex items-center justify-between gap-4 flex-wrap">' +
            '<div><div class="text-xs uppercase tracking-wider text-fb-textDim">Your Decibels</div>' +
            '<div class="text-3xl font-bold text-fb-gold mt-1">' + fmtDb(wallet.balance) + '</div></div>' +
            '<p class="text-xs text-fb-textDim max-w-xs text-right">Earn dB by playing songs, FeedBarcade rounds, and quests. Cosmetics only — never purchasable with money.</p>' +
            '</div>' +
            '<p data-shop-toast class="hidden text-sm text-fb-accent"></p>' +
            section('Themes', items.filter((i) => i.slot === 'theme'), wallet.balance) +
            section('Avatar frames', items.filter((i) => i.slot === 'avatar_frame'), wallet.balance) +
            '</div>';

        root.querySelectorAll('[data-shop-buy]').forEach((b) =>
            b.addEventListener('click', () => buy(b.getAttribute('data-shop-buy'))));
        root.querySelectorAll('[data-shop-equip]').forEach((b) =>
            b.addEventListener('click', () => equip(b.getAttribute('data-slot'), b.getAttribute('data-shop-equip'))));
        root.querySelectorAll('[data-shop-unequip]').forEach((b) =>
            b.addEventListener('click', () => equip(b.getAttribute('data-shop-unequip'), null)));
        root.querySelectorAll('[data-shop-preview]').forEach((b) =>
            b.addEventListener('click', () => {
                const item = (_data.items || []).find((i) => i.id === b.getAttribute('data-shop-preview'));
                if (item) previewTheme(item);
            }));
    }

    async function refresh() { await load(); render(); }

    window.v3Shop = { refresh };

    function boot() {
        render();
        if (sm && typeof sm.on === 'function') {
            sm.on('screen:changed', (e) => {
                const id = e && e.detail && e.detail.id;
                if (id === SCREEN_ID) refresh();
                else stopPreview();   // leaving the shop restores the equipped look
            });
            sm.on('progression:db-changed', () => {
                if (document.getElementById(SCREEN_ID)?.classList.contains('active')) refresh();
            });
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
