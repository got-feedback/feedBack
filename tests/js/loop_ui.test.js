const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { extractFunction } = require('./test_utils');

const ROOT = path.join(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'index.html'), 'utf8');
const SECTION = fs.readFileSync(path.join(ROOT, 'static', 'js', 'section-practice.js'), 'utf8');
const LOOPS = fs.readFileSync(path.join(ROOT, 'static', 'js', 'loops.js'), 'utf8');
const JUCE_AUDIO = fs.readFileSync(path.join(ROOT, 'static', 'js', 'juce-audio.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'static', 'app.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(ROOT, 'static', 'style.css'), 'utf8');
const V3_CSS = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'v3.css'), 'utf8');

function practiceMarkup() {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(`
        ${extractFunction(SECTION, 'function _sectionPracticeWholeCheckboxHtml(')}
        ${extractFunction(SECTION, 'function _sectionPracticePieceRowHtml(')}
        ${extractFunction(SECTION, 'function _sectionPracticeBarInnerHtml(')}
        globalThis.__markup = _sectionPracticeBarInnerHtml();
    `, sandbox);
    return sandbox.__markup;
}

test('Practice & Loops owns exactly one instance of every loop control ID', () => {
    const markup = practiceMarkup();
    const combined = `${HTML}\n${markup}`;
    const ids = [
        'btn-loop-a',
        'btn-loop-b',
        'btn-loop-start',
        'btn-loop-clear',
        'btn-loop-save',
        'saved-loops',
        'btn-loop-delete',
        'loop-status',
        'loop-activation-preference',
        'loop-first-pass-preference',
        'loop-repeat-preference',
    ];
    for (const id of ids) {
        const matches = combined.match(new RegExp(`id="${id}"`, 'g')) || [];
        assert.equal(matches.length, 1, `${id} must exist exactly once`);
    }
    assert.match(markup, /Practice &amp; Loops/);
});

test('Advanced settings retains unrelated controls and contains no loop controls', () => {
    const advanced = HTML.match(/<div id="v3-rail-pop-advanced"[\s\S]*?<\/div>\s*<\/div>\s*<!-- Bottom transport/);
    assert.ok(advanced, 'Advanced settings block not found');
    const block = advanced[0];
    assert.match(block, /id="arr-select"/);
    assert.match(block, /id="mastery-slider"/);
    assert.match(block, /id="player-av-offset-slider"/);
    assert.match(block, /id="btn-edit-region"/);
    assert.doesNotMatch(block, /btn-loop-|saved-loops|loop-status/);
});

test('loop controls and behavior choices have keyboard-accessible labels and state', () => {
    const markup = practiceMarkup();
    assert.match(markup, /aria-live="polite">No loop configured/);
    assert.match(markup, /id="btn-loop-start"[\s\S]*disabled[\s\S]*aria-describedby="loop-status"/);
    assert.match(markup, /for="loop-activation-preference"/);
    assert.match(markup, /for="loop-first-pass-preference"/);
    assert.match(markup, /for="loop-repeat-preference"/);
    assert.match(markup, /aria-label="Delete selected saved loop"/);
});

test('loop playback choices use plain-language labels instead of technical terms', () => {
    assert.match(SECTION, /How the loop plays/);
    assert.match(SECTION, /After setting a loop/);
    assert.match(SECTION, /Wait for me to start/);
    assert.match(SECTION, /When the loop starts/);
    assert.match(SECTION, /Count in first \(4 beats\)/);
    assert.match(SECTION, /Start right away/);
    assert.match(SECTION, /When the loop repeats/);
    assert.match(SECTION, /Count in again \(4 beats\)/);
    assert.match(SECTION, /Repeat right away/);
    assert.doesNotMatch(SECTION, />Arm only</);
    assert.doesNotMatch(SECTION, />Continuous</);
});

test('the regular game HUD clearly exposes configured and active loop states', () => {
    assert.match(HTML, /id="v3-loop-indicator-open"[\s\S]*onclick="toggleSectionPracticePopover\(\)"/);
    assert.match(HTML, /id="v3-loop-indicator-clear"[\s\S]*onclick="clearLoop\(\)"/);
    assert.match(HTML, /id="v3-loop-announcement"[\s\S]*role="status"[\s\S]*aria-live="polite"/);
    assert.match(HTML, /id="v3-loop-indicator-label"/);
    assert.match(HTML, /id="v3-loop-indicator-range"/);
    const update = extractFunction(LOOPS, 'function updateLoopUI(');
    assert.match(update, /hudIndicator\.hidden\s*=\s*!valid/);
    assert.match(update, /'Loop ready'/);
    assert.match(update, /'Loop starting'/);
    assert.match(update, /'Loop on'/);
});

