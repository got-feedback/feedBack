(function () {
    'use strict';

    const state = window.__feedBackCapabilityInspector || (window.__feedBackCapabilityInspector = {});
    state.render = render;
    if (state.installed) return;
    state.installed = true;
    const DOCUMENTATION_ONLY_DOMAINS = new Set([
        'backend.routes',
        'ui.player-controls',
        'ui.player-panels',
        'ui.player-overlays',
        'plugins',
        'jobs',
        'midi-control',
        'tempo-clock',
    ]);
    const DOMAIN_GROUPS = Object.freeze([
        Object.freeze({
            id: 'app-library',
            label: 'Application and Library',
            summary: 'Navigation, plugin screens, settings, library sources, and tunings.',
            domains: Object.freeze(['ui.navigation', 'ui.plugin-screens', 'settings', 'library', 'tuning']),
        }),
        Object.freeze({
            id: 'player-audio',
            label: 'Player and Audio Runtime',
            summary: 'Playback, renderer, chart-transform, mixer, monitoring, effects, and note-detection surfaces.',
            domains: Object.freeze(['playback', 'visualization', 'chart-transform', 'audio-mix', 'audio-input', 'audio-monitoring', 'audio-effects', 'stems', 'note-detection']),
        }),
        Object.freeze({
            id: 'plugin-defined',
            label: 'Plugin-defined Domains',
            summary: 'Domains declared by installed plugins outside the current core surface list.',
            domains: Object.freeze([]),
        }),
        Object.freeze({
            id: 'capability-runtime',
            label: 'Capability Runtime',
            summary: 'Diagnostics snapshots plus capability graph operations used by the inspector.',
            domains: Object.freeze(['diagnostics', 'pipeline']),
        }),
    ]);
    const DOMAIN_ICONS = Object.freeze({
        library: 'bookOpen',
        playback: 'playCircle',
        visualization: 'monitor',
        'audio-mix': 'sliders',
        'audio-effects': 'box',
        'audio-monitoring': 'headphones',
        stems: 'sliders',
        'note-detection': 'activity',
        'chart-transform': 'box',
        diagnostics: 'fileSearch',
        pipeline: 'activity',
        'ui.navigation': 'list',
        'ui.plugin-screens': 'monitor',
        settings: 'sliders',
        'backend.routes': 'network',
        'ui.player-controls': 'sliders',
        'ui.player-panels': 'monitor',
        'ui.player-overlays': 'monitor',
        plugins: 'puzzle',
        jobs: 'history',
        'midi-control': 'sliders',
        'audio-input': 'plug',
        'tempo-clock': 'history',
    });
    const ICON_PATHS = Object.freeze({
        activity: '<path d="M22 12h-4l-3 7L9 5l-3 7H2"/>',
        alert: '<path d="M12 3 2 21h20L12 3z"/><path d="M12 9v5"/><path d="M12 17h.01"/>',
        bookOpen: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
        box: '<path d="m21 8-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
        chevronDown: '<path d="m6 9 6 6 6-6"/>',
        chevronRight: '<path d="m9 6 6 6-6 6"/>',
        circleOff: '<circle cx="12" cy="12" r="9"/><path d="m5 5 14 14"/>',
        coreCube: '<path d="M12 2.8 21 8.1v8.8L12 22l-9-5.1V8.1L12 2.8z"/><path d="M3 8.1 9 11.7"/><path d="M15 11.7 21 8.1"/><path d="M12 15.6V22"/><circle cx="12" cy="12.2" r="3.4"/>',
        crown: '<path d="M2 6l5 5 5-8 5 8 5-5-2 13H4L2 6z"/><path d="M4 19h16"/>',
        eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
        fileSearch: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><circle cx="11.5" cy="14.5" r="2.5"/><path d="m13.3 16.3 2.2 2.2"/>',
        flag: '<path d="M5 22V4"/><path d="M5 4h11l-1 5 1 5H5"/>',
        headphones: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
        history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/><path d="M12 7v5l3 2"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7h.01"/>',
        list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
        lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
        monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
        network: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><path d="m8.5 8.5 2 6"/><path d="m15.5 8.5-2 6"/>',
        playCircle: '<circle cx="12" cy="12" r="10"/><path d="m10 8 6 4-6 4V8z"/>',
        plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M6 8h12v4a6 6 0 0 1-12 0V8z"/>',
        puzzle: '<path d="M8 3h3a2 2 0 0 1 2 2v1.2a1.4 1.4 0 1 0 2 0V5a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2v4h-1.2a1.4 1.4 0 1 0 0 2H20v4a2 2 0 0 1-2 2h-3v1.2a1.4 1.4 0 1 1-2 0V17H8a2 2 0 0 1-2-2v-3H4.8a1.4 1.4 0 1 1 0-2H6V5a2 2 0 0 1 2-2z"/>',
        send: '<path d="m22 2-7 20-4-9-9-4 20-7z"/><path d="M22 2 11 13"/>',
        shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
        shieldAlert: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v5"/><path d="M12 16h.01"/>',
        sliders: '<path d="M4 6h10"/><path d="M18 6h2"/><path d="M4 12h4"/><path d="M12 12h8"/><path d="M4 18h12"/><path d="M5 6a2 2 0 1 0 4 0 2 2 0 0 0-4 0z"/><path d="M8 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0z"/><path d="M16 18a2 2 0 1 0 4 0 2 2 0 0 0-4 0z"/>',
        users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    });
    const COMMAND_ICON = '<span data-legend-icon="command" class="inline-block h-3 w-3 rounded bg-orange-400 shadow-[0_0_12px_rgba(251,146,60,0.55)]" aria-hidden="true"></span>';
    const OPERATION_ICON = '<span data-legend-icon="operation" class="inline-block h-3 w-3 rounded bg-purple-400 shadow-[0_0_12px_rgba(192,132,252,0.55)]" aria-hidden="true"></span>';
    const EVENT_ICON = '<span data-legend-icon="event" class="inline-block h-3 w-3 rotate-45 rounded-sm bg-blue-400 shadow-[0_0_12px_rgba(96,165,250,0.55)]" aria-hidden="true"></span>';
    const PROVIDER_COMMAND_LINK = '<span data-legend-line="provider-command" class="inline-flex h-px w-8 bg-purple-400"></span>';
    const PROVIDER_OPERATION_LINK = '<span data-legend-line="provider-operation" class="inline-flex h-px w-8 bg-purple-300"></span>';
    const PROVIDER_EVENT_LINK = '<span data-legend-line="provider-event" class="inline-flex h-px w-8 bg-violet-200"></span>';
    const GRAPH_FILTERS = new Set(['all', 'commands', 'operations', 'events', 'shimmed']);
    const LEGACY_SURFACE_ENDPOINTS = Object.freeze({
        library: Object.freeze({
            refresh: Object.freeze({ type: 'command', label: 'refresh' }),
            select: Object.freeze({ type: 'command', label: 'select' }),
            'sync-song': Object.freeze({ type: 'command', label: 'sync-song' }),
        }),
    });
    const ATTRIBUTION_ONLY_SHIMS = Object.freeze({
        library: new Set(['register_library_provider']),
    });
    const CYTOSCAPE_URL = '/static/vendor/cytoscape/cytoscape.min.js';
    let cytoscapePromise = null;
    let activeGraph = null;
    let activeGraphs = new Map();
    let renderScheduled = false;

    function text(value) {
        return String(value == null ? '' : value).replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
    }

    function attr(value) {
        return text(value).replace(/["']/g, ch => ({ '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function registry() {
        return window.feedBack && window.feedBack.capabilities;
    }

    function snapshot() {
        const api = registry();
        if (!api || typeof api.snapshotDiagnostics !== 'function') return null;
        try { return api.snapshotDiagnostics(); }
        catch (err) { return { error: err && err.message ? err.message : String(err) }; }
    }

    function chips(values, className) {
        const list = Array.isArray(values) ? values : [];
        return list.map(item => `<span class="${className || 'bg-dark-700 text-gray-300'} px-2 py-1 rounded text-xs leading-none">${text(item)}</span>`).join('');
    }

    function pill(label, tone = 'muted') {
        const classes = {
            clean: 'bg-emerald-500/10 text-emerald-300 border-emerald-700/60',
            observed: 'bg-teal-500/10 text-teal-300 border-teal-700/60',
            used: 'bg-gold/10 text-gold border-gold/50',
            warning: 'bg-amber-500/10 text-amber-300 border-amber-700/60',
            conflict: 'bg-red-500/10 text-red-300 border-red-800/70',
            muted: 'bg-dark-700 text-gray-400 border-gray-800',
            info: 'bg-accent/10 text-accent-light border-accent/40',
        };
        return `<span class="inline-flex items-center rounded border px-2 py-1 text-xs leading-none ${classes[tone] || classes.muted}">${text(label)}</span>`;
    }

    function iconSvg(name, className = 'h-4 w-4') {
        const path = ICON_PATHS[name] || ICON_PATHS.info;
        return `<svg class="${attr(className)}" aria-hidden="true" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewBox="0 0 24 24">${path}</svg>`;
    }

    function iconBadge(iconName, label, tooltip, tone = 'muted') {
        const classes = {
            clean: 'bg-emerald-500/10 text-emerald-300 border-emerald-700/60',
            observed: 'bg-teal-500/10 text-teal-300 border-teal-700/60',
            used: 'bg-gold/10 text-gold border-gold/50',
            warning: 'bg-amber-500/10 text-amber-300 border-amber-700/60',
            conflict: 'bg-red-500/10 text-red-300 border-red-800/70',
            muted: 'bg-dark-700 text-gray-400 border-gray-800',
            info: 'bg-accent/10 text-accent-light border-accent/40',
        };
        const title = tooltip || label;
        return `<span class="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs leading-none ${classes[tone] || classes.muted}" title="${attr(title)}" aria-label="${attr(title)}" role="img">${iconSvg(iconName)}<span>${text(label)}</span></span>`;
    }

    function compactIconBadge(iconName, value, tooltip, tone = 'muted') {
        const classes = {
            clean: 'bg-emerald-500/10 text-emerald-300 border-emerald-700/60',
            observed: 'bg-teal-500/10 text-teal-300 border-teal-700/60',
            used: 'bg-gold/10 text-gold border-gold/50',
            warning: 'bg-amber-500/10 text-amber-300 border-amber-700/60',
            conflict: 'bg-red-500/10 text-red-300 border-red-800/70',
            muted: 'bg-dark-700 text-gray-400 border-gray-800',
            info: 'bg-accent/10 text-accent-light border-accent/40',
        };
        const hasValue = value !== '' && value != null;
        return `<span class="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs leading-none ${classes[tone] || classes.muted}" title="${attr(tooltip)}" aria-label="${attr(tooltip)}" role="img">${iconSvg(iconName)}${hasValue ? `<span>${text(value)}</span>` : ''}</span>`;
    }

    function availabilityBadge(availability) {
        const value = availability || 'available';
        const tone = value === 'available' ? 'clean' : (value === 'disabled' ? 'muted' : 'warning');
        const icon = value === 'available' ? 'shield' : (value === 'disabled' ? 'circleOff' : 'shieldAlert');
        const classes = {
            clean: 'bg-emerald-500/10 text-emerald-300 border-emerald-700/60',
            warning: 'bg-amber-500/10 text-amber-300 border-amber-700/60',
            muted: 'bg-dark-700 text-gray-400 border-gray-800',
        };
        const title = `Availability: ${value}`;
        return `<span class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border ${classes[tone] || classes.muted}" title="${attr(title)}" aria-label="${attr(title)}" role="img" data-availability-icon="${attr(value)}">${iconSvg(icon, 'h-4 w-4')}</span>`;
    }

    function roleIconBadge(iconName, title, tone = 'muted', role = '') {
        const classes = {
            owner: 'bg-gold/10 text-gold border-gold/50',
            provider: 'bg-accent/10 text-accent-light border-accent/40',
            observer: 'bg-teal-500/10 text-teal-300 border-teal-700/60',
            requester: 'bg-gold/10 text-gold border-gold/50',
            muted: 'bg-dark-700 text-gray-400 border-gray-800',
        };
        return `<span data-role-icon="${attr(role || title)}" class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border ${classes[tone] || classes.muted}" title="${attr(title)}" aria-label="${attr(title)}" role="img">${iconSvg(iconName, 'h-4 w-4')}</span>`;
    }

    function originIconBadge(iconName, title, tone = 'muted', origin = '') {
        const classes = {
            core: 'bg-blue-500/10 text-blue-300 border-blue-700/60',
            external: 'bg-dark-700 text-gray-400 border-gray-800',
            muted: 'bg-dark-700 text-gray-400 border-gray-800',
        };
        return `<span data-origin-icon="${attr(origin || title)}" class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border ${classes[tone] || classes.muted}" title="${attr(title)}" aria-label="${attr(title)}" role="img">${iconSvg(iconName, 'h-4 w-4')}</span>`;
    }

    function participantOriginIcon(participant) {
        const pluginId = participant && participant.pluginId;
        if (!pluginId || pluginId === 'No owner/provider') return '';
        const providerId = participantProviderId(participant);
        const coreOrigin = pluginId === 'core' || String(pluginId).startsWith('core.') || providerId === 'local';
        const roleLabel = hasRole(participant, 'owner')
            ? 'owner'
            : ((providerId || hasRole(participant, 'provider')) ? 'provider' : 'participant');
        const label = `${coreOrigin ? 'Core' : 'Non-core'} ${roleLabel}`;
        return coreOrigin
            ? originIconBadge('coreCube', label, 'core', 'core')
            : originIconBadge('puzzle', label, 'external', 'non-core');
    }

    function participantProviderId(participant) {
        const policy = participant && participant.providerPolicy && typeof participant.providerPolicy === 'object' ? participant.providerPolicy : {};
        return String(policy.providerId || '').trim();
    }

    function providerRoleIcon(participant) {
        const providerId = participantProviderId(participant);
        if (providerId || hasRole(participant, 'provider')) return roleIconBadge('plug', providerId ? `Provider: ${providerId}` : 'Provider participant', 'provider', 'provider');
        return '';
    }

    function ownerHeaderIcons(participant) {
        if (!participant) return '';
        if (hasRole(participant, 'owner')) {
            const kind = String(participant.kind || '').trim();
            const ownership = String(participant.ownership || '').trim();
            const secondaryIcon = kind === 'provider-coordinator' || ownership === 'multi-provider'
                ? roleIconBadge('network', 'Provider coordinator', 'provider', 'provider-coordinator')
                : roleIconBadge('plug', 'Capability provider', 'provider', 'provider');
            return `${roleIconBadge('crown', 'Owner', 'owner', 'owner')}${participantOriginIcon(participant)}${secondaryIcon}`;
        }
        return `${providerRoleIcon(participant)}${participantOriginIcon(participant)}`;
    }

    function participantTooltip(participant) {
        const pluginId = participant && participant.pluginId ? participant.pluginId : 'unknown';
        const roles = Array.isArray(participant && participant.roles) && participant.roles.length ? participant.roles.join(', ') : 'participant';
        const parts = [participant && participant._shimOnly ? `Shim: ${pluginId}` : `Plugin: ${pluginId}`, `Roles: ${roles}`];
        const providerId = participantProviderId(participant);
        if (providerId) parts.push(`Provider: ${providerId}`);
        parts.push(`Registration: ${participant && participant.runtime ? 'runtime' : 'manifest'}`);
        parts.push(`Availability: ${participant && participant.availability ? participant.availability : 'available'}`);
        if (participant && participant.safety) parts.push(`Safety: ${participant.safety}`);
        if (participant && hasRole(participant, 'owner') && participant.kind) parts.push(`Kind: ${participant.kind}`);
        if (participant && hasRole(participant, 'owner') && participant.ownership && !participant.kind) parts.push(`Ownership: ${participant.ownership}`);
        if (participant && participant._shimOnly) parts.push('Source: legacy compatibility shim');
        return parts.join(' | ');
    }

    function copyButton(value, label = 'Copy') {
        if (!value) return '';
        return `<button type="button" data-copy-surface="${attr(value)}" class="rounded border border-gray-800 bg-dark-700 px-2 py-1 text-[11px] leading-none text-gray-400 hover:text-white hover:border-gray-600 transition">${text(label)}</button>`;
    }

    function metricCard(label, value, tone = 'muted') {
        const toneClass = {
            clean: 'border-emerald-800/60 bg-emerald-500/5',
            warning: 'border-amber-800/60 bg-amber-500/5',
            conflict: 'border-red-800/70 bg-red-500/5',
            used: 'border-gold/40 bg-gold/5',
            muted: 'border-gray-800 bg-dark-800/70',
        }[tone] || 'border-gray-800 bg-dark-800/70';
        return `
            <div class="rounded-lg border ${toneClass} px-3 py-2" data-summary-card="metric" data-tone="${attr(tone)}">
                <div data-summary-row>
                    <span class="text-[11px] uppercase tracking-wide text-gray-500" data-summary-label>${text(label)}</span>
                    <span class="text-lg font-semibold text-white" data-summary-value>${text(value)}</span>
                </div>
            </div>`;
    }

    function isAttributionOnlyShim(shim) {
        const attributionOnly = ATTRIBUTION_ONLY_SHIMS[String(shim && shim.capability || '')];
        return !!(attributionOnly && attributionOnly.has(String(shim && shim.legacySurface || '')));
    }

    function totalShimHits(shims) {
        return (Array.isArray(shims) ? shims : []).reduce((sum, shim) => (
            isAttributionOnlyShim(shim) ? sum : sum + Number(shim && shim.hitCount || 0)
        ), 0);
    }

    function compatibilityState(conflicts, warningCount = 0) {
        const count = Array.isArray(conflicts) ? conflicts.length : 0;
        if (count) return { label: 'Conflicts', tone: 'conflict' };
        if (warningCount) return { label: 'Warnings', tone: 'warning' };
        return { label: 'Clean', tone: 'clean' };
    }

    function reviewInfo(pipeline) {
        const review = pipeline && pipeline.review && typeof pipeline.review === 'object' ? pipeline.review : {};
        return {
            lifecycle: review.lifecycle || 'plugin-defined',
            label: review.label || 'Plugin-defined',
            tone: review.tone || 'info',
            summary: review.summary || 'Declared by a plugin or test fixture rather than registered as a core FeedBack domain.',
        };
    }

    function uniqueValues(items, field, fallback) {
        const values = [];
        for (const item of Array.isArray(items) ? items : []) {
            const value = String(item && item[field] || fallback || '').trim();
            if (value && !values.includes(value)) values.push(value);
        }
        if (!values.length && fallback) values.push(fallback);
        return values;
    }

    function hasRole(participant, role) {
        return Array.isArray(participant && participant.roles) && participant.roles.includes(role);
    }

    function isCoreOwner(participant) {
        return participant && participant.pluginId === 'core' && hasRole(participant, 'owner');
    }

    function coreOwners(participants) {
        return (Array.isArray(participants) ? participants : []).filter(isCoreOwner);
    }

    function nonCoreParticipants(participants) {
        return (Array.isArray(participants) ? participants : []).filter(participant => participant && participant.pluginId !== 'core');
    }

    function ownerNames(participants) {
        const owners = (Array.isArray(participants) ? participants : []).filter(participant => hasRole(participant, 'owner'));
        return uniqueValues(owners, 'pluginId', '');
    }

    function ownerParticipants(participants) {
        return (Array.isArray(participants) ? participants : []).filter(participant => hasRole(participant, 'owner'));
    }

    function uniqueList(values) {
        const out = [];
        for (const value of Array.isArray(values) ? values : []) {
            const item = String(value || '').trim();
            if (item && !out.includes(item)) out.push(item);
        }
        return out;
    }

    function capabilityItems(participants, field) {
        const items = (Array.isArray(participants) ? participants : []).flatMap(participant => {
            if (!participant) return [];
            const values = Array.isArray(participant[field]) ? participant[field] : [];
            if (field === 'events') return [...values, ...(Array.isArray(participant.observes) ? participant.observes : []), ...(Array.isArray(participant.emits) ? participant.emits : [])];
            return values;
        });
        return uniqueList(items);
    }

    function shimEndpoint(surface, capability = '') {
        const attributionOnly = ATTRIBUTION_ONLY_SHIMS[String(capability || '')];
        if (attributionOnly && attributionOnly.has(String(surface || ''))) return null;
        const mapped = (LEGACY_SURFACE_ENDPOINTS[String(capability || '')] || {})[String(surface || '')];
        if (mapped) return mapped;
        return { type: 'command', label: String(surface || '').trim() };
    }

    function shimEndpoints(shims, type, onlyHits) {
        return uniqueList((Array.isArray(shims) ? shims : [])
            .filter(shim => !onlyHits || Number(shim && shim.hitCount || 0) > 0)
            .map(shim => shimEndpoint(shim && shim.legacySurface, shim && shim.capability))
            .filter(endpoint => endpoint && endpoint.type === type)
            .map(endpoint => endpoint.label)
            .filter(Boolean));
    }

    function observedShimCommands(shims) {
        return shimEndpoints(shims, 'command', true);
    }

    function observedShimEvents(shims) {
        return shimEndpoints(shims, 'event', true);
    }

    function expectedShimCommands(expectedShims) {
        return shimEndpoints(expectedShims, 'command', false);
    }

    function expectedShimEvents(expectedShims) {
        return shimEndpoints(expectedShims, 'event', false);
    }

    function shimmedEndpointsBySource(shims) {
        const bySource = new Map();
        for (const shim of Array.isArray(shims) ? shims : []) {
            if (!shim || Number(shim.hitCount || 0) <= 0) continue;
            const source = String(shim.source || '').trim();
            if (!source) continue;
            const endpoint = shimEndpoint(shim.legacySurface, shim.capability);
            if (!endpoint || !endpoint.label) continue;
            const key = endpointKey(endpoint.type, endpoint.label);
            const endpoints = bySource.get(source) || new Set();
            endpoints.add(key);
            bySource.set(source, endpoints);
        }
        return bySource;
    }

    function participantUses(participant, shims, expectedShims) {
        const source = participant && participant.pluginId;
        const participantShims = (Array.isArray(shims) ? shims : []).filter(shim => shim && shim.source === source);
        const commands = uniqueList([...(participant && participant.commands || []), ...(participant && participant.requests || []), ...observedShimCommands(participantShims)]);
        const operations = uniqueList([...(participant && participant.operations || [])]);
        let events = uniqueList([...(participant && participant.events || []), ...(participant && participant.observes || []), ...(participant && participant.emits || []), ...observedShimEvents(participantShims)]);
        if (!events.length && participant && hasRole(participant, 'observer')) events = expectedShimEvents(expectedShims);
        return { commands, operations, events };
    }

    function currentGraphFilter() {
        const value = String(state.domainGraphFilter || 'all');
        return GRAPH_FILTERS.has(value) ? value : 'all';
    }

    function filteredCapabilities(commands, operations, events, filter) {
        if (filter === 'commands') return { commands, operations: [], events: [] };
        if (filter === 'operations') return { commands: [], operations, events: [] };
        if (filter === 'events') return { commands: [], operations: [], events };
        return { commands, operations, events };
    }

    function filteredGraphLinks(linkData, filter) {
        if (filter === 'shimmed') return { ...linkData, links: linkData.links.filter(link => link.type === 'shimmed') };
        if (filter === 'commands') return { ...linkData, links: linkData.links.filter(link => link.endpointType === 'command') };
        if (filter === 'operations') return { ...linkData, links: linkData.links.filter(link => link.endpointType === 'operation') };
        if (filter === 'events') return { ...linkData, links: linkData.links.filter(link => link.endpointType === 'event') };
        return linkData;
    }

    function graphFilterButton(value, label) {
        const active = currentGraphFilter() === value;
        const classes = active ? 'bg-purple-500/40 text-white border-purple-400/40' : 'border-gray-800 text-gray-400 hover:text-white hover:border-gray-600';
        return `<button type="button" data-domain-graph-filter="${attr(value)}" aria-pressed="${active ? 'true' : 'false'}" class="rounded border px-2 py-1 transition ${classes}">${text(label)}</button>`;
    }

    function endpointKey(type, value) {
        return `${type}:${String(value || '')}`;
    }

    function participantEndpointKey(index, type, value) {
        return `${index}:${endpointKey(type, value)}`;
    }

    function graphCollapsedGroups() {
        state.graphCollapsedGroups = state.graphCollapsedGroups || {};
        return state.graphCollapsedGroups;
    }

    function graphGroupStateKey(domain, side, index, type) {
        return [domain || 'unknown', side || 'provider', index == null ? 'all' : String(index), type || 'event'].join('|');
    }

    function isGraphGroupCollapsed(domain, side, index, type) {
        return !!graphCollapsedGroups()[graphGroupStateKey(domain, side, index, type)];
    }

    function graphCapabilityGroupPortKey(type) {
        return `group:${type}`;
    }

    function participantGroupPortKey(index, type) {
        return `${index}:group:${type}`;
    }

    function endpointIcon(type, graphKey = '', linkKind = '', flow = '') {
        const flowKey = flow || type;
        const colorClass = flowKey === 'provider-command'
            ? 'bg-purple-400 border-purple-200 shadow-[0_0_12px_rgba(192,132,252,0.65)]'
            : flowKey === 'provider-operation'
                ? 'bg-purple-300 border-purple-100 shadow-[0_0_12px_rgba(216,180,254,0.65)]'
            : flowKey === 'provider-event'
                ? 'bg-violet-200 border-violet-100 shadow-[0_0_12px_rgba(221,214,254,0.6)]'
                : type === 'command'
                    ? 'bg-orange-400 border-orange-200 shadow-[0_0_12px_rgba(251,146,60,0.65)]'
                    : type === 'operation'
                        ? 'bg-purple-400 border-purple-200 shadow-[0_0_12px_rgba(192,132,252,0.65)]'
                    : 'bg-blue-400 border-blue-200 shadow-[0_0_12px_rgba(96,165,250,0.65)]';
        const shapeClass = type === 'event' ? 'rotate-45 rounded-sm' : 'rounded';
        const dataAttr = graphKey ? ` data-graph-${linkKind ? 'participant' : 'capability'}-port="${attr(graphKey)}"` : '';
        return `<span class="inline-block h-3 w-3 shrink-0 border ${shapeClass} ${colorClass}" data-endpoint-icon="${attr(type)}" data-endpoint-flow="${attr(flowKey)}"${dataAttr} aria-hidden="true"></span>`;
    }

    function participantEndpointKind(participant, type, item, shims) {
        if (participant && participant._shimOnly) return 'shimmed';
        const shimmed = shimmedEndpointsBySource(shims).get(participant && participant.pluginId);
        return shimmed && shimmed.has(endpointKey(type, item)) ? 'shimmed' : 'observed';
    }

    function graphLinkFlow(participant, endpointType) {
        if (endpointType === 'command' && hasRole(participant, 'provider')) return 'provider-command';
        if (endpointType === 'operation' && hasRole(participant, 'provider')) return 'provider-operation';
        if (endpointType === 'event' && hasRole(participant, 'provider')) return 'provider-event';
        return endpointType;
    }

    function graphLinkColor(flow) {
        if (flow === 'provider-command') return '#c084fc';
        if (flow === 'provider-operation') return '#d8b4fe';
        if (flow === 'operation') return '#c084fc';
        if (flow === 'provider-event') return '#ddd6fe';
        if (flow === 'event') return '#6ea8ff';
        return '#fb923c';
    }

    function graphLinkTitle(link) {
        if (link && link.flow === 'provider-command') return 'Provider command link';
        if (link && link.flow === 'provider-operation') return 'Provider operation link';
        if (link && link.endpointType === 'operation') return 'Operation link';
        if (link && link.flow === 'provider-event') return 'Provider event link';
        if (link && link.endpointType === 'event') return 'Event link';
        return 'Command link';
    }

    function loadCytoscape() {
        if (window.cytoscape) return Promise.resolve(window.cytoscape);
        if (cytoscapePromise) return cytoscapePromise;
        cytoscapePromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = CYTOSCAPE_URL;
            script.async = true;
            script.onload = () => window.cytoscape ? resolve(window.cytoscape) : reject(new Error('Cytoscape did not initialize'));
            script.onerror = () => reject(new Error('Unable to load Cytoscape'));
            (document.head || document.body || document.documentElement).appendChild(script);
        });
        return cytoscapePromise;
    }

    function destroyActiveGraph(domain) {
        const graph = activeGraphs.get(domain);
        if (graph && typeof graph.destroy === 'function') graph.destroy();
        activeGraphs.delete(domain);
        if (activeGraph === graph) activeGraph = null;
        if (!activeGraph && activeGraphs.size) activeGraph = activeGraphs.values().next().value || null;
        state.activeGraph = activeGraph;
        state.activeGraphs = activeGraphs;
    }

    function destroyActiveGraphs() {
        activeGraphs.forEach(graph => {
            if (graph && typeof graph.destroy === 'function') graph.destroy();
        });
        activeGraphs = new Map();
        activeGraph = null;
        state.activeGraph = null;
        state.activeGraphs = activeGraphs;
    }

    function rememberActiveGraph(domain, graph) {
        destroyActiveGraph(domain);
        activeGraphs.set(domain, graph);
        activeGraph = graph;
        state.activeGraph = graph;
        state.activeGraphs = activeGraphs;
    }

    function graphModel(pipeline, shims, expectedShims, filter = currentGraphFilter()) {
        const participants = Array.isArray(pipeline.participants) ? pipeline.participants : [];
        const providers = ownerParticipants(participants);
        const users = graphParticipants(participants, shims, hasMultiProviderOwner(participants));
        const allCommands = uniqueList([...capabilityItems(providers.length ? providers : participants, 'commands'), ...expectedShimCommands(expectedShims), ...observedShimCommands(shims)]);
        const allOperations = uniqueList([...capabilityItems(providers.length ? providers : participants, 'operations')]);
        const allEvents = uniqueList([...capabilityItems(providers.length ? providers : participants, 'events'), ...expectedShimEvents(expectedShims), ...observedShimEvents(shims)]);
        const activeFilter = GRAPH_FILTERS.has(filter) ? filter : 'all';
        const { commands, operations, events } = filteredCapabilities(allCommands, allOperations, allEvents, activeFilter);
        const linkData = filteredGraphLinks(domainGraphLinks({ commands, operations, events }, users, shims, expectedShims), activeFilter);
        const allLinkData = domainGraphLinks({ commands: allCommands, operations: allOperations, events: allEvents }, users, shims, expectedShims);
        return { participants, providers, users, allCommands, allOperations, allEvents, commands, operations, events, linkData, allLinkData };
    }

    function mountDomainGraph(pipeline, shims, expectedShims) {
        const ids = graphDomIds(pipeline && pipeline.name);
        const container = document.getElementById(ids.cyId);
        const frame = document.getElementById(ids.frameId);
        if (!container || !frame || !container.getBoundingClientRect || !frame.querySelectorAll) return;
        const portAnchor = (element) => {
            const frameRect = frame.getBoundingClientRect();
            const rect = element.getBoundingClientRect();
            const x = rect.left - frameRect.left + (rect.width / 2);
            return { x, y: rect.top - frameRect.top + (rect.height / 2) };
        };
        const portByKey = (selector, datasetKey, key) => Array.from(frame.querySelectorAll(selector)).find(element => element.dataset && element.dataset[datasetKey] === key);
        loadCytoscape().then(cytoscape => {
            if (!container.isConnected) return;
            const schedule = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : callback => setTimeout(callback, 0);
            schedule(() => {
                if (!container.isConnected) return;
                const model = graphModel(pipeline, shims, expectedShims);
                const width = Math.max(760, Math.round(frame.getBoundingClientRect().width || container.clientWidth || 0));
                const height = Math.max(360, Math.round(frame.getBoundingClientRect().height || container.clientHeight || 0));
                container.style.width = `${width}px`;
                container.style.height = `${height}px`;
                container.innerHTML = '';
                const elements = [];
                for (let index = 0; index < model.linkData.links.length; index += 1) {
                    const link = model.linkData.links[index];
                    const sourceKey = isGraphGroupCollapsed(pipeline.name, 'provider', 'all', link.endpointType)
                        ? graphCapabilityGroupPortKey(link.endpointType)
                        : endpointKey(link.endpointType, link.sourceLabel || link.label);
                    const targetKey = isGraphGroupCollapsed(pipeline.name, 'participant', link.participantIndex, link.endpointType)
                        ? participantGroupPortKey(link.participantIndex, link.endpointType)
                        : participantEndpointKey(link.participantIndex, link.endpointType, link.label);
                    const source = portByKey('[data-graph-capability-port]', 'graphCapabilityPort', sourceKey);
                    const target = portByKey('[data-graph-participant-port]', 'graphParticipantPort', targetKey);
                    if (!source || !target) continue;
                    const sourcePoint = portAnchor(source);
                    const targetPoint = portAnchor(target);
                    const sourceId = `link-${index}-source`;
                    const targetId = `link-${index}-target`;
                    elements.push({ data: { id: sourceId }, position: sourcePoint });
                    elements.push({ data: { id: targetId }, position: targetPoint });
                    elements.push({ data: { id: `link-${index}`, source: sourceId, target: targetId, kind: link.type, endpointType: link.endpointType, flow: link.flow || link.endpointType, participantIndex: link.participantIndex, participantId: link.participantId || '', label: link.label, sourceLabel: link.sourceLabel || link.label } });
                }
                const graph = cytoscape({
                    container,
                    elements,
                    layout: { name: 'preset', fit: false },
                    minZoom: 1,
                    maxZoom: 1,
                    userZoomingEnabled: false,
                    userPanningEnabled: false,
                    boxSelectionEnabled: false,
                    autoungrabify: true,
                    style: [
                        { selector: 'node', style: { width: 1, height: 1, opacity: 0, label: '' } },
                        { selector: 'edge', style: { width: 1.55, 'curve-style': 'unbundled-bezier', 'control-point-distances': '96 -96', 'control-point-weights': '0.35 0.65', 'target-arrow-shape': 'none', opacity: 0.86, 'line-cap': 'round' } },
                        { selector: 'edge[endpointType = "command"]', style: { 'line-color': '#fb923c' } },
                        { selector: 'edge[flow = "provider-command"]', style: { 'line-color': '#c084fc' } },
                        { selector: 'edge[endpointType = "operation"]', style: { 'line-color': '#c084fc' } },
                        { selector: 'edge[flow = "provider-operation"]', style: { 'line-color': '#d8b4fe' } },
                        { selector: 'edge[endpointType = "event"]', style: { 'line-color': '#6ea8ff' } },
                        { selector: 'edge[flow = "provider-event"]', style: { 'line-color': '#ddd6fe' } },
                        { selector: 'edge[kind = "shimmed"]', style: { 'line-style': 'dashed', 'line-dash-pattern': [9, 7] } },
                        { selector: 'edge.dimmed', style: { opacity: 0.12, width: 1 } },
                        { selector: 'edge.highlighted', style: { opacity: 1, width: 3.25, 'z-index': 10 } },
                    ],
                });
                rememberActiveGraph(pipeline.name, graph);
                graph.zoom(1);
                graph.pan({ x: 0, y: 0 });
                graph.resize();
                applyGraphHover(state.graphHover || null);
            });
        }).catch(() => {
            container.innerHTML = '<div class="flex h-full min-h-[18rem] items-center justify-center rounded-lg border border-gray-800 bg-dark-900/30 p-4 text-sm text-gray-500">Graph renderer unavailable. Showing fallback lanes below.</div>';
        });
    }

    function graphEdgeMatches(edge, hover) {
        if (!hover) return false;
        const participantIndex = String(edge.data('participantIndex'));
        const endpointType = String(edge.data('endpointType') || '');
        const label = String(edge.data('label') || '');
        const sourceLabel = String(edge.data('sourceLabel') || label);
        if (hover.kind === 'participant') return participantIndex === String(hover.participantIndex);
        if (hover.kind === 'provider-group') return endpointType === hover.endpointType;
        if (hover.kind === 'provider-endpoint') return endpointType === hover.endpointType && sourceLabel === hover.label;
        if (hover.kind === 'participant-group') return participantIndex === String(hover.participantIndex) && endpointType === hover.endpointType;
        if (hover.kind === 'participant-endpoint') return participantIndex === String(hover.participantIndex) && endpointType === hover.endpointType && label === hover.label;
        return false;
    }

    function graphProviderFocusKey(type, label) {
        return `${type || ''}:${label || ''}`;
    }

    function setGraphFocusStyle(element, mode) {
        if (!element || !element.style) return;
        if (!mode) {
            element.style.opacity = '';
            element.style.filter = '';
            element.style.fontWeight = '';
            element.style.color = '';
            return;
        }
        if (mode === 'active') {
            element.style.opacity = '1';
            element.style.filter = '';
            element.style.fontWeight = '700';
            element.style.color = '#f9fafb';
            return;
        }
        element.style.opacity = '0.24';
        element.style.filter = 'saturate(0.6)';
        element.style.fontWeight = '';
        element.style.color = '';
    }

    function graphFrames() {
        if (!document.querySelectorAll) return [];
        return Array.from(document.querySelectorAll('[data-domain-graph-frame]'));
    }

    function frameForDomain(domain) {
        const ids = graphDomIds(domain);
        return document.getElementById(ids.frameId);
    }

    function applyProviderHoverStyles(hover, matchingEdges, frame) {
        const frames = frame ? [frame] : graphFrames();
        if (!frames.length) return;
        if (!hover) {
            frames.forEach(frameElement => {
                if (!frameElement || !frameElement.querySelectorAll) return;
                Array.from(frameElement.querySelectorAll('[data-graph-provider-focus]'))
                    .forEach(target => setGraphFocusStyle(target, null));
            });
            return;
        }
        const activeTypes = new Set();
        const activeLabels = new Set();
        matchingEdges.forEach(edge => {
            const type = String(edge.data('endpointType') || '');
            const label = String(edge.data('sourceLabel') || edge.data('label') || '');
            if (type) activeTypes.add(type);
            if (type && label) activeLabels.add(graphProviderFocusKey(type, label));
        });
        if (hover.kind === 'provider-group' && hover.endpointType) activeTypes.add(hover.endpointType);
        if (hover.kind === 'provider-endpoint' && hover.endpointType && hover.label) {
            activeTypes.add(hover.endpointType);
            activeLabels.add(graphProviderFocusKey(hover.endpointType, hover.label));
        }
        frames.forEach(frameElement => {
            if (!frameElement || !frameElement.querySelectorAll) return;
            const targets = Array.from(frameElement.querySelectorAll('[data-graph-provider-focus]'));
            targets.forEach(target => {
                const type = target.dataset.graphFocusType || '';
                const label = target.dataset.graphFocusLabel || '';
                const active = label
                    ? activeLabels.has(graphProviderFocusKey(type, label))
                    : activeTypes.has(type);
                setGraphFocusStyle(target, active ? 'active' : 'inactive');
            });
        });
    }

    function applyGraphHover(hover) {
        state.graphHover = hover || null;
        if (!activeGraphs.size) {
            applyProviderHoverStyles(null, []);
            return;
        }
        activeGraphs.forEach((graph, domain) => {
            if (!graph || typeof graph.edges !== 'function') return;
            const frame = frameForDomain(domain);
            const edges = graph.edges();
            if (!edges || typeof edges.removeClass !== 'function') return;
            edges.removeClass('highlighted');
            edges.removeClass('dimmed');
            if (!hover || hover.domain !== domain) {
                applyProviderHoverStyles(null, [], frame);
                return;
            }
            const matchingEdges = [];
            edges.forEach(edge => {
                const matches = graphEdgeMatches(edge, hover);
                if (matches) matchingEdges.push(edge);
                edge.addClass(matches ? 'highlighted' : 'dimmed');
            });
            applyProviderHoverStyles(hover, matchingEdges, frame);
        });
    }

    function graphHoverFromElement(element) {
        if (!element || !element.dataset) return null;
        const root = element.closest && element.closest('[data-domain-graph]');
        const domain = root && root.dataset ? root.dataset.domainGraph : '';
        const kind = element.dataset.graphFocusKind;
        if (kind) {
            return {
                domain,
                kind,
                participantIndex: element.dataset.graphFocusParticipantIndex,
                endpointType: element.dataset.graphFocusType || '',
                label: element.dataset.graphFocusLabel || '',
            };
        }
        if (element.dataset.graphHoverParticipant != null) {
            return { domain, kind: 'participant', participantIndex: element.dataset.graphHoverParticipant };
        }
        return null;
    }

    function hasMultiProviderOwner(participants) {
        return (Array.isArray(participants) ? participants : []).some(participant => hasRole(participant, 'owner') && participant && (participant.kind === 'provider-coordinator' || participant.ownership === 'multi-provider'));
    }

    function graphParticipants(participants, shims, includeProviders = false) {
        const users = nonCoreParticipants(participants)
            .filter(participant => !hasRole(participant, 'owner'))
            .filter(participant => includeProviders || !hasRole(participant, 'provider'))
            .slice();
        const known = new Set(users.map(participant => participant.pluginId));
        for (const shim of Array.isArray(shims) ? shims : []) {
            const source = String(shim && shim.source || '').trim();
            if (!source || source === 'core' || known.has(source)) continue;
            users.push({
                pluginId: source,
                roles: ['participant'],
                commands: [],
                events: [],
                runtime: true,
                availability: 'available',
                ownership: 'observer-only',
                safety: 'safe',
                _shimOnly: true,
            });
            known.add(source);
        }
        return users;
    }

    function graphParticipantCount(participants, users) {
        const ids = new Set();
        for (const participant of [...(Array.isArray(participants) ? participants : []), ...(Array.isArray(users) ? users : [])]) {
            const id = String(participant && participant.pluginId || '').trim();
            if (id) ids.add(id);
        }
        return ids.size;
    }

    function domainIconName(name, review) {
        const icon = DOMAIN_ICONS[String(name || '')];
        if (icon) return icon;
        const lifecycle = review && review.lifecycle;
        if (lifecycle === 'future-expansion') return 'history';
        if (lifecycle === 'plugin-defined') return 'puzzle';
        if (lifecycle === 'diagnostic') return 'fileSearch';
        return 'box';
    }

    function expandedDomains() {
        state.expandedDomains = state.expandedDomains || {};
        return state.expandedDomains;
    }

    function isDomainExpanded(name, defaultExpanded) {
        const expanded = expandedDomains();
        return Object.prototype.hasOwnProperty.call(expanded, name) ? !!expanded[name] : !!defaultExpanded;
    }

    function panelIdForDomain(name) {
        return `capability-domain-${String(name || 'unknown').replace(/[^A-Za-z0-9_-]+/g, '-')}`;
    }

    function graphDomIds(name) {
        const base = `${panelIdForDomain(name)}-graph`;
        return {
            panelId: `${base}-panel`,
            frameId: `${base}-frame`,
            cyId: `${base}-cy`,
            fallbackId: `${base}-fallback`,
        };
    }

    function domainGroup(name) {
        for (let index = 0; index < DOMAIN_GROUPS.length; index += 1) {
            const group = DOMAIN_GROUPS[index];
            const domainIndex = group.domains.indexOf(name);
            if (domainIndex >= 0) return { ...group, groupIndex: index, domainIndex };
        }
        const fallbackIndex = DOMAIN_GROUPS.findIndex(group => group.id === 'plugin-defined');
        const fallback = DOMAIN_GROUPS[fallbackIndex >= 0 ? fallbackIndex : DOMAIN_GROUPS.length - 1];
        return { ...fallback, groupIndex: fallbackIndex >= 0 ? fallbackIndex : DOMAIN_GROUPS.length - 1, domainIndex: Number.MAX_SAFE_INTEGER };
    }

    function sortPipelines(pipelines) {
        return (Array.isArray(pipelines) ? pipelines : []).slice().sort((a, b) => {
            const ag = domainGroup(a && a.name);
            const bg = domainGroup(b && b.name);
            if (ag.groupIndex !== bg.groupIndex) return ag.groupIndex - bg.groupIndex;
            if (ag.domainIndex !== bg.domainIndex) return ag.domainIndex - bg.domainIndex;
            return String(a && a.name || '').localeCompare(String(b && b.name || ''));
        });
    }

    function groupedPipelines(pipelines) {
        const byGroup = new Map();
        for (const pipeline of sortPipelines(pipelines)) {
            const group = domainGroup(pipeline.name);
            const entry = byGroup.get(group.id) || { group, pipelines: [] };
            entry.pipelines.push(pipeline);
            byGroup.set(group.id, entry);
        }
        return DOMAIN_GROUPS.map(group => byGroup.get(group.id)).filter(Boolean);
    }

    function participantRow(participant) {
        const availability = participant.availability || (participant.enabled ? 'available' : 'disabled');
        const availabilityTone = availability === 'available' ? 'clean' : (availability === 'disabled' ? 'muted' : 'warning');
        return `
            <div class="border border-gray-800 rounded-lg p-3 bg-dark-900/35">
                <div class="flex flex-wrap items-center justify-between gap-2">
                    <span class="font-semibold text-white">${text(participant.pluginId)}</span>
                    <div class="flex flex-wrap gap-1">
                        ${pill(availability, availabilityTone)}
                        ${pill(participant.runtime ? 'runtime' : 'manifest', participant.runtime ? 'info' : 'muted')}
                        ${participant.incompatible ? pill('incompatible', 'conflict') : ''}
                    </div>
                </div>
                <div class="flex flex-wrap gap-1 mt-3">${chips(participant.roles, 'bg-dark-700 text-gray-300 border border-gray-800')}</div>
                <div class="mt-3 grid gap-1 text-xs text-gray-500">
                    <div><span class="text-gray-400">Commands:</span> ${text((participant.commands || []).join(', ') || 'none')}</div>
                    <div><span class="text-gray-400">Operations:</span> ${text((participant.operations || []).join(', ') || 'none')}</div>
                    <div><span class="text-gray-400">Requests:</span> ${text((participant.requests || []).join(', ') || 'none')}</div>
                    <div><span class="text-gray-400">Observes:</span> ${text((participant.observes || []).join(', ') || 'none')}</div>
                    <div><span class="text-gray-400">Safety:</span> ${text(participant.safety || 'safe')} ${participant.kind ? `<span class="text-gray-700">/</span> <span class="text-gray-400">Kind:</span> ${text(participant.kind)}` : `<span class="text-gray-700">/</span> <span class="text-gray-400">Ownership:</span> ${text(participant.ownership || 'exclusive-owner')}`}</div>
                </div>
            </div>`;
    }

    function participantLabel(participant) {
        const roles = Array.isArray(participant && participant.roles) ? participant.roles : [];
        return `${participant && participant.pluginId ? participant.pluginId : 'unknown'}${roles.length ? ` (${roles.join(', ')})` : ''}`;
    }

    function participantChips(participants, emptyLabel, tone = 'muted') {
        const list = Array.isArray(participants) ? participants : [];
        if (!list.length) return `<span class="rounded border border-gray-800 bg-dark-900/35 px-2 py-1 text-xs text-gray-500">${text(emptyLabel)}</span>`;
        const className = tone === 'observed'
            ? 'rounded border border-teal-700/60 bg-teal-500/10 px-2 py-1 text-xs text-teal-300'
            : 'rounded border border-gray-800 bg-dark-700 px-2 py-1 text-xs text-gray-300';
        return list.map(participant => `<span class="${className}" title="${attr(participantLabel(participant))}">${text(participantLabel(participant))}</span>`).join('');
    }

    function capabilityRelationshipRows(pipelines) {
        return sortPipelines(pipelines).map(pipeline => {
            const participants = Array.isArray(pipeline && pipeline.participants) ? pipeline.participants : [];
            return {
                capability: pipeline.name,
                providers: ownerProviderParticipants(participants),
                users: nonCoreParticipants(participants),
            };
        });
    }

    function capabilityRelationshipMap(pipelines) {
        const rows = capabilityRelationshipRows(pipelines);
        if (!rows.length) return '';
        return `
            <section class="rounded-lg border border-gray-800 bg-dark-800/45 p-4">
                <div class="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <h3 class="text-sm font-semibold text-gray-100">Capability relationship map</h3>
                        <p class="mt-1 text-xs text-gray-500">Owner/provider capabilities connect to non-core participants using the same capability.</p>
                    </div>
                    ${pill(`${rows.reduce((sum, row) => sum + row.users.length, 0)} external`, rows.some(row => row.users.length) ? 'observed' : 'muted')}
                </div>
                <div class="hidden gap-2 text-[11px] uppercase tracking-wide text-gray-500 lg:grid lg:grid-cols-[minmax(9rem,0.9fr)_minmax(12rem,1fr)_4rem_minmax(12rem,1fr)]">
                    <div>Owner/provider</div>
                    <div class="text-right">Capability</div>
                    <div></div>
                    <div>Non-core usage</div>
                </div>
                <div class="mt-2 grid gap-2">
                    ${rows.map(row => `
                        <div class="grid gap-2 rounded border border-gray-800 bg-dark-900/30 p-2 lg:grid-cols-[minmax(9rem,0.9fr)_minmax(12rem,1fr)_4rem_minmax(12rem,1fr)] lg:items-center" data-capability-link="${attr(row.capability)}">
                            <div class="flex flex-wrap gap-1">${participantChips(row.providers, 'No owner/provider')}</div>
                            <div class="flex justify-start lg:justify-end">
                                <span class="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-2 py-1 text-xs font-medium text-accent-light" title="Capability: ${attr(row.capability)}">${iconSvg('list')}<span>${text(row.capability)}</span></span>
                            </div>
                            <div class="hidden items-center lg:flex" aria-hidden="true">
                                <span class="h-px flex-1 bg-gray-700"></span>
                                <span class="h-2 w-2 rotate-45 border-r border-t border-gray-700"></span>
                            </div>
                            <div class="flex flex-wrap gap-1">${participantChips(row.users, 'No usage', row.users.length ? 'observed' : 'muted')}</div>
                        </div>`).join('')}
                </div>
            </section>`;
    }

    function shimTitle(shim) {
        const surface = String(shim && shim.legacySurface || '');
        if (surface === 'register_library_provider') return 'Legacy library provider detected';
        if (surface === 'refresh') return 'Legacy library refresh detected';
        if (surface === 'select') return 'Legacy library provider selection detected';
        if (surface === 'sync-song') return 'Legacy library song sync detected';
        return 'Legacy compatibility surface detected';
    }

    function formatTime(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    }

    function matchingExpectedShim(shim, expectedShims) {
        const surface = String(shim && shim.legacySurface || '');
        return (Array.isArray(expectedShims) ? expectedShims : []).find(expected => {
            const expectedSurface = String(expected && expected.legacySurface || '');
            if (!expectedSurface) return false;
            return expectedSurface.endsWith('*') ? surface.startsWith(expectedSurface.slice(0, -1)) : surface === expectedSurface;
        }) || null;
    }

    function shimRow(shim, expectedShims) {
        const hitCount = Number(shim.hitCount || 0);
        const expected = matchingExpectedShim(shim, expectedShims);
        const status = hitCount > 0 ? pill('Used', 'used') : pill(shim.status || 'active', shim.status === 'active' ? 'info' : 'muted');
        const lastSeen = formatTime(shim.lastHitAt);
        return `
            <div class="rounded-lg border ${hitCount > 0 ? 'border-gold/40 bg-gold/5' : 'border-gray-800 bg-dark-900/35'} p-3">
                <div class="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div class="text-sm font-semibold text-white">${text(shimTitle(shim))}</div>
                        <div class="mt-1 flex flex-wrap items-center gap-2">
                            <code class="rounded bg-dark-700 px-2 py-1 text-xs text-gray-200">${text(shim.legacySurface || 'legacy')}</code>
                            ${copyButton(shim.legacySurface)}
                        </div>
                    </div>
                    <div class="flex flex-wrap items-center gap-2">${status}</div>
                </div>
                <div class="mt-3 grid gap-1 text-xs text-gray-500">
                    <div>${hitCount} hit${hitCount === 1 ? '' : 's'}${lastSeen ? ` / last seen ${text(lastSeen)}` : ''}</div>
                    <div>Source: ${text(shim.source || 'unknown')}${shim.providerId ? ` / Provider: ${text(shim.providerId)}` : ''}</div>
                    <div>${text(shim.reason || expected?.reason || `Maps to ${shim.capability || 'unknown'} compatibility bridge`)}</div>
                </div>
            </div>`;
    }

    function shimSection(shims, expectedShims) {
        const list = Array.isArray(shims) ? shims : [];
        const hits = totalShimHits(list);
        return `
            <div class="rounded-lg border border-gray-800 bg-dark-800/45 p-4">
                <div class="mb-3">
                    <h4 class="text-sm font-semibold text-gray-100">Compatibility shims</h4>
                    <div class="mt-1 text-xs text-gray-500">${list.length} shim${list.length === 1 ? '' : 's'} / ${hits} hit${hits === 1 ? '' : 's'}</div>
                </div>
                ${list.length ? `<div class="grid gap-3">${list.map(shim => shimRow(shim, expectedShims)).join('')}</div>` : '<div class="rounded border border-gray-800 bg-dark-900/35 p-3 text-sm text-gray-500">No compatibility shims observed for this domain.</div>'}
            </div>`;
    }

    function expectedShimObserved(expected, shims) {
        const surface = String(expected && expected.legacySurface || '');
        if (!surface) return false;
        const prefix = surface.endsWith('*') ? surface.slice(0, -1) : '';
        return (Array.isArray(shims) ? shims : []).some(shim => {
            const observed = String(shim && shim.legacySurface || '');
            return prefix ? observed.startsWith(prefix) : observed === surface;
        });
    }

    function expectedShimCell(expected, observed) {
        if (!expected) return '<span class="text-xs text-gray-700">Not expected</span>';
        return `
            <div class="flex flex-col gap-2">
                <div class="flex flex-wrap items-center gap-2">
                    ${pill(observed ? 'Observed' : 'Not observed', observed ? 'observed' : 'muted')}
                    ${copyButton(expected.legacySurface)}
                </div>
                <code class="break-all rounded bg-dark-900 px-2 py-1 text-xs text-gray-300">${text(expected.legacySurface || 'legacy')}</code>
                <div class="text-xs text-gray-500">${text(expected.reason || '')}</div>
            </div>`;
    }

    function expectedShimGroup(expectedShims, observedShims) {
        const groups = new Map();
        for (const expected of Array.isArray(expectedShims) ? expectedShims : []) {
            const surface = String(expected && expected.legacySurface || '');
            const eventMatch = surface.match(/^window\.feedBack\.(emit|on):(.+)$/);
            const key = eventMatch ? eventMatch[2] : surface;
            const type = eventMatch ? (eventMatch[1] === 'emit' ? 'emit' : 'listener') : 'surface';
            const entry = groups.get(key) || { group: key, emit: null, listener: null, surfaces: [] };
            const withState = { ...expected, observed: expectedShimObserved(expected, observedShims) };
            if (type === 'emit') entry.emit = withState;
            else if (type === 'listener') entry.listener = withState;
            else entry.surfaces.push(withState);
            groups.set(key, entry);
        }
        return Array.from(groups.values());
    }

    function expectedSurfaceRow(group) {
        return `
            <tr class="border-t border-gray-800 align-top">
                <td class="px-3 py-3"><code class="text-xs text-gray-200">${text(group.group)}</code></td>
                <td class="px-3 py-3">${expectedShimCell(group.emit, group.emit && group.emit.observed)}</td>
                <td class="px-3 py-3">${expectedShimCell(group.listener, group.listener && group.listener.observed)}</td>
                <td class="px-3 py-3">
                    ${group.surfaces.length ? group.surfaces.map(item => expectedShimCell(item, item.observed)).join('<div class="my-2 border-t border-gray-800"></div>') : '<span class="text-xs text-gray-700">None</span>'}
                </td>
            </tr>`;
    }

    function expectedShimSection(domain, expectedShims, observedShims) {
        const list = Array.isArray(expectedShims) ? expectedShims : [];
        if (!list.length) {
            return `
                <div class="rounded-lg border border-gray-800 bg-dark-800/45 p-4 lg:col-span-2">
                    <h4 class="text-sm font-semibold text-gray-100">Expected legacy surfaces</h4>
                    <div class="mt-2 text-sm text-gray-500">No legacy compatibility shims are expected for this domain.</div>
                </div>`;
        }
        const filter = (state.surfaceFilters && state.surfaceFilters[domain]) || 'all';
        const groups = expectedShimGroup(list, observedShims).filter(group => {
            const entries = [group.emit, group.listener, ...group.surfaces].filter(Boolean);
            if (filter === 'observed') return entries.some(entry => entry.observed);
            if (filter === 'problems') return entries.some(entry => !entry.observed);
            return true;
        });
        return `
            <div class="rounded-lg border border-gray-800 bg-dark-800/45 p-4 lg:col-span-2">
                <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
                    <div>
                        <h4 class="text-sm font-semibold text-gray-100">Expected legacy surfaces</h4>
                        <div class="mt-1 text-xs text-gray-500">${list.length} expected / grouped by event or API surface</div>
                    </div>
                    <select data-surface-filter="${attr(domain)}" class="bg-dark-700 border border-gray-800 rounded px-2 py-1 text-xs text-gray-300 outline-none">
                        <option value="all" ${filter === 'all' ? 'selected' : ''}>Show all</option>
                        <option value="observed" ${filter === 'observed' ? 'selected' : ''}>Show observed</option>
                        <option value="problems" ${filter === 'problems' ? 'selected' : ''}>Show not observed</option>
                    </select>
                </div>
                <div class="overflow-x-auto rounded-lg border border-gray-800">
                    <table class="min-w-full text-left">
                        <thead class="bg-dark-900/70 text-[11px] uppercase tracking-wide text-gray-500">
                            <tr>
                                <th class="px-3 py-2 font-semibold">Group</th>
                                <th class="px-3 py-2 font-semibold">Emit surface</th>
                                <th class="px-3 py-2 font-semibold">Listener surface</th>
                                <th class="px-3 py-2 font-semibold">Other surface</th>
                            </tr>
                        </thead>
                        <tbody class="bg-dark-900/25">${groups.map(expectedSurfaceRow).join('') || '<tr><td colspan="4" class="px-3 py-4 text-sm text-gray-500">No surfaces match this filter.</td></tr>'}</tbody>
                    </table>
                </div>
            </div>`;
    }

    function participantSection(pipeline) {
        const participants = Array.isArray(pipeline.participants) ? pipeline.participants : [];
        const owners = coreOwners(participants);
        const extras = nonCoreParticipants(participants);
        return `
            <div class="rounded-lg border border-gray-800 bg-dark-800/45 p-4 lg:col-span-2">
                <div class="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <h4 class="text-sm font-semibold text-gray-100">Capability usage</h4>
                        <div class="mt-1 text-xs text-gray-500">Core ownership separated from non-core participants.</div>
                    </div>
                    ${pill(`${extras.length} non-core`, extras.length ? 'observed' : 'muted')}
                </div>
                <div class="grid gap-3 lg:grid-cols-2">
                    <div>
                        <div class="mb-2 text-xs uppercase tracking-wide text-gray-500">Core owner</div>
                        <div class="grid gap-3">${owners.map(participantRow).join('') || '<div class="rounded border border-gray-800 bg-dark-900/35 p-3 text-sm text-gray-500">No core owner is registered for this domain.</div>'}</div>
                    </div>
                    <div>
                        <div class="mb-2 text-xs uppercase tracking-wide text-gray-500">Non-core participants</div>
                        <div class="grid gap-3">${extras.map(participantRow).join('') || '<div class="rounded border border-gray-800 bg-dark-900/35 p-3 text-sm text-gray-500">No participants are using this capability.</div>'}</div>
                    </div>
                </div>
            </div>`;
    }

    function participantUsesByLinkData(users, linkData) {
        const uses = (Array.isArray(users) ? users : []).map(() => ({ commands: [], operations: [], events: [] }));
        for (const link of Array.isArray(linkData && linkData.links) ? linkData.links : []) {
            const entry = uses[link.participantIndex];
            if (!entry) continue;
            const list = link.endpointType === 'operation' ? entry.operations : (link.endpointType === 'command' ? entry.commands : entry.events);
            if (!list.includes(link.label)) list.push(link.label);
        }
        return uses;
    }

    function visibleGraphParticipants(users, usesByIndex) {
        return (Array.isArray(users) ? users : []).map((participant, index) => {
            const uses = (Array.isArray(usesByIndex) && usesByIndex[index]) || { commands: [], operations: [], events: [] };
            return { participant, index, uses };
        }).filter(entry => entry.uses.commands.length || entry.uses.operations.length || entry.uses.events.length);
    }

    function graphHeaderSummary(model) {
        const summaryUses = participantUsesByLinkData(model.users, model.allLinkData);
        const summaryParticipants = visibleGraphParticipants(model.users, summaryUses);
        const shimmed = model.allLinkData.links.filter(link => link.type === 'shimmed').length;
        const observed = model.allLinkData.links.filter(link => link.type === 'observed').length;
        return {
            participantTotal: graphParticipantCount([], summaryParticipants.map(entry => entry.participant)),
            capabilityTotal: model.allCommands.length + model.allOperations.length + model.allEvents.length,
            observed,
            shimmed,
        };
    }

    function graphGroupButton(domain, side, index, title, type, count, collapsed, flow = '') {
        const key = graphGroupStateKey(domain, side, index, type);
        const isProvider = side === 'provider';
        const port = collapsed
            ? (isProvider
                ? `<span class="absolute -right-[1.4375rem] top-1/2 -translate-y-1/2">${endpointIcon(type, graphCapabilityGroupPortKey(type))}</span>`
                : `<span class="absolute -left-[1.4375rem] top-1/2 -translate-y-1/2">${endpointIcon(type, participantGroupPortKey(index, type), 'group', flow)}</span>`)
            : '';
        const align = isProvider ? 'justify-end text-right' : 'justify-start text-left';
        const countPill = pill(String(count), 'muted');
        const focusAttrs = isProvider
            ? ` data-graph-focus-kind="provider-group" data-graph-focus-type="${attr(type)}" data-graph-provider-focus="group"`
            : ` data-graph-focus-kind="participant-group" data-graph-focus-participant-index="${attr(index)}" data-graph-focus-type="${attr(type)}"`;
        return `
            <button type="button" data-toggle-graph-group="${attr(key)}" data-graph-group-collapsed="${collapsed ? 'true' : 'false'}"${focusAttrs} aria-expanded="${collapsed ? 'false' : 'true'}" title="${attr(collapsed ? `Expand ${title}` : `Collapse ${title}`)}" class="relative flex min-h-6 w-full min-w-0 items-center gap-2 ${align} text-xs font-semibold uppercase tracking-wide text-gray-500 transition hover:text-gray-200">
                ${isProvider ? `${countPill}<span class="min-w-0 truncate">${text(title)}</span>` : `${port}<span class="min-w-0 truncate">${text(title)}</span>${countPill}`}
                ${isProvider ? port : ''}
            </button>`;
    }

    function providerCapabilityGroup(domain, title, items, type) {
        const collapsed = isGraphGroupCollapsed(domain, 'provider', 'all', type);
        return `
            <div class="grid gap-2 border-t border-gray-800/70 pt-3" data-graph-provider-group="${attr(type)}" data-graph-group-collapsed="${collapsed ? 'true' : 'false'}" data-graph-focus-kind="provider-group" data-graph-focus-type="${attr(type)}">
                ${graphGroupButton(domain, 'provider', 'all', title, type, items.length, collapsed)}
                ${collapsed ? '' : `<div class="grid gap-2">${items.map(item => `<div class="relative flex min-h-5 min-w-0 items-center justify-end pr-0 text-right text-sm text-gray-200" data-capability-node="${attr(type)}:${attr(item)}" data-graph-provider-endpoint-row="true"><span class="min-w-0 truncate" data-graph-focus-kind="provider-endpoint" data-graph-focus-type="${attr(type)}" data-graph-focus-label="${attr(item)}" data-graph-provider-focus="endpoint">${text(item)}</span><span class="absolute -right-[1.4375rem] top-1/2 -translate-y-1/2" data-graph-focus-kind="provider-endpoint" data-graph-focus-type="${attr(type)}" data-graph-focus-label="${attr(item)}" data-graph-provider-focus="endpoint">${endpointIcon(type, endpointKey(type, item))}</span></div>`).join('') || '<div class="text-right text-sm text-gray-500">None declared</div>'}</div>`}
            </div>`;
    }

    function ownerDescription(domain, participant, review) {
        const explicit = String(participant && (participant.description || participant.summary) || '').replace(/\s+/g, ' ').trim();
        if (explicit) return explicit;
        const participantId = participant && participant.pluginId ? participant.pluginId : '';
        if (!participantId || participantId === 'No owner/provider') return `No owner is currently registered for the ${domain} domain.`;
        if (participantId === 'core' && review && review.summary) return review.summary;
        if (hasRole(participant, 'owner')) return `Owns the ${domain} capability contract and exposes its provider endpoints.`;
        if (hasRole(participant, 'provider')) return `Provides endpoints for the ${domain} capability domain.`;
        return `Participates in the ${domain} capability domain.`;
    }

    function providerPanel(domain, participants, commands, operations, events, review) {
        const ownerEntries = participants.length ? participants : [{ pluginId: 'No owner/provider', roles: [] }];
        return `
            <div class="relative flex h-full flex-col gap-3 rounded-lg border border-gray-800 bg-dark-900/40 p-4 lg:w-96 lg:max-w-96 lg:flex-none" data-domain-provider-card="true">
                    ${ownerEntries.map(participant => `
                        <div data-domain-owner-name="${attr(participant.pluginId || 'unknown')}">
                            <div class="flex items-center justify-between gap-3">
                                <div class="min-w-0 truncate text-lg font-semibold text-white">${text(participant.pluginId || 'unknown')}</div>
                                <div class="flex shrink-0 items-center justify-end gap-1">${ownerHeaderIcons(participant)}</div>
                            </div>
                        </div>`).join('')}
                    ${operations.length ? providerCapabilityGroup(domain, 'Operations', operations, 'operation') : ''}
                    ${commands.length ? providerCapabilityGroup(domain, 'Commands', commands, 'command') : ''}
                    ${events.length ? providerCapabilityGroup(domain, 'Events', events, 'event') : ''}
                    ${commands.length || operations.length || events.length ? '' : '<div class="border-t border-gray-800/70 pt-3 text-right text-sm text-gray-500">No endpoints declared.</div>'}
                    <div class="mt-auto border-t border-gray-800/70 pt-3 text-right" data-domain-owner-footer="true">
                        ${ownerEntries.map(participant => `<div data-domain-owner-description="${attr(participant.pluginId || 'unknown')}" class="text-sm leading-5 text-gray-400">${text(ownerDescription(domain, participant, review))}</div>`).join('')}
                    </div>
            </div>`;
    }

    function participantEndpointGroup(domain, participant, uses, index, shims, title, type) {
        const items = type === 'operation' ? uses.operations : (type === 'command' ? uses.commands : uses.events);
        if (!items.length) return '';
        const collapsed = isGraphGroupCollapsed(domain, 'participant', index, type);
        const flow = graphLinkFlow(participant, type);
        return `
            <div class="grid gap-2 border-t border-gray-800/70 pt-3 first:border-t-0 first:pt-0" data-graph-participant-group="${index}:${attr(type)}" data-graph-group-collapsed="${collapsed ? 'true' : 'false'}" data-graph-focus-kind="participant-group" data-graph-focus-participant-index="${attr(index)}" data-graph-focus-type="${attr(type)}">
            ${graphGroupButton(domain, 'participant', index, title, type, items.length, collapsed, flow)}
            ${collapsed ? '' : `<div class="grid gap-2">${items.map(item => `<div class="relative flex min-h-5 min-w-0 items-center pl-0 text-sm text-gray-300" data-graph-participant-endpoint-row="true"><span class="absolute -left-[1.4375rem] top-1/2 -translate-y-1/2" data-graph-focus-kind="participant-endpoint" data-graph-focus-participant-index="${attr(index)}" data-graph-focus-type="${attr(type)}" data-graph-focus-label="${attr(item)}">${endpointIcon(type, participantEndpointKey(index, type, item), participantEndpointKind(participant, type, item, shims), flow)}</span><span class="min-w-0 truncate" data-graph-focus-kind="participant-endpoint" data-graph-focus-participant-index="${attr(index)}" data-graph-focus-type="${attr(type)}" data-graph-focus-label="${attr(item)}">${text(item)}</span></div>`).join('')}</div>`}
            </div>`;
    }

    function participantGraphCard(domain, participant, uses, index, shims) {
        const groupMarkup = [
            participantEndpointGroup(domain, participant, uses, index, shims, 'Operations', 'operation'),
            participantEndpointGroup(domain, participant, uses, index, shims, 'Commands', 'command'),
            participantEndpointGroup(domain, participant, uses, index, shims, 'Events', 'event'),
        ].filter(Boolean).join('');
        const primaryRoleIcon = providerRoleIcon(participant);
        return `
            <div class="relative rounded-lg border border-gray-800 bg-dark-900/40 p-4 transition hover:border-accent/50" data-domain-participant-card="${attr(participant.pluginId)}" data-participant-index="${index}" data-graph-hover-participant="${index}" title="${attr(participantTooltip(participant))}">
                <div class="flex items-center gap-3">
                    ${primaryRoleIcon}
                    <div class="min-w-0 flex-1 truncate text-lg font-semibold text-white">${text(participant.pluginId)}</div>
                    <div class="flex shrink-0 items-center justify-end gap-1">${participantOriginIcon(participant)}${availabilityBadge(participant.availability)}</div>
                </div>
                <div class="mt-3 grid gap-3 border-t border-gray-800/70 pt-3">
                    ${groupMarkup || '<div class="text-sm text-gray-500">No command, operation, or event usage declared.</div>'}
                </div>
            </div>`;
    }

    function domainGraphLinks(capabilities, participants, shims, expectedShims) {
        const commandOffset = capabilities.operations.length;
        const eventOffset = capabilities.operations.length + capabilities.commands.length;
        const operationIndex = new Map(capabilities.operations.map((item, index) => [item, index]));
        const commandIndex = new Map(capabilities.commands.map((item, index) => [item, commandOffset + index]));
        const eventIndex = new Map(capabilities.events.map((item, index) => [item, eventOffset + index]));
        const nodeCount = Math.max(1, capabilities.commands.length + capabilities.operations.length + capabilities.events.length);
        const participantCount = Math.max(1, participants.length);
        const shimmedBySource = shimmedEndpointsBySource(shims);
        const links = [];
        participants.forEach((participant, participantIndex) => {
            const uses = participantUses(participant, shims, expectedShims);
            const shimmedEndpoints = shimmedBySource.get(participant && participant.pluginId) || new Set();
            for (const item of uses.commands) {
                const linkType = participant && (participant._shimOnly || shimmedEndpoints.has(endpointKey('command', item))) ? 'shimmed' : 'observed';
                if (commandIndex.has(item)) links.push({ type: linkType, flow: graphLinkFlow(participant, 'command'), capabilityIndex: commandIndex.get(item), participantIndex, participantId: participant && participant.pluginId || '', label: item, sourceLabel: item, endpointType: 'command' });
            }
            for (const item of uses.operations) {
                const linkType = participant && (participant._shimOnly || shimmedEndpoints.has(endpointKey('operation', item))) ? 'shimmed' : 'observed';
                if (operationIndex.has(item)) links.push({ type: linkType, flow: graphLinkFlow(participant, 'operation'), capabilityIndex: operationIndex.get(item), participantIndex, participantId: participant && participant.pluginId || '', label: item, sourceLabel: item, endpointType: 'operation' });
            }
            for (const item of uses.events) {
                const exact = eventIndex.has(item) ? item : Array.from(eventIndex.keys()).find(event => event.endsWith('*') && item.startsWith(event.slice(0, -1)));
                const linkType = participant && (participant._shimOnly || shimmedEndpoints.has(endpointKey('event', item))) ? 'shimmed' : 'observed';
                if (exact) links.push({ type: linkType, flow: graphLinkFlow(participant, 'event'), capabilityIndex: eventIndex.get(exact), participantIndex, participantId: participant && participant.pluginId || '', label: item, sourceLabel: exact, endpointType: 'event' });
            }
        });
        return { links, nodeCount, participantCount };
    }

    function domainGraphSvg(linkData) {
        const yForCapability = index => 12 + (index + 0.5) * (76 / linkData.nodeCount);
        const yForParticipant = index => 14 + (index + 0.5) * (72 / linkData.participantCount);
        const paths = linkData.links.map(link => {
            const y1 = yForCapability(link.capabilityIndex);
            const y2 = yForParticipant(link.participantIndex);
            const color = graphLinkColor(link.flow || link.endpointType);
            const dash = link.type === 'shimmed' ? ' stroke-dasharray="4 4"' : '';
            return `<path data-link-kind="${attr(link.type)}" data-link-flow="${attr(link.flow || link.endpointType)}" d="M 42 ${y1.toFixed(2)} C 52 ${y1.toFixed(2)}, 58 ${y2.toFixed(2)}, 68 ${y2.toFixed(2)}" fill="none" stroke="${color}" stroke-width="1.4" opacity="0.82"${dash}><title>${text(graphLinkTitle(link))}: ${text(link.label)}</title></path>`;
        }).join('');
        return `<svg class="pointer-events-none absolute inset-0 hidden h-full w-full lg:block" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>`;
    }

    function domainGraphView(pipeline, shims, expectedShims, options = {}) {
        const model = graphModel(pipeline, shims, expectedShims);
        const { providers, users, commands, operations, events, linkData } = model;
        const visibleUses = participantUsesByLinkData(users, linkData);
        const visibleParticipants = visibleGraphParticipants(users, visibleUses);
        const { participantTotal, capabilityTotal, observed, shimmed } = graphHeaderSummary(model);
        const status = compatibilityState(pipeline.conflicts || []);
        const review = reviewInfo(pipeline);
        const linkMetadata = linkData.links.map(link => `<span data-link-kind="${attr(link.type)}" data-link-flow="${attr(link.flow || link.endpointType)}" data-link-participant="${attr(link.participantId || '')}">${text(link.label)}</span>`).join('');
        const collapsible = !!options.collapsible;
        const expanded = collapsible ? isDomainExpanded(pipeline.name, !!options.defaultExpanded) : true;
        const ids = graphDomIds(pipeline.name);
        const actionLabel = `${expanded ? 'Collapse' : 'Expand'} ${pipeline.name} domain graph`;
        const statusIcon = status.tone === 'conflict' ? 'alert' : (status.tone === 'warning' ? 'shieldAlert' : 'shield');
        const domainIcon = domainIconName(pipeline.name, review);
        const titleMarkup = collapsible
            ? `<h3 class="text-lg font-semibold text-white"><button type="button" data-toggle-domain="${attr(pipeline.name)}" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${attr(ids.panelId)}" aria-label="${attr(actionLabel)}" title="${attr(actionLabel)}" class="group inline-flex max-w-full items-center gap-2 rounded text-left transition hover:text-accent-light focus:outline-none focus:ring-2 focus:ring-accent/60"><span class="min-w-0 break-all font-bold">${text(pipeline.name)}</span><span class="shrink-0 text-gray-500 transition group-hover:text-accent-light">${iconSvg(expanded ? 'chevronDown' : 'chevronRight', 'h-4 w-4')}</span></button></h3>`
            : `<h3 class="text-lg font-semibold text-white"><span class="font-bold">${text(pipeline.name)}</span></h3>`;
        return `
            <section class="rounded-lg border border-gray-800 bg-dark-800/55 p-4" data-domain-graph="${attr(pipeline.name)}" data-domain-graph-expanded="${expanded ? 'true' : 'false'}">
                <div class="${expanded ? 'mb-4 ' : ''}flex flex-wrap items-center justify-between gap-4">
                    <div class="flex items-center gap-3">
                        <span class="inline-flex h-9 w-9 items-center justify-center rounded-full bg-purple-500/20 text-purple-200" title="${attr(pipeline.name)} domain" aria-label="${attr(pipeline.name)} domain" role="img">${iconSvg(domainIcon, 'h-5 w-5')}</span>
                        ${titleMarkup}
                    </div>
                    <div class="flex flex-wrap items-center justify-end gap-2">
                        ${compactIconBadge('users', participantTotal, `${participantTotal} participant${participantTotal === 1 ? '' : 's'}`, 'muted')}
                        ${compactIconBadge('box', capabilityTotal, `${capabilityTotal} capability endpoint${capabilityTotal === 1 ? '' : 's'}`, 'muted')}
                        ${compactIconBadge('eye', observed, `${observed} observed link${observed === 1 ? '' : 's'}`, observed ? 'observed' : 'muted')}
                        ${compactIconBadge('plug', shimmed, `${shimmed} shimmed link${shimmed === 1 ? '' : 's'}`, shimmed ? 'used' : 'muted')}
                        ${compactIconBadge(statusIcon, '', `Domain status: ${status.label}`, status.tone)}
                    </div>
                </div>
                ${expanded ? `<div id="${attr(ids.panelId)}" data-domain-graph-panel="${attr(pipeline.name)}">
                <div id="${attr(ids.frameId)}" data-domain-graph-frame="${attr(pipeline.name)}" class="relative overflow-hidden rounded-lg border border-gray-800 bg-dark-900/25 p-4">
                    <div id="${attr(ids.cyId)}" data-domain-graph-cy="${attr(pipeline.name)}" class="pointer-events-none absolute inset-0 z-20 hidden lg:block" aria-hidden="true"></div>
                    <div id="${attr(ids.fallbackId)}" data-domain-graph-fallback="${attr(pipeline.name)}" class="relative z-10 grid gap-10 lg:flex lg:items-stretch lg:justify-between lg:gap-16 xl:gap-24" data-graph-lanes="${attr(pipeline.name)}">
                        <div class="hidden" data-graph-link-metadata>${linkMetadata}</div>
                        ${providerPanel(pipeline.name, providers, commands, operations, events, review)}
                        <div class="grid gap-3 lg:w-96 lg:max-w-96 lg:flex-none" data-domain-participant-lane="true">
                            ${visibleParticipants.map(entry => participantGraphCard(pipeline.name, entry.participant, entry.uses, entry.index, shims)).join('') || '<div class="rounded-lg border border-gray-800 bg-dark-900/40 p-4 text-sm text-gray-500">No participants are using this capability.</div>'}
                        </div>
                    </div>
                </div>
                <div class="mt-3 grid gap-2 rounded-lg border border-gray-800 bg-dark-900/30 px-3 py-2 text-xs text-gray-400">
                    <div class="flex flex-wrap items-center justify-end gap-2" data-domain-graph-filter-row="${attr(pipeline.name)}">
                        <span class="text-gray-500">Show:</span>${graphFilterButton('all', 'All')}${graphFilterButton('operations', 'Operations')}${graphFilterButton('commands', 'Commands')}${graphFilterButton('events', 'Events')}${graphFilterButton('shimmed', 'Shimmed')}
                    </div>
                    <div class="flex flex-wrap items-center gap-4 border-t border-gray-800 pt-2">
                        <span class="font-semibold text-gray-300">Legend</span>
                        <span class="flex items-center gap-2">${OPERATION_ICON}Operation</span>
                        <span class="flex items-center gap-2">${COMMAND_ICON}Command</span>
                        <span class="flex items-center gap-2">${EVENT_ICON}Event</span>
                        <span data-legend-line="operation" class="inline-flex h-px w-8 bg-purple-400"></span><span>Operation link</span>
                        ${PROVIDER_OPERATION_LINK}<span>Provider operation link</span>
                        <span data-legend-line="command" class="inline-flex h-px w-8 bg-orange-400"></span><span>Command link</span>
                        ${PROVIDER_COMMAND_LINK}<span>Provider command link</span>
                        <span data-legend-line="event" class="inline-flex h-px w-8 bg-blue-400"></span><span>Event link</span>
                        ${PROVIDER_EVENT_LINK}<span>Provider event link</span>
                        <span data-legend-line="shimmed" class="inline-flex h-px w-8 border-t border-dashed border-gray-400"></span><span>Shimmed link</span>
                    </div>
                </div>
                </div>` : ''}
            </section>`;
    }

    function pipelineCard(pipeline, shimsByCapability, expectedShimsByCapability, options = {}) {
        const shims = (shimsByCapability && shimsByCapability.get(pipeline.name)) || [];
        const expectedShims = (expectedShimsByCapability && expectedShimsByCapability.get(pipeline.name)) || [];
        return domainGraphView(pipeline, shims, expectedShims, { collapsible: true, defaultExpanded: !!options.defaultExpanded });
    }

    function pipelineGroupSection(entry, shimsByCapability, expectedShimsByCapability, options = {}) {
        const pipelines = entry.pipelines || [];
        const domainCount = pipelines.length;
        return `
            <section class="grid gap-3">
                <div class="flex flex-wrap items-end justify-between gap-3 border-b border-gray-800 pb-2">
                    <div>
                        <div class="h-4" aria-hidden="true"></div>
                        <h3 class="mt-1 text-lg font-semibold text-white">${text(entry.group.label)}</h3>
                        <p class="mt-1 text-xs text-gray-500">${text(entry.group.summary)}</p>
                    </div>
                    ${pill(`${domainCount} domain${domainCount === 1 ? '' : 's'}`, 'muted')}
                </div>
                ${pipelines.map(pipeline => pipelineCard(pipeline, shimsByCapability, expectedShimsByCapability, options)).join('')}
            </section>`;
    }

    function summaryDashboard(data, pipelines, compatibilityShims) {
        const participants = Array.isArray(data.participants) ? data.participants : [];
        const conflicts = pipelines.reduce((sum, pipeline) => sum + ((pipeline.conflicts || []).length), 0);
        const warnings = (Array.isArray(data.missingProviders) ? data.missingProviders.length : 0)
            + (Array.isArray(data.unsupportedVersions) ? data.unsupportedVersions.length : 0);
        const shimHits = totalShimHits(compatibilityShims);
        const status = conflicts ? { label: 'Conflicts', tone: 'conflict' } : (warnings ? { label: 'Warnings', tone: 'warning' } : { label: 'Clean', tone: 'clean' });
        return `
            <div class="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4" data-summary-dashboard>
                ${metricCard('Domains', pipelines.length, 'muted')}
                ${metricCard('Participants', participants.length, 'muted')}
                ${metricCard(shimHits === 1 ? 'Shim hit' : 'Shim hits', shimHits, shimHits > 0 ? 'used' : 'muted')}
                <div class="rounded-lg border ${status.tone === 'clean' ? 'border-emerald-800/60 bg-emerald-500/5' : (status.tone === 'warning' ? 'border-amber-800/60 bg-amber-500/5' : 'border-red-800/70 bg-red-500/5')} px-3 py-2" data-summary-card="status" data-tone="${attr(status.tone)}">
                    <div data-summary-row>
                        <span class="text-[11px] uppercase tracking-wide text-gray-500" data-summary-label>Status</span>
                        <span data-summary-status-value data-tone="${attr(status.tone)}">${text(status.label)}</span>
                    </div>
                </div>
            </div>`;
    }

    function audioSessionSnapshot() {
        const api = window.feedBack && window.feedBack.audioSession;
        if (!api || typeof api.snapshot !== 'function') return null;
        try { return api.snapshot(); }
        catch (_) { return null; }
    }

    function playbackSnapshot() {
        const api = window.feedBack && window.feedBack.playback;
        if (!api || typeof api.snapshot !== 'function') return null;
        try { return api.snapshot({ exportMode: 'local-inspector' }); }
        catch (_) { return null; }
    }

    function playbackSupportPanel(playbackData) {
        if (!playbackData || !playbackData.state) return '';
        const state = playbackData.state || {};
        const session = state.sessionId || 'unknown';
        const target = state.target || {};
        const display = target.localDisplay || {};
        const media = state.media || {};
        const route = state.route || media.route || {};
        const loop = state.loop || media.loop || {};
        const participants = Array.isArray(playbackData.participants) ? playbackData.participants : [];
        const bridges = Array.isArray(playbackData.bridges) ? playbackData.bridges : [];
        const recentOutcomes = playbackData.history && playbackData.history.current && Array.isArray(playbackData.history.current.recentOutcomes)
            ? playbackData.history.current.recentOutcomes.slice(-6) : [];
        const recentEvents = playbackData.history && playbackData.history.current && Array.isArray(playbackData.history.current.lifecycleEvents)
            ? playbackData.history.current.lifecycleEvents.slice(-6) : [];
        const bridgeHits = bridges.reduce((sum, bridge) => sum + Number(bridge.hitCount || 0), 0);
        const label = [display.title, display.artist].filter(Boolean).join(' - ') || target.targetId || 'none';
        const timeLabel = media.currentTime == null ? 'unknown' : `${Number(media.currentTime).toFixed(2)}s`;
        const durationLabel = media.duration == null ? 'unknown' : `${Number(media.duration).toFixed(2)}s`;
        return `<section class="mb-4 rounded-lg border border-gray-800 bg-dark-900/40 p-4" data-playback-support>
            <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h3 class="text-sm font-semibold text-white">Playback</h3>
                    <p class="mt-1 text-xs text-gray-500">Transport session, route, loop, requester, bridge, and recent outcome state from the playback host.</p>
                </div>
                <div class="flex flex-wrap gap-2">
                    ${pill(`state: ${state.state || 'unknown'}`, state.state === 'playing' || state.state === 'ready' ? 'clean' : (state.state === 'failed' || state.state === 'unavailable' ? 'conflict' : 'muted'))}
                    ${pill(`route: ${route.routeKind || 'unknown'}`, route.state === 'active' ? 'clean' : (route.state === 'degraded' ? 'warning' : 'muted'))}
                    ${pill(loop && loop.enabled ? 'loop: active' : 'loop: inactive', loop && loop.enabled ? 'used' : 'muted')}
                    ${pill(`${participants.length} participant${participants.length === 1 ? '' : 's'}`, participants.length ? 'info' : 'muted')}
                    ${pill(`${bridgeHits} bridge hit${bridgeHits === 1 ? '' : 's'}`, bridgeHits ? 'used' : 'muted')}
                </div>
            </div>
            <div class="mt-3 grid gap-2 text-xs text-gray-400 md:grid-cols-2">
                <div data-playback-session>Session: ${text(session)}</div>
                <div data-playback-target>Target: ${text(label)}</div>
                <div data-playback-time>Time: ${text(timeLabel)} / ${text(durationLabel)}</div>
                <div data-playback-loop>Loop: ${loop && loop.enabled ? `${text(loop.startTime)}-${text(loop.endTime)} (${text(loop.state || 'active')})` : 'none'}</div>
                <div data-playback-route>Route: ${text(route.routeKind || 'unknown')} (${text(route.state || 'unknown')})${route.safeReason ? ` - ${text(route.safeReason)}` : ''}</div>
                <div data-playback-participants>Participants: ${participants.map(participant => text(participant.requesterId || participant.observerId || participant.role || 'unknown')).join(', ') || 'none'}</div>
                <div data-playback-bridges>Bridges: ${bridges.map(bridge => `${text(bridge.bridgeId)}:${text(bridge.hitCount || 0)}`).join(', ') || 'none'}</div>
                <div data-playback-outcomes>Outcomes: ${recentOutcomes.map(outcome => `${text(outcome.operation)}:${text(outcome.status || outcome.outcome)}`).join(', ') || 'none'}</div>
                <div data-playback-events class="md:col-span-2">Events: ${recentEvents.map(event => `${text(event.event)}:${text(event.state)}`).join(', ') || 'none'}</div>
            </div>
        </section>`;
    }

    function audioDomainSupportPanel(audioData) {
        if (!audioData || !audioData.domains) return '';
        const mix = audioData.domains['audio-mix'] || {};
        const route = mix.route || (audioData.session && audioData.session.route) || {};
        const analyser = mix.analyser || (audioData.session && audioData.session.analyser) || {};
        const input = audioData.domains['audio-input'] || {};
        const monitoring = audioData.domains['audio-monitoring'] || {};
        const stems = audioData.domains['stems'] || {};
        const participants = Array.isArray(mix.participants) ? mix.participants : [];
        const sources = Array.isArray(input.sources) ? input.sources : [];
        const selectedInput = input.selected || null;
        const openInputSessions = Array.isArray(input.openSessions) ? input.openSessions : [];
        const monitoringProviders = Array.isArray(monitoring.providers) ? monitoring.providers : [];
        const selectedMonitoringProvider = monitoring.selectedProvider || null;
        const monitoringSessions = Array.isArray(monitoring.sessions) ? monitoring.sessions : [];
        const monitoringBridges = Array.isArray(monitoring.bridges) ? monitoring.bridges : [];
        const inputBridges = Array.isArray(input.bridges) ? input.bridges : [];
        const bridges = [
            ...(Array.isArray(mix.bridges) ? mix.bridges : []),
            ...inputBridges,
            ...monitoringBridges,
            ...(Array.isArray(stems.bridges) ? stems.bridges : []),
        ];
        const bridgeHits = bridges.reduce((sum, bridge) => sum + Number(bridge.hitCount || 0), 0);
        const faders = Array.isArray(mix.faders) ? mix.faders : [];
        const failedOutcomes = (Array.isArray(audioData.recentOutcomes) ? audioData.recentOutcomes : [])
            .filter(outcome => outcome && (outcome.domain === 'audio-mix' || outcome.domain === 'audio-input' || outcome.domain === 'audio-monitoring') && (outcome.outcome === 'failed' || outcome.outcome === 'denied' || outcome.outcome === 'degraded' || outcome.outcome === 'unavailable' || outcome.outcome === 'provider-selection-required' || outcome.status === 'timeout'))
            .slice(-5);
        const claims = Array.isArray(stems.claims) ? stems.claims : [];
        const owner = stems.owner || null;
        return `<section class="mb-4 rounded-lg border border-gray-800 bg-dark-900/40 p-4" data-audio-session-support>
            <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h3 class="text-sm font-semibold text-white">Audio session</h3>
                    <p class="mt-1 text-xs text-gray-500">Route, mix participants, stem owner, claims, and bridge hits from the active session host.</p>
                </div>
                <div class="flex flex-wrap gap-2">
                    ${pill(`route: ${route.routeKind || 'unknown'}`, route.availability === 'available' ? 'clean' : 'warning')}
                    ${pill(`${participants.length} mix participant${participants.length === 1 ? '' : 's'}`, participants.length ? 'info' : 'muted')}
                    ${pill(`${faders.length} fader${faders.length === 1 ? '' : 's'}`, faders.length ? 'info' : 'muted')}
                    ${pill(`${input.totalSources ?? sources.length} input source${(input.totalSources ?? sources.length) === 1 ? '' : 's'}`, sources.length ? 'info' : 'muted')}
                    ${pill(`${input.totalOpenSessions ?? openInputSessions.length} open input${(input.totalOpenSessions ?? openInputSessions.length) === 1 ? '' : 's'}`, openInputSessions.length ? 'used' : 'muted')}
                    ${pill(`${monitoring.totalProviders ?? monitoringProviders.length} monitor provider${(monitoring.totalProviders ?? monitoringProviders.length) === 1 ? '' : 's'}`, monitoringProviders.length ? 'info' : 'muted')}
                    ${pill(`${monitoring.totalSessions ?? monitoringSessions.length} monitor${(monitoring.totalSessions ?? monitoringSessions.length) === 1 ? '' : 's'}`, monitoringSessions.length ? 'info' : 'muted')}
                    ${pill(owner ? `stems: ${owner.ownerId}` : 'stems: no owner', owner ? 'clean' : 'muted')}
                    ${pill(`${claims.length} claim${claims.length === 1 ? '' : 's'}`, claims.length ? 'used' : 'muted')}
                    ${pill(`${bridgeHits} bridge hit${bridgeHits === 1 ? '' : 's'}`, bridges.length ? 'used' : 'muted')}
                </div>
            </div>
            <div class="mt-3 grid gap-2 text-xs text-gray-400 md:grid-cols-2">
                <div data-audio-session-route>Route: ${text(route.routeKind || 'unknown')} (${text(route.availability || 'unknown')})</div>
                <div data-audio-session-analyser>Analyser: ${text(analyser.source || 'unavailable')} (${text(analyser.availability || 'unavailable')})</div>
                <div data-audio-session-faders>Faders: ${faders.map(fader => `${text(fader.label || fader.faderLabel || fader.participantId)}:${text(fader.availability || 'unknown')}:${text(fader.sourceMode || 'native')}${fader.lastRejectedValue != null ? ':failed' : ''}`).join(', ') || 'none'}</div>
                <div data-audio-session-input>Input: ${sources.map(s => `${text(s.label || s.sourceId || s.kind)}:${text(s.availability || 'unknown')}:${text(s.channelSummary && s.channelSummary.channelShape ? s.channelSummary.channelShape : s.channelShape || 'unknown')}:${text(s.sourceMode || 'native')}${s.supersededBy ? ':superseded' : ''}`).join(', ') || 'none'}</div>
                <div data-audio-session-selected-input>Selected input: ${selectedInput ? `${text(selectedInput.logicalSourceKey || selectedInput.sourceId || 'selected')}:${text(selectedInput.availability || 'unknown')}:${text(selectedInput.restoreStatus || 'unknown')}` : 'none'}</div>
                <div data-audio-session-open-input>Open input: ${openInputSessions.map(s => `${text(s.openSessionId)}:${text(s.channelShape || 'unknown')}:${text(s.state || 'unknown')}:${text((s.requesters || []).map(r => r.requesterId).join('+'))}`).join(', ') || 'none'}</div>
                <div data-audio-session-monitoring-providers>Monitoring providers: ${monitoringProviders.map(p => `${text(p.label || p.providerId)}:${text(p.availability || 'unknown')}:${text(p.sourceMode || 'native')}${p.supersededBy ? ':superseded' : ''}`).join(', ') || 'none'}</div>
                <div data-audio-session-selected-monitoring>Selected monitoring: ${selectedMonitoringProvider ? `${text(selectedMonitoringProvider.logicalMonitoringKey || selectedMonitoringProvider.providerId || 'selected')}:${text(selectedMonitoringProvider.availability || 'unknown')}:${text(selectedMonitoringProvider.providerId || 'unknown')}` : 'none'}</div>
                <div data-audio-session-monitoring>Monitoring: ${monitoringSessions.map(s => `${text(s.monitoringId)}:${text(s.state)}:${text((s.requesters || []).map(r => r.requesterId).join('+'))}:${text((s.sourceRef && (s.sourceRef.logicalSourceKey || s.sourceRef.sourceId)) || 'unknown')}`).join(', ') || 'none'}</div>
                <div data-audio-session-direct-monitor>Direct monitor: ${monitoring.directMonitor ? `${text(monitoring.directMonitor.state || monitoring.directMonitor.preference || 'unknown')}:${text(monitoring.directMonitor.control || 'unknown')}:${text(monitoring.directMonitor.applied === true ? 'applied' : (monitoring.directMonitor.applied === false ? 'not-applied' : 'unknown'))}` : 'unknown'}</div>
                <div data-audio-session-stems>Stem owner: ${text(owner && owner.ownerId ? owner.ownerId : 'none')}</div>
                <div data-audio-session-participants>Participants: ${participants.map(p => text(p.label || p.participantId)).join(', ') || 'none'}</div>
                <div data-audio-session-claims>Claims: ${claims.map(c => `${text(c.claimId)}:${text(c.state)}`).join(', ') || 'none'}</div>
                <div data-audio-session-bridges>Bridges: ${bridges.map(b => `${text(b.bridgeId)}:${text(b.outcome || 'handled')}${b.reason ? ` (${text(b.reason)})` : ''}`).join(', ') || 'none'}</div>
                <div data-audio-session-input-bridges>Input bridges: ${inputBridges.map(b => `${text(b.bridgeId)}:${text(b.status || b.outcome || 'handled')}`).join(', ') || 'none'}</div>
                <div data-audio-session-monitoring-bridges>Monitoring bridges: ${monitoringBridges.map(b => `${text(b.bridgeId)}:${text(b.status || b.outcome || 'handled')}`).join(', ') || 'none'}</div>
                <div data-audio-session-failures>Failures: ${failedOutcomes.map(outcome => `${text(outcome.domain)}:${text(outcome.operation)}:${text(outcome.faderId || outcome.monitoringId || outcome.sourceId || outcome.logicalSourceKey || outcome.participantId || outcome.requesterId)}:${text(outcome.status || outcome.outcome)}`).join(', ') || 'none'}</div>
            </div>
        </section>`;
    }

    function syncFilterOptions(filter, pipelines) {
        if (!filter) return '';
        const names = sortPipelines(pipelines).map(pipeline => pipeline && pipeline.name).filter(Boolean);
        const current = names.includes(filter.value) ? filter.value : '';
        const options = groupedPipelines(pipelines).map(entry => (
            `<optgroup label="${attr(entry.group.label)}">${entry.pipelines.map(pipeline => `<option value="${attr(pipeline.name)}" ${pipeline.name === current ? 'selected' : ''}>${text(pipeline.name)}</option>`).join('')}</optgroup>`
        )).join('');
        filter.innerHTML = `<option value="">All domains</option>${options}`;
        filter.value = current;
        return current;
    }

    function render() {
        const filter = document.getElementById('capability-inspector-filter');
        const content = document.getElementById('capability-inspector-content');
        const empty = document.getElementById('capability-inspector-empty');
        const summary = document.getElementById('capability-inspector-summary');
        if (!content || !empty) return;
        const data = snapshot();
        if (!data || data.error) {
            content.innerHTML = '';
            empty.classList.remove('hidden');
            empty.textContent = data && data.error ? data.error : 'Capability runtime is loading...';
            if (summary) summary.textContent = '';
            return;
        }
        empty.classList.add('hidden');
        const pipelines = sortPipelines((Array.isArray(data.pipelines) ? data.pipelines : [])
            .filter(pipeline => pipeline && !DOCUMENTATION_ONLY_DOMAINS.has(pipeline.name)));
        const selected = syncFilterOptions(filter, pipelines);
        const visible = selected ? pipelines.filter(pipeline => pipeline.name === selected) : pipelines;
        const shimsByCapability = new Map();
        for (const shim of Array.isArray(data.compatibilityShims) ? data.compatibilityShims : []) {
            const capability = shim && shim.capability;
            if (!capability) continue;
            const list = shimsByCapability.get(capability) || [];
            list.push(shim);
            shimsByCapability.set(capability, list);
        }
        const expectedShimsByCapability = new Map();
        for (const shim of Array.isArray(data.expectedCompatibilityShims) ? data.expectedCompatibilityShims : []) {
            const capability = shim && shim.capability;
            if (!capability) continue;
            const list = expectedShimsByCapability.get(capability) || [];
            list.push(shim);
            expectedShimsByCapability.set(capability, list);
        }
        const compatibilityShims = Array.isArray(data.compatibilityShims) ? data.compatibilityShims : [];
        if (summary) summary.innerHTML = summaryDashboard(data, pipelines, compatibilityShims);
        destroyActiveGraphs();
        const playbackPanel = playbackSupportPanel(playbackSnapshot());
        const audioPanel = audioDomainSupportPanel(audioSessionSnapshot());
        content.innerHTML = playbackPanel + audioPanel + (selected
            ? visible.map(pipeline => domainGraphView(pipeline, shimsByCapability.get(pipeline.name) || [], expectedShimsByCapability.get(pipeline.name) || [])).join('')
            : groupedPipelines(visible).map(entry => pipelineGroupSection(entry, shimsByCapability, expectedShimsByCapability, { defaultExpanded: false })).join(''))
            || '<div class="text-gray-500 text-sm">No capability domains registered.</div>';
        const graphPipelines = selected ? visible : visible.filter(pipeline => isDomainExpanded(pipeline.name, false));
        graphPipelines.forEach(pipeline => {
            mountDomainGraph(pipeline, shimsByCapability.get(pipeline.name) || [], expectedShimsByCapability.get(pipeline.name) || []);
        });
    }

    function scheduleRender() {
        if (renderScheduled) return;
        renderScheduled = true;
        const schedule = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : callback => setTimeout(callback, 0);
        schedule(() => {
            renderScheduled = false;
            render();
        });
    }

    function install() {
        const refresh = document.getElementById('capability-inspector-refresh');
        const filter = document.getElementById('capability-inspector-filter');
        if (refresh && !refresh.dataset.bound) {
            refresh.dataset.bound = '1';
            refresh.addEventListener('click', render);
        }
        if (filter && !filter.dataset.bound) {
            filter.dataset.bound = '1';
            filter.addEventListener('change', render);
        }
        const content = document.getElementById('capability-inspector-content');
        if (content && !content.dataset.bound) {
            content.dataset.bound = '1';
            content.addEventListener('change', (event) => {
                const target = event.target;
                if (!target || !target.dataset || !target.dataset.surfaceFilter) return;
                state.surfaceFilters = state.surfaceFilters || {};
                state.surfaceFilters[target.dataset.surfaceFilter] = target.value || 'all';
                render();
            });
            content.addEventListener('click', (event) => {
                const graphFilter = event.target && event.target.closest && event.target.closest('[data-domain-graph-filter]');
                if (graphFilter) {
                    const value = graphFilter.dataset.domainGraphFilter || 'all';
                    state.domainGraphFilter = GRAPH_FILTERS.has(value) ? value : 'all';
                    render();
                    return;
                }
                const graphGroup = event.target && event.target.closest && event.target.closest('[data-toggle-graph-group]');
                if (graphGroup) {
                    const key = graphGroup.dataset.toggleGraphGroup || '';
                    if (key) {
                        const groups = graphCollapsedGroups();
                        if (graphGroup.dataset.graphGroupCollapsed === 'true') delete groups[key];
                        else groups[key] = true;
                        render();
                    }
                    return;
                }
                const toggle = event.target && event.target.closest && event.target.closest('[data-toggle-domain]');
                if (toggle) {
                    const domain = toggle.dataset.toggleDomain || '';
                    const expanded = expandedDomains();
                    const isOpen = toggle.getAttribute && toggle.getAttribute('aria-expanded') === 'true';
                    expanded[domain] = !isOpen;
                    render();
                    return;
                }
                const button = event.target && event.target.closest && event.target.closest('[data-copy-surface]');
                if (!button) return;
                const value = button.dataset.copySurface || '';
                const original = button.textContent;
                const done = () => {
                    button.textContent = 'Copied';
                    setTimeout(() => { button.textContent = original || 'Copy'; }, 1000);
                };
                const clipboard = window.navigator && window.navigator.clipboard;
                if (clipboard && typeof clipboard.writeText === 'function') {
                    clipboard.writeText(value).then(done, done);
                } else {
                    done();
                }
            });
            content.addEventListener('mouseover', (event) => {
                const target = event.target && event.target.closest && (event.target.closest('[data-graph-focus-kind]') || event.target.closest('[data-graph-hover-participant]'));
                if (!target) return;
                if (event.relatedTarget && target.contains && target.contains(event.relatedTarget)) return;
                applyGraphHover(graphHoverFromElement(target));
            });
            content.addEventListener('mouseout', (event) => {
                const target = event.target && event.target.closest && (event.target.closest('[data-graph-focus-kind]') || event.target.closest('[data-graph-hover-participant]'));
                if (!target) return;
                if (event.relatedTarget && target.contains && target.contains(event.relatedTarget)) return;
                const relatedTarget = event.relatedTarget && event.relatedTarget.closest && (event.relatedTarget.closest('[data-graph-focus-kind]') || event.relatedTarget.closest('[data-graph-hover-participant]'));
                applyGraphHover(relatedTarget ? graphHoverFromElement(relatedTarget) : null);
            });
        }
        render();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
    else install();
    window.addEventListener('feedBack:capabilities:ready', render);
    window.addEventListener('feedBack:capabilities:changed', scheduleRender);
})();
