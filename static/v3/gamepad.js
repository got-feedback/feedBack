// Gamepad/controller support.
//
// Rather than a parallel gamepad->action mapping table, this polls
// navigator.getGamepads() and dispatches synthetic keydown events onto
// document with the same key/code pairs a physical keyboard would send.
// static/js/shortcuts.js's existing dispatcher (scope checks, text-field/
// modal guards, library grid nav, player shortcuts) handles the rest.
//
// Steam Deck: Steam Input re-emits the Deck's controls as a standard
// XInput-style virtual pad (both in Gaming Mode and in Desktop Mode when
// launched via a non-Steam shortcut with a controller template), so this
// reports mapping: 'standard' and the button layout below lines up with
// the Deck's physical ABXY. If a pad reports a non-standard mapping
// (e.g. raw HID with no Steam Input in between), this no-ops rather than
// guessing button order.
//
// Plain non-module script; degrades to a no-op without the Gamepad API.
(function () {
    'use strict';

    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;

    var BUTTON_KEYS = {
        // Bottom face button (Xbox A / PS Cross "X") — play/pause on the player
        // screen; also activates the currently-selected library card, since
        // Space is already treated as an activation key there alongside Enter.
        0: { key: ' ', code: 'Space' },
        1: { key: 'Escape', code: 'Escape' }, // Xbox B / PS Circle
        // 2 (Xbox X / PS Square) intentionally unmapped — undecided.
    };
    var RAIL_REVEAL_BUTTON = 3; // Y — reveals the player screen's left tool rail

    // The player rail (#v3-player-rail) has no keyboard shortcut to reuse — it's
    // shown via CSS on #v3-railzone:hover or :focus-within (see v3.css). So
    // instead of a synthetic keydown, this directly focuses the rail's first
    // icon, which the existing :focus-within rule already reveals it for —
    // the same mechanism a Tab-key user gets for free.
    function revealPlayerRail() {
        var active = document.querySelector('.screen.active');
        if (!active || active.id !== 'player') return;
        var icon = document.querySelector('#v3-player-rail .v3-rail-icon');
        if (icon) icon.focus();
    }
    var DPAD_BUTTONS = {
        12: { key: 'ArrowUp', code: 'ArrowUp' },
        13: { key: 'ArrowDown', code: 'ArrowDown' },
        14: { key: 'ArrowLeft', code: 'ArrowLeft' },
        15: { key: 'ArrowRight', code: 'ArrowRight' },
    };
    var STICK_DEADZONE = 0.5;
    var REPEAT_DELAY_MS = 400;
    var REPEAT_INTERVAL_MS = 120;

    var polling = false;
    var buttonWasDown = {};      // index -> bool, for edge-detection (no repeat)
    var dirWasDown = {};         // 'up'/'down'/'left'/'right' -> bool
    var dirRepeatAt = {};        // 'up'/'down'/'left'/'right' -> timestamp of next repeat
    var connectedIndices = {};   // gamepad.index -> true, tracks which slots we've announced

    function fireKey(spec) {
        // Dispatch on the focused element (falling back to document when nothing
        // is focused), not document itself. document.activeElement is always an
        // ancestor-inclusive descendant of document, so this still bubbles up
        // through every existing document-level listener exactly as before — but
        // now a focused <button>/<a> also gets its native Enter/Space activation
        // (which never fires for a document-targeted event, since that native
        // behavior is wired to the genuinely-focused element receiving the key),
        // and any element-scoped keydown handler sees it too.
        (document.activeElement || document).dispatchEvent(new KeyboardEvent('keydown', {
            key: spec.key, code: spec.code, bubbles: true, cancelable: true,
        }));
    }

    function pollButtons(gp) {
        for (var i = 0; i < gp.buttons.length; i++) {
            var down = gp.buttons[i].pressed;
            if (down && !buttonWasDown[i]) {
                if (i === RAIL_REVEAL_BUTTON) revealPlayerRail();
                else if (BUTTON_KEYS[i]) fireKey(BUTTON_KEYS[i]);
            }
            buttonWasDown[i] = down;
        }
    }

    function stickDirections(gp) {
        var x = gp.axes[0] || 0;
        var y = gp.axes[1] || 0;
        return {
            left: x < -STICK_DEADZONE,
            right: x > STICK_DEADZONE,
            up: y < -STICK_DEADZONE,
            down: y > STICK_DEADZONE,
        };
    }

    function pollDirection(name, spec, down, now) {
        var wasDown = !!dirWasDown[name];
        if (down && !wasDown) {
            fireKey(spec);
            dirRepeatAt[name] = now + REPEAT_DELAY_MS;
        } else if (down && wasDown && now >= (dirRepeatAt[name] || Infinity)) {
            fireKey(spec);
            dirRepeatAt[name] = now + REPEAT_INTERVAL_MS;
        }
        dirWasDown[name] = down;
    }

    function pollDpad(gp, now) {
        var stick = stickDirections(gp);
        Object.keys(DPAD_BUTTONS).forEach(function (idx) {
            var spec = DPAD_BUTTONS[idx];
            var name = spec.key.replace('Arrow', '').toLowerCase();
            var down = (gp.buttons[idx] && gp.buttons[idx].pressed) || stick[name];
            pollDirection(name, spec, down, now);
        });
    }

    // A disconnected gamepad's slot stays in the array (gp.connected flips to
    // false) rather than being removed — a plain truthiness check on the array
    // entry treats a stale, frozen-state disconnected pad as "still there"
    // forever, which both swallows the disconnect notice and (if the real
    // reconnected pad lands at a different index) reads dead input forever.
    function firstLiveStandardPad() {
        var pads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (var i = 0; i < pads.length; i++) {
            var p = pads[i];
            if (p && p.connected && p.mapping === 'standard') return p;
        }
        return null;
    }

    // Same standard-mapping filter as firstLiveStandardPad — otherwise a
    // still-connected non-standard raw mirror (or the real pad simply
    // reporting a different mapping) can mask the actual pad's disconnect:
    // the toast never fires and polling never stops, even though the pad
    // this module can act on is gone.
    function anyLiveStandardPad() {
        var pads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (var i = 0; i < pads.length; i++) {
            var p = pads[i];
            if (p && p.connected && p.mapping === 'standard') return true;
        }
        return false;
    }

    function tick() {
        var gp = firstLiveStandardPad();
        if (gp) {
            pollButtons(gp);
            pollDpad(gp, performance.now());
        }
        if (polling) requestAnimationFrame(tick);
    }

    function notify(title, icon) {
        if (window.fbNotify && typeof window.fbNotify.show === 'function') {
            window.fbNotify.show({ title: title, icon: icon, accent: '#0ea5e9', durationMs: 3000 });
        }
    }

    window.addEventListener('gamepadconnected', function (e) {
        var idx = e.gamepad && e.gamepad.index;
        // Non-standard slots (raw HID mirrors, or anything this module can't
        // safely act on) are never tracked/toasted/polled for — only ever
        // treat a standard-mapped pad as "a controller connected". Keeping a
        // non-standard slot out of connectedIndices also keeps it out of
        // anyLiveStandardPad's count, so it can't mask a real disconnect.
        if (!e.gamepad || e.gamepad.mapping !== 'standard') return;
        if (connectedIndices[idx]) return; // already-announced slot re-firing (focus regain, etc.)
        // On the Deck, Steam Input mirrors a real pad with 1-2 virtual XInput
        // slots of its own (same physical button presses, extra indices) — only
        // toast for the first slot seen so plugging in one controller doesn't
        // spam three "connected" notices.
        var isFirstSlot = Object.keys(connectedIndices).length === 0;
        connectedIndices[idx] = true;

        if (isFirstSlot) notify('Controller connected', '🎮');
        buttonWasDown = {};
        dirWasDown = {};
        dirRepeatAt = {};
        if (!polling) {
            polling = true;
            requestAnimationFrame(tick);
        }
    });

    window.addEventListener('gamepaddisconnected', function (e) {
        var idx = e.gamepad && e.gamepad.index;
        delete connectedIndices[idx];
        if (!anyLiveStandardPad()) {
            polling = false;
            notify('Controller disconnected', '🔌');
        }
    });
})();
