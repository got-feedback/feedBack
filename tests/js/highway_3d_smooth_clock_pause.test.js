// Source-level guards for the smoothNow() pause-drift fix.
//
// smoothNow() interpolates bundle.currentTime forward with performance.now()
// between distinct audio samples. Before this fix it only stopped once the
// interpolation cap (dt > 0.1 s) was crossed, so for the first ~100 ms of a
// pause the 3D highway crept forward against a frozen audio clock and then
// snapped back to raw — a visible twitch on every pause.
//
// The fix wires a host pause signal (feedBack core's bundle.isPlaying) into
// smoothNow: when the chart clock is not advancing, return raw immediately
// and re-anchor. These tests lock in both halves of the contract by
// inspecting source (the createHighway / renderer closures own WebGL + audio
// lifecycle that's too heavy to execute in a vm sandbox — same approach as
// the other highway source-guard tests in this dir).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const highwayJs = path.join(__dirname, '..', '..', 'static', 'highway.js');
const highway3dJs = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');

// Brace-balanced extraction (same helper shape as highway_note_state.test.js).
function extractBlock(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `signature '${signature}' not found`);
    const openBrace = src.indexOf('{', start);
    assert.ok(openBrace !== -1, `opening brace after '${signature}' not found`);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

test('core _makeBundle exposes isPlaying derived from the chart-clock anchor', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const fn = extractBlock(src, 'function _makeBundle()');
    // Field present in the bundle.
    assert.match(fn, /\bisPlaying\s*:/, 'bundle must expose isPlaying');
    // It is computed from the same anchor/advance state getTime() uses, not a
    // hardcoded literal — anchor must exist AND the clock must have advanced
    // within the interp cap.
    assert.match(
        fn,
        /isPlaying\s*:\s*!Number\.isNaN\(\s*_chartAnchorPerfNow\s*\)/,
        'isPlaying must gate on a live anchor (_chartAnchorPerfNow not NaN)',
    );
    assert.match(
        fn,
        /_chartLastAdvanceAt\s*\)\s*<=\s*_CHART_MAX_INTERP_MS/,
        'isPlaying must require the clock advanced within _CHART_MAX_INTERP_MS',
    );
});

test('smoothNow returns raw and re-anchors when the host reports not playing', () => {
    const src = fs.readFileSync(highway3dJs, 'utf8');
    const fn = extractBlock(src, 'function smoothNow(bundle)');
    // Strict === false so downlevel hosts (isPlaying undefined) fall through
    // to the existing staleness-based interpolation cap.
    const guardIdx = fn.search(/bundle\.isPlaying\s*===\s*false/);
    assert.ok(guardIdx !== -1, 'smoothNow must check bundle.isPlaying === false');

    // The pause branch re-anchors the clock state and returns the raw sample
    // (no forward extrapolation).
    const branch = fn.slice(guardIdx);
    assert.match(branch, /_clkAudioT\s*=\s*raw/, 'pause branch must re-anchor _clkAudioT to raw');
    assert.match(branch, /_clkPerf\s*=\s*p/, 'pause branch must re-anchor _clkPerf to now');
    assert.match(branch, /return\s*\(\s*_frameNow\s*=\s*raw\s*\)/, 'pause branch must return raw');

    // The pause gate must come before the new-sample re-anchor / interpolation
    // path so a frozen clock never extrapolates forward.
    const newSampleIdx = fn.search(/if\s*\(\s*raw\s*!==\s*_clkAudioT\s*\)/);
    assert.ok(newSampleIdx !== -1, 'smoothNow new-sample branch not found');
    assert.ok(guardIdx < newSampleIdx, 'isPlaying pause gate must precede the interpolation path');
});