test('the full-song timeline shows pointer-transparent A/B loop bounds', () => {
    assert.match(HTML, /id="v3-loop-timeline"/);
    assert.match(HTML, /id="v3-loop-timeline-region"/);
    assert.match(HTML, /v3-loop-timeline-marker--a">A</);
    assert.match(HTML, /v3-loop-timeline-marker--b">B</);
    const timeline = extractFunction(LOOPS, 'function _updateLoopTimeline(');
    assert.match(timeline, /const hasStart = Number\.isFinite\(loopA\)/);
    assert.match(timeline, /timeline\.hidden\s*=\s*!visible/);
    assert.match(timeline, /valid \? _loopPhase : 'partial'/);
    assert.match(timeline, /region\.style\.left\s*=\s*`\$\{startPercent\}%`/);
    assert.match(timeline, /region\.style\.width\s*=\s*`\$\{endPercent - startPercent\}%`/);
    assert.match(V3_CSS, /\.v3-loop-timeline\s*\{[\s\S]*?pointer-events:\s*none/);
    assert.match(V3_CSS, /\.v3-loop-timeline-marker\s*\{[\s\S]*?top:\s*23px/);
    assert.match(V3_CSS, /\.v3-loop-timeline-marker::before\s*\{[\s\S]*?border-bottom-color:\s*#fbbf24/);
    assert.match(V3_CSS, /\.v3-loop-timeline-marker--a\s*\{[\s\S]*?left:\s*-1px/);
    assert.match(V3_CSS, /\.v3-loop-timeline-marker--b\s*\{[\s\S]*?right:\s*-1px/);
    assert.match(V3_CSS, /\[data-state="partial"\][\s\S]*?v3-loop-timeline-marker--b\s*\{\s*display:\s*none/);
});

test('returning to A gives the loop indicator one restrained pulse', () => {
    assert.match(APP, /window\.feedBack\.on\('loop:restart',\s*pulseLoopIndicator\)/);
    const pulse = extractFunction(LOOPS, 'function pulseLoopIndicator(');
    assert.match(pulse, /classList\.add\('is-returning'\)/);
    assert.match(V3_CSS, /\.v3-loop-indicator\.is-returning\s*\{[\s\S]*?v3-loop-return-pulse/);
    assert.match(V3_CSS, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test('selected Section Practice remains visible without replacing loop lifecycle styling', () => {
    assert.match(SECTION, /classList\.toggle\('section-practice-pill--section-selected',\s*_sectionPracticeMode\)/);
    assert.match(STYLE_CSS, /\.section-practice-pill\.section-practice-pill--section-selected\s*\{/);
    assert.match(V3_CSS, /\.section-practice-pill\.section-practice-pill--section-selected/);
    assert.match(V3_CSS, /\.section-practice-pill\.section-practice-pill--active/);
    assert.match(V3_CSS, /\.section-practice-pill\.section-practice-pill--armed/);
});

test('JUCE pause-and-seek restarts an outside loop only when playback follows', () => {
    const start = JUCE_AUDIO.indexOf('function flushJuceShimBatchNow(');
    const end = JUCE_AUDIO.indexOf('function scheduleJuceShimBatchFlush(', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const flush = JUCE_AUDIO.slice(start, end);
    const pauseAndSeekStart = flush.indexOf('if (wantsPause && seekTime !== undefined)');
    const pauseAndSeekEnd = flush.indexOf('if (wantsPause) {', pauseAndSeekStart);
    assert.notEqual(pauseAndSeekStart, -1);
    assert.notEqual(pauseAndSeekEnd, -1);
    const pauseAndSeek = flush.slice(pauseAndSeekStart, pauseAndSeekEnd);
    assert.match(pauseAndSeek, /restartActiveLoopWhilePlaying:\s*forUpcomingPlay/);
    assert.doesNotMatch(pauseAndSeek, /restartActiveLoopWhilePlaying:\s*true/);
});

test('timeline seeks stay free while paused and restart active loops while playing', () => {
    assert.match(APP, /setLoopPlayStartTargetResolver\(\(requestedTime\)/);
    assert.match(APP, /setLoopRestartHandler\(async\s*\(\{\s*trigger\s*\}\)\s*=>\s*\{[\s\S]*startLoop\(\{/);
    assert.match(APP, /requestedTime\s*>=\s*state\.loopA\s*&&\s*requestedTime\s*<\s*state\.loopB/);
    assert.match(APP, /seek\(seconds,\s*reason,\s*options\)[\s\S]*restartActiveLoopWhilePlaying:\s*true/);
    assert.match(APP, /seek\(\{\s*time,\s*reason\s*\}\)[\s\S]*restartActiveLoopWhilePlaying:\s*true/);
});

test('Practice Section, saved loops, and manual A/B select preference-driven controller mode', () => {
    const practice = extractFunction(SECTION, 'async function practiceSection');
    const saved = extractFunction(LOOPS, 'async function loadSavedLoop(');
    const manual = extractFunction(LOOPS, 'async function setLoopEnd(');
    for (const [name, source] of [['Practice Section', practice], ['saved loop', saved], ['manual A/B', manual]]) {
        assert.match(source, /setLoop\([\s\S]*activation:\s*['"]preference['"]/, `${name} must use shared preference mode`);
    }
    assert.doesNotMatch(practice, /startCountIn\s*\(/, 'Practice Section must not own start/count-in policy');
});

test('the editor loop handoff uses preference-driven controller mode', () => {
    const handoffStart = APP.indexOf('// Editor → Highway handoff');
    const handoffEnd = APP.indexOf('// Generation token + safety-timeout', handoffStart);
    assert.notEqual(handoffStart, -1);
    assert.notEqual(handoffEnd, -1);
    const handoff = APP.slice(handoffStart, handoffEnd);
    assert.match(handoff, /setLoop\(pend\.a,\s*pend\.b,\s*\{[\s\S]*activation:\s*['"]preference['"]/);
    assert.doesNotMatch(handoff, /togglePlay\s*\(/);
});

test('armed bounds cannot wrap', () => {
    assert.match(APP, /getLoopState\(\)\.active\s*&&\s*S\.isPlaying\s*&&\s*ct\s*>=\s*loopB/);
});
