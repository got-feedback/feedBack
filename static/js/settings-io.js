// Settings backup — the export / import bundle.
//
// Carved verbatim out of static/app.js (R3a). A LEAF module: imports nothing.
//
// Two entry points, both inline handlers on the Settings screen, so app.js keeps
// re-exposing them on window. The import is two-phase (server first, atomic; then
// a best-effort localStorage merge) — the rationale comment below is the contract
// and moved with the code.

//
// Bundles server config + every localStorage key + opted-in plugin server
// files into a single JSON file.
//
// Apply semantics — phased, NOT all-or-nothing across the two stores:
//   1. Server first (/api/settings/import). Phase-1 validation guards
//      the whole bundle; phase-2 disk commit is per-file but ordered
//      so a mid-apply failure surfaces a `partial` field. A server
//      failure short-circuits before any localStorage write, so the
//      browser side stays untouched on validation refusals.
//   2. localStorage second, only after the server returns ok. Applied
//      as a MERGE (no clear): bundled keys overwrite, locally-present
//      keys absent from the bundle are preserved (so a plugin
//      installed after the export keeps its first-run defaults).
//      A localStorage exception here (quota / private mode) is
//      surfaced verbatim — server state is already committed and we
//      don't pretend the import was clean.
//
// In short: the server side is atomic in phase 1 and surface-partial in
// phase 2; the localStorage side is best-effort merge after server
// success. Failures are reported, never silenced.

export async function exportSettings() {
    const status = document.getElementById('backup-status');
    status.textContent = 'Exporting...';
    try {
        const resp = await fetch('/api/settings/export');
        if (!resp.ok) {
            status.textContent = `Export failed (HTTP ${resp.status})`;
            return;
        }
        const bundle = await resp.json();
        // Layer in the browser's localStorage. Use the standard Storage
        // iteration API (length + key(i)) rather than Object.keys —
        // Object.keys on a Storage instance is not deterministic across
        // browsers and can both miss entries and include non-entry
        // properties depending on the implementation. Keys are preserved
        // verbatim as strings; that's how localStorage stores them, and
        // round-trip fidelity matters more than re-typing values that
        // were never typed in the first place.
        const localStorageData = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key === null) continue;
            const value = localStorage.getItem(key);
            if (value !== null) localStorageData[key] = value;
        }
        bundle.local_storage = localStorageData;

        // Trigger download via blob + temporary <a download>. We honor the
        // server's Content-Disposition filename when present, otherwise
        // fall back to a date-stamped default.
        let filename = 'feedBack-settings.json';
        const disposition = resp.headers.get('Content-Disposition');
        if (disposition) {
            const match = /filename="([^"]+)"/.exec(disposition);
            if (match) filename = match[1];
        }
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        status.textContent = `Exported ${filename}`;
    } catch (e) {
        status.textContent = `Export failed: ${e.message}`;
    }
}

export async function importSettings(file) {
    if (!file) return;
    const status = document.getElementById('backup-status');
    if (!confirm('Import will overwrite settings present in the bundle (server config, browser preferences, and opted-in plugin data) and reload the page. Settings not in the bundle (e.g. from plugins installed after the export) are preserved. Continue?')) {
        status.textContent = 'Import cancelled';
        return;
    }
    let bundle;
    try {
        bundle = JSON.parse(await file.text());
    } catch (e) {
        status.textContent = `Import failed: not valid JSON (${e.message})`;
        return;
    }

    status.textContent = 'Importing...';
    let resp, data;
    try {
        resp = await fetch('/api/settings/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bundle),
        });
        data = await resp.json();
    } catch (e) {
        status.textContent = `Import failed: ${e.message}`;
        return;
    }
    // Two failure shapes to surface: our own validation handler
    // returns `{ok: false, error: "..."}`, but if the body fails
    // FastAPI's request-level validation (e.g. top-level value is
    // an array, not an object), the response is the framework's
    // `{detail: ...}` shape with no `ok` key. `resp.ok` distinguishes
    // both from success without depending on which path produced
    // the failure.
    if (!resp.ok || data.ok === false) {
        let msg = data.error;
        if (!msg && data.detail) {
            msg = typeof data.detail === 'string'
                ? data.detail
                : JSON.stringify(data.detail);
        }
        status.textContent = `Import failed: ${msg || `HTTP ${resp.status}`}`;
        return;
    }

    // Server applied successfully. Now apply the localStorage portion as
    // a MERGE (not clear+restore): keys in the bundle overwrite, keys
    // present locally but absent from the bundle are preserved. This
    // matters when a plugin was installed *after* the export — wiping
    // its localStorage would erase first-run defaults the plugin set on
    // load, leaving it in a worse state than before the import. The
    // tradeoff is that orphan keys from removed plugins or renamed key
    // schemes also linger; cleaning those up is the user's job.
    const ls = bundle.local_storage;
    if (ls && typeof ls === 'object') {
        try {
            for (const [key, value] of Object.entries(ls)) {
                if (typeof value === 'string') localStorage.setItem(key, value);
            }
        } catch (e) {
            // Quota exceeded / private mode etc. Server side already
            // committed, so we surface the partial state rather than
            // pretending it succeeded.
            status.textContent = `Server applied, but localStorage write failed: ${e.message}`;
            return;
        }
    }

    const warnings = (data.warnings || []).join('; ');
    status.textContent = warnings ? `Imported with warnings: ${warnings}. Reloading...` : 'Imported. Reloading...';
    setTimeout(() => location.reload(), 800);
}
