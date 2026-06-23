// FeedBack diagnostics — client console capture + hardware probe + contribute API.
//
// Loaded ASAP from index.html so the console-wrap is in place before
// app.js (and any plugins) start logging. See
// docs/diagnostics-bundle-spec.md for the wire format.
(function () {
    'use strict';

    if (window.feedBack && window.feedBack.diagnostics) return; // idempotent

    const MAX_ENTRIES = 500;
    const MAX_ENTRY_BYTES = 4096;
    const MAX_BUFFER_BYTES = 256 * 1024; // ~250 KB hard cap on total buffer size
    const buffer = [];
    const _bufferSizes = []; // parallel array — serialized byte length per entry
    let _bufferBytes = 0;
    const contributions = {};

    function _ua() {
        return (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    }

    function _screen() {
        if (typeof screen === 'undefined') return null;
        return {
            width: screen.width,
            height: screen.height,
            devicePixelRatio: window.devicePixelRatio || 1,
            colorDepth: screen.colorDepth,
        };
    }

    // Bounded JSON.stringify replacer: drops circular refs, truncates
    // long strings, caps depth so a `console.log(highway.bundle)` with
    // a 50k-note arrangement doesn't blow up the buffer.
    function _safeStringify(value) {
        const seen = new WeakSet();
        const MAX_DEPTH = 4;
        function repl(_key, val, depth) {
            if (val === null || typeof val !== 'object') {
                if (typeof val === 'string' && val.length > 1024) {
                    return val.slice(0, 1024) + '…[truncated]';
                }
                return val;
            }
            if (seen.has(val)) return '[circular]';
            seen.add(val);
            if (depth >= MAX_DEPTH) return Array.isArray(val) ? '[array]' : '[object]';
            if (Array.isArray(val)) {
                return val.slice(0, 50).map((v, i) => repl(i, v, depth + 1));
            }
            const out = {};
            let n = 0;
            for (const k of Object.keys(val)) {
                if (n++ > 30) { out['…'] = '[truncated keys]'; break; }
                try { out[k] = repl(k, val[k], depth + 1); }
                catch (e) { out[k] = '[unserializable]'; }
            }
            return out;
        }
        try {
            const result = repl('', value, 0);
            const s = JSON.stringify(result);
            return s && s.length > MAX_ENTRY_BYTES
                ? s.slice(0, MAX_ENTRY_BYTES) + '…[truncated]'
                : s;
        } catch (_e) {
            return '[unserializable]';
        }
    }

    function _push(entry) {
        try {
            entry.t = Date.now();
            entry.ua = _ua();
            entry.screen = _screen();
            // Measure the serialized size of this entry so we can enforce
            // the total byte cap. Store in the parallel _bufferSizes array
            // rather than on the entry object so the size field is never
            // sent in the export payload.
            let approx;
            try { approx = JSON.stringify(entry).length; } catch (_e) { approx = MAX_ENTRY_BYTES; }
            // A single entry that is larger than the whole budget is discarded
            // immediately — the eviction loop can only drain the buffer to empty
            // but cannot shrink the entry itself.
            if (approx > MAX_BUFFER_BYTES) return;
            // Evict oldest entries until the new entry fits within the byte budget.
            while (buffer.length > 0 && _bufferBytes + approx > MAX_BUFFER_BYTES) {
                _bufferBytes -= _bufferSizes.shift() || 0;
                buffer.shift();
            }
            buffer.push(entry);
            _bufferSizes.push(approx);
            _bufferBytes += approx;
            // Also enforce the entry-count cap.
            if (buffer.length > MAX_ENTRIES) {
                _bufferBytes -= _bufferSizes.shift() || 0;
                buffer.shift();
            }
        } catch (_e) {
            // Never let diagnostics capture itself break the page.
        }
    }

    function _formatArgs(args) {
        const out = [];
        let firstStr = '';
        for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (typeof a === 'string') {
                if (!firstStr) firstStr = a;
                out.push(a.length > 1024 ? a.slice(0, 1024) + '…[truncated]' : a);
            } else if (a instanceof Error) {
                out.push({ name: a.name, message: a.message, stack: a.stack });
                if (!firstStr) firstStr = a.message || a.name || 'Error';
            } else {
                out.push(_safeStringify(a));
                if (!firstStr) firstStr = String(a).slice(0, 200);
            }
        }
        return { msg: firstStr || '', args: out };
    }

    // Wrap all console levels. We push BEFORE delegating so a console
    // method that throws (rare, but happens with custom shims) still
    // leaves the entry in our buffer.
    const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
    for (const level of LEVELS) {
        const original = console[level] ? console[level].bind(console) : null;
        console[level] = function () {
            const args = Array.prototype.slice.call(arguments);
            const formatted = _formatArgs(args);
            _push({ kind: 'console', level, msg: formatted.msg, args: formatted.args });
            if (original) original.apply(console, args);
        };
    }

    window.addEventListener('error', function (e) {
        _push({
            kind: 'error',
            level: 'error',
            msg: (e && (e.message || (e.error && e.error.message))) || 'unknown error',
            stack: e && e.error && e.error.stack ? String(e.error.stack) : null,
            url: e && e.filename || null,
            line: e && e.lineno || null,
            col: e && e.colno || null,
        });
    });

    window.addEventListener('unhandledrejection', function (e) {
        const reason = e && e.reason;
        const msg = reason instanceof Error ? reason.message : (typeof reason === 'string' ? reason : _safeStringify(reason));
        _push({
            kind: 'rejection',
            level: 'error',
            msg: msg || 'unhandled rejection',
            stack: reason && reason.stack ? String(reason.stack) : null,
        });
    });

    // ── Hardware probe ─────────────────────────────────────────────
    function _detectRuntime() {
        const ua = _ua();
        if (/Electron\//.test(ua)) {
            const versions = (window.feedBackElectron && window.feedBackElectron.versions) || {};
            return {
                kind: 'electron',
                electron: versions.electron || null,
                chrome: versions.chrome || null,
                node: versions.node || null,
                v8: versions.v8 || null,
                app_version: (window.feedBackElectron && window.feedBackElectron.appVersion) || null,
            };
        }
        return { kind: 'browser' };
    }

    function _probeWebGL() {
        try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
            if (!gl) return { available: false, redacted: false };
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            let vendor = null, renderer = null, redacted = false;
            if (dbg) {
                vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
                renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
            } else {
                vendor = gl.getParameter(gl.VENDOR);
                renderer = gl.getParameter(gl.RENDERER);
                redacted = true; // no debug-info extension = privacy mode / Safari
            }
            // Firefox + Safari sometimes return generic strings even
            // with the extension — flag those too.
            if (renderer === 'Mozilla' || renderer === 'WebKit') redacted = true;
            return {
                available: true,
                vendor,
                renderer,
                version: gl.getParameter(gl.VERSION),
                shading_language_version: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
                max_texture_size: gl.getParameter(gl.MAX_TEXTURE_SIZE),
                redacted,
            };
        } catch (e) {
            return { available: false, error: String(e) };
        }
    }

    async function _probeWebGPU() {
        if (typeof navigator === 'undefined' || !navigator.gpu) {
            return { available: false };
        }
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) return { available: false };
            // adapter.info is the modern surface; older Chrome only has
            // requestAdapterInfo(). Try both.
            let info = adapter.info;
            if (!info && typeof adapter.requestAdapterInfo === 'function') {
                info = await adapter.requestAdapterInfo();
            }
            return {
                available: true,
                adapter_info: info ? {
                    vendor: info.vendor || null,
                    architecture: info.architecture || null,
                    device: info.device || null,
                    description: info.description || null,
                } : null,
            };
        } catch (e) {
            return { available: false, error: String(e) };
        }
    }

    async function _probeUserAgentData() {
        const uad = navigator.userAgentData;
        if (!uad) return null;
        try {
            return await uad.getHighEntropyValues([
                'platform', 'platformVersion', 'architecture', 'model', 'bitness',
            ]);
        } catch (_e) {
            return { platform: uad.platform || null };
        }
    }

    async function snapshotHardware() {
        const out = {
            schema: 'client.hardware.v1',
            runtime: _detectRuntime(),
            navigator: {
                userAgent: _ua(),
                platform: (navigator.platform || null),
                hardwareConcurrency: navigator.hardwareConcurrency || null,
                deviceMemory: navigator.deviceMemory || null,
                languages: Array.from(navigator.languages || []),
            },
            userAgentData: await _probeUserAgentData(),
            screen: _screen(),
            webgl: _probeWebGL(),
            webgpu: await _probeWebGPU(),
        };
        return out;
    }

    function snapshotConsole() {
        // Deep-copy each entry so server-side redaction (which mutates
        // entry fields in place) cannot corrupt the live ring buffer
        // through shared object references.
        return buffer.map(e => ({ ...e }));
    }

    function snapshotUa() {
        return {
            userAgent: _ua(),
            url: location && location.href,
            screen: _screen(),
        };
    }

    // Regexp matching localStorage key names that are likely to contain
    // secrets. Values for matching keys are replaced with "<redacted>"
    // regardless of the user's redaction toggle, since plugin authors
    // commonly store tokens in localStorage (cf. feedBack plugin guide).
    const _LS_SECRET_KEY_RE = /(?:^|[-_.])(api[_-]?key|token|secret|password|passwd|pwd|auth|bearer|credential|apikey)($|[-_.])/i;

    function snapshotLocalStorage() {
        const out = {};
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k === null) continue;
                const v = localStorage.getItem(k);
                if (v !== null) out[k] = _LS_SECRET_KEY_RE.test(k) ? '<redacted>' : v;
            }
        } catch (_e) {
            // private mode / quota — return whatever we got.
        }
        return out;
    }

    function contribute(pluginId, payload) {
        if (typeof pluginId !== 'string' || !pluginId) return;
        contributions[pluginId] = payload;
    }

    function snapshotContributions() {
        return Object.assign({}, contributions);
    }


    // Count the actual UI contribution entries a plugin declares. The
    // normalized shape from the backend is { declared: {region: [...]},
    // legacy: [...] } — counting top-level keys there would always return 2
    // (declared + legacy) regardless of how many contributions exist, which
    // made the diagnostics summary meaningless. Sum the declared region
    // entries (each value is a contribution list) plus the legacy entries,
    // and fall back to a flat region→contributions map for older shapes.
    function _countUiContributions(ui) {
        if (!ui || typeof ui !== 'object') return 0;
        const declared = ui.declared && typeof ui.declared === 'object' ? ui.declared : null;
        const legacy = Array.isArray(ui.legacy) ? ui.legacy : null;
        if (declared || legacy) {
            let count = legacy ? legacy.length : 0;
            if (declared) {
                // Region values are contribution lists; count only arrays so a
                // malformed (non-array) value doesn't inflate the total.
                for (const value of Object.values(declared)) {
                    if (Array.isArray(value)) count += value.length;
                }
            }
            return count;
        }
        let count = 0;
        for (const value of Object.values(ui)) {
            if (Array.isArray(value)) count += value.length;
        }
        return count;
    }

    function summarizeRuntimeDomains(snapshot) {
        const plugins = snapshot && Array.isArray(snapshot.plugins) ? snapshot.plugins : [];
        return plugins.reduce((summary, plugin) => {
            const ui = plugin && plugin.ui_contributions && typeof plugin.ui_contributions === 'object'
                ? _countUiContributions(plugin.ui_contributions) : 0;
            const domains = plugin && plugin.runtime_domains && typeof plugin.runtime_domains === 'object'
                ? Object.keys(plugin.runtime_domains).length : 0;
            return {
                plugin_count: summary.plugin_count + 1,
                ui_contribution_count: summary.ui_contribution_count + ui,
                runtime_domain_count: summary.runtime_domain_count + domains,
            };
        }, { plugin_count: 0, ui_contribution_count: 0, runtime_domain_count: 0 });
    }

    window.feedBack = window.feedBack || {};
    window.feedBack.diagnostics = {
        snapshot: snapshotConsole,
        snapshotConsole,
        snapshotHardware,
        snapshotUa,
        snapshotLocalStorage,
        snapshotContributions,
        summarizeRuntimeDomains,
        contribute,
    };
})();
