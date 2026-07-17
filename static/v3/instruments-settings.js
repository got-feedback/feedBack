// Instruments settings tab — renders collapsible instrument cards from
// GET /api/instruments, with editable custom tunings and arrangement patterns.
// User overrides are persisted to config.json via POST /api/settings under
// the "instrument_overrides" key so they survive restarts.
(function () {
    'use strict';

    var PANEL_ID = 'instruments-settings-panel';
    var OVERRIDES_KEY = 'instrument_overrides';
    var _overrides = {};
    var _instruments = [];
    var _vizPlugins = [];
    var _saveTimer = 0;
    var _openCards = {};  // instId -> bool, survives re-renders

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    function midiToNote(midi) {
        var notes = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
        return notes[((midi % 12) + 12) % 12] + Math.floor(midi / 12 - 1);
    }

    function getOverrides(instId) {
        if (!_overrides[instId]) _overrides[instId] = {};
        return _overrides[instId];
    }

    function saveOverridesDebounced() {
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(function () {
            var patch = {};
            patch[OVERRIDES_KEY] = _overrides;
            fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            }).catch(function () {});
        }, 300);
    }

    function renderInstruments() {
        var panel = document.getElementById(PANEL_ID);
        if (!panel) return;

        if (!_instruments.length) {
            panel.innerHTML = '<div class="fb-srow"><span class="fb-srow-icon">' +
                '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"></path></svg></span>' +
                '<div class="fb-srow-main"><div class="fb-srow-title">No instruments installed</div>' +
                '<div class="fb-srow-desc">Visit the <a href="/plugins" class="text-fb-primary underline">Plugins page</a> to install instrument plugins.</div></div></div>';
            return;
        }

        var html = '';
        for (var i = 0; i < _instruments.length; i++) {
            var inst = _instruments[i];
            var over = getOverrides(inst.id);
            var id = 'inst-card-' + inst.id;
            var isStringed = inst.kind === 'stringed';
            var isOpen = !!_openCards[inst.id];

            html += '<div class="fb-srow fb-srow-stack">' +
                '<div class="flex items-center justify-between cursor-pointer select-none' + (isOpen ? ' mb-3' : '') + '" data-inst-toggle="' + esc(inst.id) + '">' +
                '<div class="flex items-center gap-3">' +
                '<span class="text-lg font-semibold text-fb-text">' + esc(inst.label) + '</span>' +
                '<span class="bg-gray-700/50 text-[0.625rem] uppercase tracking-wider text-fb-textDim px-2 py-0.5 rounded-full">' + esc(inst.kind) + '</span>' +
                (inst.detect_strategy !== 'none' ? '<span class="bg-gray-700/50 text-[0.625rem] uppercase tracking-wider text-fb-textDim px-2 py-0.5 rounded-full">' + esc(inst.detect_strategy) + '</span>' : '') +
                '</div>' +
                '<svg class="w-4 h-4 text-fb-textDim transition-transform' + (isOpen ? ' rotate-180' : '') + '" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5"/></svg>' +
                '</div>';

            html += '<div id="' + id + '" class="' + (isOpen ? '' : 'hidden') + ' space-y-4 pl-4 border-l-2 border-fb-border/30">';

            // ── Roles ──────────────────────────────────
            if (inst.roles && inst.roles.length) {
                html += '<div><div class="text-[0.625rem] uppercase tracking-wider text-fb-textDim mb-1.5">Roles</div>' +
                    '<div class="flex flex-wrap gap-1">';
                for (var j = 0; j < inst.roles.length; j++) {
                    var role = inst.roles[j];
                    html += '<span class="text-xs bg-gray-800/50 border border-gray-700 rounded-md px-2 py-0.5 text-fb-text">' +
                        esc(role.label) + (role.default ? ' <span class="text-fb-primary text-[0.625rem]">(default)</span>' : '') +
                        '</span>';
                }
                html += '</div></div>';
            }

            // ── Arrangement name patterns (editable) ────
            html += _renderEditableNames(inst, over);

            // ── String counts (stringed, editable) ─────
            if (isStringed) {
                html += _renderEditableStringCounts(inst, over);
            }

            // ── Custom tunings (stringed, editable) ────
            if (isStringed) {
                html += _renderTunings(inst, over);
            }

            // ── Preferred highway ───────────────────────
            html += (_renderHighwaySelectSafe(inst, over));

            // ── Info row ───────────────────────────────
            html += '<div class="text-[0.625rem] text-fb-textDim flex flex-wrap gap-3 pb-2">' +
                '<span>Ref: ' + esc(String(inst.reference_pitch)) + ' Hz</span>' +
                '<span>Detect: ' + esc(inst.detect_strategy) + '</span>' +
                '</div>';

            html += '</div></div>';
        }

        panel.innerHTML = html;
        _wireEvents();
    }

    function _renderEditableNames(inst, over) {
        var allNames = [];
        if (inst.roles) {
            for (var i = 0; i < inst.roles.length; i++) {
                var names = inst.roles[i].arrangement_names || [];
                for (var j = 0; j < names.length; j++) {
                    allNames.push({ name: names[j], role: inst.roles[i].label, source: 'plugin' });
                }
            }
        }
        var customNames = over.custom_arrangement_names || [];
        for (var k = 0; k < customNames.length; k++) {
            allNames.push({ name: customNames[k], role: 'custom', source: 'user' });
        }

        var html = '<div data-section="names" data-inst="' + esc(inst.id) + '">' +
            '<div class="text-[0.625rem] uppercase tracking-wider text-fb-textDim mb-1.5">Arrangement name patterns</div>';

        if (allNames.length) {
            html += '<div class="flex flex-wrap gap-1 mb-2">';
            for (var n = 0; n < allNames.length; n++) {
                var item = allNames[n];
                var removeBtn = item.source === 'user'
                    ? '<button type="button" data-remove-name="' + esc(item.name) + '" data-inst="' + esc(inst.id) + '" class="ml-1 text-red-400 hover:text-red-300 text-[0.625rem]" title="Remove">&times;</button>'
                    : '';
                html += '<span class="text-xs bg-gray-800/50 border ' + (item.source === 'user' ? 'border-green-700/50' : 'border-gray-700') + ' rounded-md px-2 py-0.5">' +
                    esc(item.name) + ' <span class="text-fb-textDim text-[0.625rem]">→ ' + esc(item.role) + '</span>' + removeBtn +
                    '</span>';
            }
            html += '</div>';
        }

        html += '<div class="flex gap-1 items-center">' +
            '<input type="text" data-add-name="' + esc(inst.id) + '" placeholder="Arrangement name (e.g. Solo Guitar)" class="bg-gray-800/50 border border-gray-700 rounded-md px-2 py-1 text-xs text-fb-text outline-none w-48 focus:border-fb-primary">' +
            '<button type="button" data-add-name-btn="' + esc(inst.id) + '" class="bg-fb-primary/20 hover:bg-fb-primary/30 text-fb-primary text-xs px-2 py-1 rounded-md transition">Add</button>' +
            '</div></div>';
        return html;
    }

    function _renderEditableStringCounts(inst, over) {
        var pluginCounts = inst.string_counts || [];
        var customCounts = over.custom_string_counts || [];
        var allCounts = pluginCounts.concat(customCounts.filter(function (c) { return pluginCounts.indexOf(c) < 0; }));

        var html = '<div data-section="string-counts" data-inst="' + esc(inst.id) + '">' +
            '<div class="text-[0.625rem] uppercase tracking-wider text-fb-textDim mb-1.5">String counts</div>' +
            '<div class="flex flex-wrap gap-1 mb-2">';
        for (var i = 0; i < allCounts.length; i++) {
            var isPlugin = pluginCounts.indexOf(allCounts[i]) >= 0;
            var removeBtn = !isPlugin
                ? '<button type="button" data-remove-sc="' + allCounts[i] + '" data-inst="' + esc(inst.id) + '" class="ml-1 text-red-400 hover:text-red-300 text-[0.625rem]" title="Remove">&times;</button>'
                : '';
            html += '<span class="text-xs bg-gray-800/50 border ' + (isPlugin ? 'border-gray-700' : 'border-green-700/50') + ' rounded-md px-2 py-0.5">' +
                allCounts[i] + (allCounts[i] === inst.default_string_count ? ' <span class="text-fb-primary text-[0.625rem]">(default)</span>' : '') + removeBtn +
                '</span>';
        }
        html += '</div>' +
            '<div class="flex gap-1 items-center">' +
            '<input type="number" data-add-sc="' + esc(inst.id) + '" min="1" max="18" placeholder="String count (e.g. 12)" class="bg-gray-800/50 border border-gray-700 rounded-md px-2 py-1 text-xs text-fb-text outline-none w-40 focus:border-fb-primary">' +
            '<button type="button" data-add-sc-btn="' + esc(inst.id) + '" class="bg-fb-primary/20 hover:bg-fb-primary/30 text-fb-primary text-xs px-2 py-1 rounded-md transition">Add</button>' +
            '</div></div>';
        return html;
    }

    function _renderHighwaySelectSafe(inst, over) {
        try { return _renderHighwaySelect(inst, over); } catch (e) { console.error('highway select error', e); return ''; }
    }

    function _renderHighwaySelect(inst, over) {
        if (!_vizPlugins.length) return '';
        var current = over.preferred_highway || '';
        var opts = '<option value="">Auto (match arrangement)</option>';
        for (var v = 0; v < _vizPlugins.length; v++) {
            var vp = _vizPlugins[v];
            opts += '<option value="' + esc(vp.id) + '"' + (vp.id === current ? ' selected' : '') + '>' + esc(vp.name) + '</option>';
        }
        return '<div class="mb-2" data-section="highway" data-inst="' + esc(inst.id) + '">' +
            '<div class="text-[0.625rem] uppercase tracking-wider text-fb-textDim mb-1.5">Preferred highway</div>' +
            '<select data-highway="' + esc(inst.id) + '" class="bg-gray-800/50 border border-gray-700 rounded-md px-2 py-1 text-xs text-fb-text outline-none focus:border-fb-primary w-full">' + opts + '</select></div>';
    }

    function _renderTunings(inst, over) {
        var html = '<div data-section="tunings" data-inst="' + esc(inst.id) + '">' +
            '<div class="text-[0.625rem] uppercase tracking-wider text-fb-textDim mb-1.5">Tuning presets</div>';

        var scKeys = Object.keys(inst.tunings || {}).sort(function (a, b) { return Number(a) - Number(b); });
        var customTunings = over.custom_tunings || {};

        for (var ti = 0; ti < scKeys.length; ti++) {
            var scKey = scKeys[ti];
            var scNum = Number(scKey);
            var presetNames = Object.keys(inst.tunings[scKey] || {}).sort();
            var customNames = Object.keys(customTunings[scKey] || {});

            html += '<div class="mb-2">' +
                '<span class="text-xs font-semibold text-fb-text">' + esc(scKey) + '-string</span>';

            // Show standard tuning notes
            var stdMidis = inst.standard_tunings && inst.standard_tunings[scKey];
            if (stdMidis && stdMidis.length) {
                var stdNotes = stdMidis.map(function (m) { return midiToNote(m); }).join(' ');
                html += '<div class="text-[0.625rem] text-fb-textDim mt-0.5 ml-1">Standard: ' + esc(stdNotes) + '</div>';
            }

            var allEntries = [];
            for (var n = 0; n < presetNames.length; n++) {
                var offs = inst.tunings[scKey][presetNames[n]];
                allEntries.push({ name: presetNames[n], offsets: offs, source: 'plugin' });
            }
            for (var cn = 0; cn < customNames.length; cn++) {
                allEntries.push({ name: customNames[cn], offsets: customTunings[scKey][customNames[cn]], source: 'user' });
            }

            if (allEntries.length) {
                html += '<div class="flex flex-wrap gap-1 mt-1.5 mb-1 ml-1">';
                for (var a = 0; a < allEntries.length; a++) {
                    var entry = allEntries[a];
                    var std = inst.standard_tunings && inst.standard_tunings[scKey];
                    var midis = [];
                    if (std && entry.offsets && std.length === entry.offsets.length) {
                        for (var oi = 0; oi < entry.offsets.length; oi++) {
                            midis.push(std[oi] + entry.offsets[oi]);
                            }
                        }
                    }
                    var noteLabel = midis.length ? midis.map(function (m) { return midiToNote(m); }).join(' ') : '';
                    var offStr = entry.offsets ? entry.offsets.map(function (o) { return (o >= 0 ? '+' : '') + o; }).join(',') : '';
                    var removeBtn = entry.source === 'user'
                        ? '<button type="button" data-remove-tuning="' + esc(entry.name) + '" data-sc="' + esc(scKey) + '" data-inst="' + esc(inst.id) + '" class="ml-1 text-red-400 hover:text-red-300 text-[0.625rem]" title="Remove">&times;</button>'
                        : '';
                    html += '<span class="text-[0.625rem] bg-gray-800/50 border ' + (entry.source === 'user' ? 'border-green-700/50' : 'border-gray-700') +
                        ' rounded-md px-1.5 py-0.5 text-fb-textDim font-mono" title="' + esc(noteLabel) + '">' +
                        esc(entry.name) + ': [' + esc(offStr) + ']' + removeBtn +
                        '</span>';
                }
                html += '</div>';
            }

            // Add custom tuning form
            html += '<div class="flex flex-wrap gap-1 items-center mt-0.5">' +
                '<input type="text" data-add-tuning-name="' + esc(inst.id) + '" data-sc="' + esc(scKey) + '" placeholder="Tuning name" class="bg-gray-800/50 border border-gray-700 rounded-md px-1.5 py-0.5 text-[0.625rem] text-fb-text outline-none w-28 focus:border-fb-primary">' +
                '<input type="text" data-add-tuning-offsets="' + esc(inst.id) + '" data-sc="' + esc(scKey) + '" placeholder="Offsets e.g. 0,0,0,0,0,0" class="bg-gray-800/50 border border-gray-700 rounded-md px-1.5 py-0.5 text-[0.625rem] text-fb-text outline-none w-44 focus:border-fb-primary font-mono">' +
                '<button type="button" data-add-tuning-btn="' + esc(inst.id) + '" data-sc="' + esc(scKey) + '" class="bg-fb-primary/20 hover:bg-fb-primary/30 text-fb-primary text-[0.625rem] px-1.5 py-0.5 rounded-md transition">Add</button>' +
                '</div></div>';
        }

        html += '</div>';
        return html;
    }

    function _wireEvents() {
        var panel = document.getElementById(PANEL_ID);
        if (!panel) return;

        // Toggle card open/close
        panel.querySelectorAll('[data-inst-toggle]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var instId = btn.getAttribute('data-inst-toggle');
                _openCards[instId] = !_openCards[instId];
                renderInstruments();
            });
        });

        // Add arrangement name
        panel.querySelectorAll('[data-add-name-btn]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var instId = btn.getAttribute('data-add-name-btn');
                var input = panel.querySelector('[data-add-name="' + instId + '"]');
                if (!input) return;
                var name = input.value.trim();
                if (!name) return;
                var over = getOverrides(instId);
                if (!over.custom_arrangement_names) over.custom_arrangement_names = [];
                if (over.custom_arrangement_names.indexOf(name) < 0) {
                    over.custom_arrangement_names.push(name);
                    saveOverridesDebounced();
                }
                input.value = '';
                renderInstruments();
            });
        });

        // Remove arrangement name
        panel.querySelectorAll('[data-remove-name]').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var instId = btn.getAttribute('data-inst');
                var name = btn.getAttribute('data-remove-name');
                var over = getOverrides(instId);
                if (over.custom_arrangement_names) {
                    over.custom_arrangement_names = over.custom_arrangement_names.filter(function (n) { return n !== name; });
                    saveOverridesDebounced();
                }
                renderInstruments();
            });
        });

        // Add string count
        panel.querySelectorAll('[data-add-sc-btn]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var instId = btn.getAttribute('data-add-sc-btn');
                var input = panel.querySelector('[data-add-sc="' + instId + '"]');
                if (!input) return;
                var sc = parseInt(input.value, 10);
                if (!sc || sc < 1 || sc > 18) return;
                var over = getOverrides(instId);
                if (!over.custom_string_counts) over.custom_string_counts = [];
                if (over.custom_string_counts.indexOf(sc) < 0) {
                    over.custom_string_counts.push(sc);
                    saveOverridesDebounced();
                }
                input.value = '';
                renderInstruments();
            });
        });

        // Remove string count
        panel.querySelectorAll('[data-remove-sc]').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var instId = btn.getAttribute('data-inst');
                var sc = parseInt(btn.getAttribute('data-remove-sc'), 10);
                var over = getOverrides(instId);
                if (over.custom_string_counts) {
                    over.custom_string_counts = over.custom_string_counts.filter(function (c) { return c !== sc; });
                    saveOverridesDebounced();
                }
                renderInstruments();
            });
        });

        // Add tuning
        panel.querySelectorAll('[data-add-tuning-btn]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var instId = btn.getAttribute('data-add-tuning-btn');
                var scKey = btn.getAttribute('data-sc');
                var nameInput = panel.querySelector('[data-add-tuning-name="' + instId + '"][data-sc="' + scKey + '"]');
                var offInput = panel.querySelector('[data-add-tuning-offsets="' + instId + '"][data-sc="' + scKey + '"]');
                if (!nameInput || !offInput) return;
                var name = nameInput.value.trim();
                var offStr = offInput.value.trim();
                if (!name || !offStr) return;

                var parts = offStr.split(/[,\s]+/).map(Number);
                if (parts.some(function (p) { return !Number.isFinite(p) || p < -12 || p > 12; })) return;

                var over = getOverrides(instId);
                if (!over.custom_tunings) over.custom_tunings = {};
                if (!over.custom_tunings[scKey]) over.custom_tunings[scKey] = {};
                over.custom_tunings[scKey][name] = parts;
                saveOverridesDebounced();

                nameInput.value = '';
                offInput.value = '';
                renderInstruments();
            });
        });

        // Remove tuning
        panel.querySelectorAll('[data-remove-tuning]').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var instId = btn.getAttribute('data-inst');
                var scKey = btn.getAttribute('data-sc');
                var name = btn.getAttribute('data-remove-tuning');
                var over = getOverrides(instId);
                if (over.custom_tunings && over.custom_tunings[scKey]) {
                    delete over.custom_tunings[scKey][name];
                    saveOverridesDebounced();
                }
                renderInstruments();
            });
        });
        // Preferred highway
        panel.querySelectorAll('[data-highway]').forEach(function (sel) {
            sel.addEventListener('change', function () {
                var instId = sel.getAttribute('data-highway');
                var over = getOverrides(instId);
                var val = sel.value;
                if (val) {
                    over.preferred_highway = val;
                } else {
                    delete over.preferred_highway;
                }
                saveOverridesDebounced();
                renderInstruments();
            });
        });
    }

    async function load() {
        console.log('instruments-settings: load() started');
        try {
            var r = await fetch('/api/instruments');
            if (r.ok) _instruments = await r.json();
            console.log('instruments-settings: instruments loaded, count=' + _instruments.length);
        } catch (e) { console.error('instruments-settings: instruments failed', e); }

        console.log('instruments-settings: loading plugins...');
        try {
            var pr = await fetch('/api/plugins');
            if (pr.ok) {
                var plugins = await pr.json();
                console.log('instruments-settings: plugins loaded, count=' + (Array.isArray(plugins) ? plugins.length : 'not array'));
                if (Array.isArray(plugins)) {
                    _vizPlugins = plugins.filter(function (p) { return p.type === 'visualization'; });
                    console.log('instruments-settings: viz plugins count=' + _vizPlugins.length);
                }
            } else {
                console.error('instruments-settings: plugins fetch not ok ' + pr.status);
            }
        } catch (e) { console.error('instruments-settings: plugins failed', e); }

        console.log('instruments-settings: loading settings...');
        try {
            var sr = await fetch('/api/settings');
            if (sr.ok) {
                var s = await sr.json();
                if (s[OVERRIDES_KEY] && typeof s[OVERRIDES_KEY] === 'object') {
                    _overrides = s[OVERRIDES_KEY];
                }
                console.log('instruments-settings: settings loaded');
            }
        } catch (e) { console.error('instruments-settings: settings failed', e); }

        console.log('instruments-settings: calling renderInstruments()');
        try {
            renderInstruments();
            console.log('instruments-settings: renderInstruments() done');
        } catch (e) { console.error('instruments-settings: renderInstruments() crashed', e); }
    }

    // Sync test: update the panel IMMEDIATELY at script load time so we can
    // distinguish "script not loaded" from "async fetch failed".
    (function () {
        var panel = document.getElementById(PANEL_ID);
        if (panel) panel.innerHTML = '<div class="text-fb-textDim text-sm px-1">Fetching data…</div>';
    })();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', load);
    } else {
        load();
    }
})();
