# Audio mixer fader registration

Plugins that produce audio outside the song's `<audio>` element (NAM amp output, synth voices, etc.) can register a labeled fader so users can balance them against the song from one mixer popover in the player controls.

This is the slopsmith#87 contract.

## Registration

```js
function _registerFader() {
    const api = window.slopsmith && window.slopsmith.audio;
    if (!api) return;
    api.registerFader({
        id: 'my_plugin',           // unique key
        label: 'My Plugin',        // shown above the fader
        unit: 'dB',                // optional suffix shown next to the value (e.g. '%', 'dB')
        min: 0, max: 2, step: 0.05,
        defaultValue: 1.0,
        getValue: () => _myCurrentVolume,        // read current value
        setValue: (v) => _setMyVolume(v),         // write + persist + apply
    });
}

if (window.slopsmith && window.slopsmith.audio) {
    _registerFader();
} else {
    window.addEventListener('slopsmith:audio:ready', _registerFader, { once: true });
}
```

## Contract

- **Persistence is the plugin's responsibility.** The registry calls `getValue()` when the popover opens and after each `setValue()` during slider drags to re-sync the displayed value.
- **`getValue()` must be cheap and side-effect-free.**
- **`setValue()` must update whatever backing state `getValue()` reads synchronously** — pair it with whatever your plugin already does internally (write the GainNode, persist to `localStorage`, update any in-plugin label).
- **Use `unregisterFader(id)`** when your plugin is teardown-able and you want the strip to disappear; otherwise keep it registered so the user's setting persists across toggle states.

## Lifecycle event

`slopsmith:audio:ready` fires once on `window` when the audio mixer registry is ready. Guard registration against this event for plugins that load before the mixer.

## Related

- [PLUGIN_AUTHORING.md](PLUGIN_AUTHORING.md) — guide index
- [plugin-visualization-contracts.md](plugin-visualization-contracts.md) — visualization counterpart
