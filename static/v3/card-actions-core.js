/*
 * fee[dB]ack v0.3.0 — core library-card actions.
 *
 * Registers the built-in Edit-metadata and Retune-to-E-Standard actions
 * through the ui.library-card-injection capability, so core and plugin card
 * actions flow through one pipeline (the Songs grid renders whatever is
 * registered). These call the legacy globals (openEditModal / retuneSong)
 * exposed by app.js in the v3 shell — detection/playback stay on documented
 * globals (design/05). Re-running is a no-op: libraryCardActions.register()
 * rejects duplicate ids, so the first registration stands.
 */
(function () {
    'use strict';
    const sm = window.feedBack;
    if (!sm || !sm.libraryCardActions) return;

    const STD_RETUNABLE = ['Eb Standard', 'D Standard', 'C# Standard', 'C Standard'];
    const reg = sm.libraryCardActions;
    const hooks = window.__feedBackV3CoreCardActions || (window.__feedBackV3CoreCardActions = {});
    if (hooks.installed) return;
    hooks.installed = true;

    reg.register({
        id: 'core.edit-metadata',
        pluginId: 'core',
        label: 'Edit metadata',
        placement: 'menu',
        order: 10,
        applies: (song) => !!(song && song.filename),
        run: (song) => {
            if (typeof window.openEditModal !== 'function') return;
            window.openEditModal({
                f: song.filename, t: song.title || '', a: song.artist || '',
                al: song.album || '', y: song.year || '',
            }, null);
        },
    });

    reg.register({
        id: 'core.retune-estd',
        pluginId: 'core',
        label: 'Convert to E Standard',
        placement: 'menu',
        order: 20,
        applies: (song) => !!(song && song.filename && song.format !== 'sloppak'
            && song.tuning && !song.has_estd && STD_RETUNABLE.includes(song.tuning)),
        run: (song) => {
            if (typeof window.retuneSong !== 'function') return;
            window.retuneSong(song.filename, song.title || song.filename, song.tuning, 'E Standard');
        },
    });
})();
