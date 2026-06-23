/**
 * Toilet Tuner visualization for the FeedBack tuner plugin.
 *
 * Bathroom scene background; plunger slides left/right over the bowl based on
 * cents deviation; dips into bowl when in tune (±2 cents); wall calendar shows
 * the detected note name.
 *
 * Contract: window['_tunerViz_toilet-tuner'](container) → { update(note, cents, freq), destroy() }
 *   - note:  string | null  (null = no signal)
 *   - cents: number         (deviation from target, −50…+50)
 *   - freq:  number         (detected frequency in Hz)
 */
(function () {
    'use strict';

    // ── Constants ─────────────────────────────────────────────────────
    var _TUNER_TT_IN_TUNE_THR  = 2;
    var _TUNER_TT_ASSET_BASE   = '/api/plugins/tuner/viz-assets/';

    // Positions derived from Bathroom.svg 0-1024 coordinate space.
    // Bowl ellipse centre: x=512 (50%), y=673 (65.7%), semi-major=99 (9.7%).
    // Plunger SVG is 29.8mm wide x 69.5mm tall (ratio 1:2.33).
    // At width=8%, rendered height = 8% x 2.33 = 18.6%.
    // Raised: cup bottom at ~62% (above bowl top) → top = 62 - 18.6 = 43%.
    // Dipped: cup inside bowl → top = 52%.

    var _TUNER_TT_LEFT_PCT     = 15;   // x at cents=-50
    var _TUNER_TT_RIGHT_PCT    = 85;   // x at cents=+50
    var _TUNER_TT_CENTRE_PCT   = 50;   // x at cents=0  (bowl centre)

    var _TUNER_TT_RAISED_TOP   = 41;   // plunger top % when hovering above bowl
    var _TUNER_TT_DIPPED_TOP   = 52;   // plunger top % when cup inside bowl

    window['_tunerViz_toilet-tuner'] = function (container) {
        'use strict';

        // ── Root panel — 1:1 square, full width ───────────────────────
        // padding-bottom: 100% trick: reliable square even with all-absolute children.
        // Background loaded as CSS background-image: bypasses browser intrinsic-size
        // limits that cause SVGs with huge explicit width/height to fail as <img>.
        var panel = document.createElement('div');
        panel.className = 'relative w-full overflow-hidden select-none';
        panel.style.height              = '0';
        panel.style.paddingBottom       = '100%';
        panel.style.backgroundImage     = "url('" + _TUNER_TT_ASSET_BASE + "Bathroom.svg')";
        panel.style.backgroundSize      = 'cover';
        panel.style.backgroundPosition  = 'center';

        // ── Note label (over calendar on wall) ────────────────────────
        var noteEl = document.createElement('div');
        noteEl.className = 'absolute font-bold pointer-events-none';
        noteEl.style.right      = '17.25%';
        noteEl.style.top        = '17%';
        noteEl.style.fontSize   = '1.6rem';
        noteEl.style.color      = '#303332';
        noteEl.style.textAlign  = 'center';
        noteEl.style.transform  = 'translateX(50%)';
        noteEl.textContent      = '–';
        panel.appendChild(noteEl);

        // ── Plunger ───────────────────────────────────────────────────
        var plungerEl = document.createElement('img');
        plungerEl.src = _TUNER_TT_ASSET_BASE + 'Plunger.svg';
        plungerEl.className = 'absolute pointer-events-none';
        plungerEl.style.width     = '10%';
        plungerEl.style.left      = _TUNER_TT_CENTRE_PCT + '%';
        plungerEl.style.top       = _TUNER_TT_RAISED_TOP + '%';
        plungerEl.style.transform = 'translateX(-50%)';
        panel.appendChild(plungerEl);

        // ── Toilet bowl overlay (hides plunger cup when dipped) ───────
        var bowlEl = document.createElement('img');
        bowlEl.src = _TUNER_TT_ASSET_BASE + 'Toiletbowl.svg';
        bowlEl.className = 'absolute pointer-events-none';
        // Bowl overlay aligned via shared path124 (lower bowl body) registration:
        // Bathroom path102 ellipse centre: x=50%, y=65.8%; width=19.4% of panel.
        // Toiletbowl path102 same ellipse: centre at y=0 (top of viewBox), rx=35.4% of viewBox.
        // → width = 19.4% / 70.7% = 27.4%; left = 50% - 27.4%/2 = 36.3%; top = 65.8%.
        // Verified: Toiletbowl path124 at y=60.93% × height(25.2%) + 65.8% = 81.2% = Bathroom path124 ✓
        bowlEl.style.left       = '36.3%';
        bowlEl.style.top        = '65.8%';
        bowlEl.style.width      = '27.4%';
        panel.appendChild(bowlEl);

        container.appendChild(panel);

        // ── State ─────────────────────────────────────────────────────
        var _rafId        = null;
        var _currentNote  = null;
        var _currentCents = 0;
        var _plungerDipped = false;
        var _lastTime     = null;
        var _leftPct      = _TUNER_TT_CENTRE_PCT;
        var _topPct       = _TUNER_TT_RAISED_TOP;

        // ── Animation loop ────────────────────────────────────────────
        function _animate(now) {
            var dt = Math.min(((now - (_lastTime || now)) / 1000), 0.1);
            _lastTime = now;

            var inTune = _currentNote !== null && Math.abs(_currentCents) <= _TUNER_TT_IN_TUNE_THR;
            var targetLeft = _currentNote === null
                ? _TUNER_TT_CENTRE_PCT
                : Math.min(_TUNER_TT_RIGHT_PCT, Math.max(_TUNER_TT_LEFT_PCT,
                    _TUNER_TT_CENTRE_PCT + (_currentCents / 50) * (_TUNER_TT_RIGHT_PCT - _TUNER_TT_CENTRE_PCT)));

            if (inTune && !_plungerDipped) {
                _leftPct = _TUNER_TT_CENTRE_PCT;
                _topPct = _TUNER_TT_DIPPED_TOP;
                _plungerDipped = true;
                noteEl.textContent = '💩';
            } else if (!inTune && _plungerDipped) {
                _topPct = _TUNER_TT_RAISED_TOP;
                _plungerDipped = false;
                noteEl.textContent = _currentNote || '–';
            }

            if (!_plungerDipped) {
                _leftPct += (targetLeft - _leftPct) * 8 * dt;
            }

            plungerEl.style.left = _leftPct.toFixed(2) + '%';
            plungerEl.style.top  = _topPct.toFixed(2)  + '%';

            _rafId = requestAnimationFrame(_animate);
        }

        // ── Public API ────────────────────────────────────────────────
        function update(note, cents, freq) {
            _currentNote  = note;
            _currentCents = note === null ? 0 : cents;
            if (!_plungerDipped) { noteEl.textContent = note || '–'; }
        }

        function destroy() {
            if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
            panel.remove();
        }

        _rafId = requestAnimationFrame(_animate);

        return { update: update, destroy: destroy };
    };

})();
