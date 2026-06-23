/*
 * fee[dB]ack v0.3.0 — Audio-routing status widget (dashboard stat card).
 *
 * Flagship capability-pipeline consumer (design/05): reads the audio session
 * purely through the capability runtime —
 *   audio-mix      inspect      → { state, faders, requiredKinds, route, analyser }
 *   audio-input    list-sources → { sources: [...] }
 *   audio-monitoring inspect    → { sessions, totalSessions }
 * — and never touches static/audio-mixer.js internals or plugins/nam_tone
 * routes directly. "Not Connected" is the honest default in the browser
 * (no native engine ⇒ no available route). Degrades on no-owner/no-handler/
 * failed and when capabilities are absent.
 */
(function () {
    'use strict';
    const sm = window.feedBack;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const OK = new Set(['handled', 'passed', 'transformed', 'degraded']);
    async function cmd(domain, name, args) {
        try {
            const caps = sm && sm.capabilities;
            if (!caps || typeof caps.command !== 'function') return null;
            const r = await caps.command(domain, name, args || {});
            // no-owner / no-handler / unsupported-command / incompatible-version
            // / failed → treat as "feature absent".
            return r && OK.has(r.outcome) ? (r.payload || {}) : null;
        } catch (e) { return null; }
    }

    async function readStatus() {
        const [mix, srcs, mon] = await Promise.all([
            cmd('audio-mix', 'inspect'),
            cmd('audio-input', 'list-sources'),
            cmd('audio-monitoring', 'inspect'),
        ]);
        const sources = (srcs && Array.isArray(srcs.sources)) ? srcs.sources : [];
        const selected = sources.find((s) => s && s.selected) || null;
        const inputAvailable = !!(selected && selected.availability === 'available');
        const route = mix && mix.route;
        const routeActive = !!(route && route.availability === 'available');
        const plugins = (mix && Array.isArray(mix.faders)) ? mix.faders.filter((f) => f && f.kind === 'plugin') : [];
        const effectActive = plugins.length > 0 || !!(mix && mix.requiredKinds && mix.requiredKinds.plugin);
        const monitoring = !!(mon && mon.totalSessions > 0);

        // Connected = a native engine is actually routing audio. In the browser
        // there is no route, so this is false (the honest default).
        const connected = routeActive;
        const inputLabel = selected ? (selected.label || 'Input') : null;
        const effectLabel = plugins.length ? (plugins[0].label || plugins[0].ownerPluginId || 'VST/NAM/IR') : null;
        const outputLabel = route ? (route.label || route.routeKind || null) : null;
        return { connected, inputAvailable, effectActive, routeActive, monitoring, inputLabel, effectLabel, outputLabel };
    }

    function dot(on, color) {
        return '<span class="w-2.5 h-2.5 rounded-full ' + (on ? (color || 'bg-cyan-400') : 'bg-gray-600') + '"></span>';
    }

    async function render(container) {
        container = container || document.getElementById('v3-audio-routing');
        if (!container) return;
        const st = await readStatus();
        const statusLine = st.connected
            ? '<span class="text-cyan-300">Connected</span>' +
              (st.effectLabel ? ' <span class="text-fb-textDim">· ' + esc(st.effectLabel) + '</span>' : '')
            : '<span class="text-fb-textDim">Not Connected</span>';
        container.className = 'bg-fb-card/80 backdrop-blur rounded-lg p-4 border border-fb-border/50 ' +
            (st.connected ? 'ring-1 ring-cyan-500/30' : '');
        container.innerHTML =
            '<div class="flex items-center gap-2 text-xs text-fb-textDim mb-3">' +
            '<svg class="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 18V5l12-2v13M9 13l12-2"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>' +
            '<span>Audio Routing</span></div>' +
            '<div class="flex items-center gap-2 text-[11px] text-fb-textDim">' +
            dot(st.inputAvailable) + '<span>Input</span>' +
            '<span class="flex-1 border-t border-dashed border-fb-border/70"></span>' +
            dot(st.effectActive) + '<span>VST/NAM/IR</span>' +
            '<span class="flex-1 border-t border-dashed border-fb-border/70"></span>' +
            dot(st.routeActive) + '<span>Output</span></div>' +
            '<div class="mt-2 text-sm font-medium">' + statusLine + '</div>';
    }

    window.v3AudioRouting = { render: render, readStatus: readStatus };

    // Refresh on relevant changes (light; no continuous polling). The dashboard
    // also calls render() each time Home is shown.
    if (sm && typeof sm.on === 'function') {
        sm.on('instrument:changed', () => render());
        sm.on('song:play', () => render());
        sm.on('song:stop', () => render());
    }
    // NOTE: do NOT subscribe to the capability '*' wildcard to auto-refresh.
    // render() -> readStatus() issues three capability commands (audio-mix
    // inspect, audio-input list-sources, audio-monitoring inspect), and the
    // runtime fans every resulting event out to '*' subscribers
    // (capabilities.js _notifySubscribers). A '*' handler that calls render()
    // therefore re-triggers itself through its own commands' events — an
    // exponential render/command storm that exhausts the V8 heap (OOM) within
    // ~0.5s of load and freezes the renderer. The explicit instrument/song
    // handlers above, plus the dashboard calling render() each time Home is
    // shown, are sufficient to keep this status card current.
})();
