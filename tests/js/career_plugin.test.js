'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'career');
const SHELL_JS = path.join(ROOT, 'static', 'v3', 'shell.js');

test('career plugin manifest is complete and bundled', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
    assert.equal(manifest.id, 'career');
    assert.equal(manifest.bundled, true);
    assert.equal(manifest.screen, 'screen.html');
    assert.equal(manifest.script, 'screen.js');
    assert.equal(manifest.routes, 'routes.py');
    for (const f of ['screen.html', 'screen.js', 'routes.py', 'venues.json', manifest.styles]) {
        assert.ok(fs.existsSync(path.join(PLUGIN_DIR, f)), `${f} missing`);
    }
});

test('venues.json defines the 3 ascending tiers with star thresholds', () => {
    const content = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'venues.json'), 'utf8'));
    assert.deepEqual(content.star_accuracy_thresholds, [0.6, 0.75, 0.85]);
    const venues = content.venues;
    assert.deepEqual(venues.map((v) => v.id), ['bar', 'club', 'arena']);
    assert.equal(venues[0].star_threshold, 0, 'bar must always be unlocked');
    for (let i = 1; i < venues.length; i++) {
        assert.ok(venues[i].star_threshold > venues[i - 1].star_threshold,
            'thresholds must ascend');
    }
});

test('bar venue pack ships with intro media in the plugin checkout', () => {
    const packDir = path.join(PLUGIN_DIR, 'venue-packs', 'bar');
    const manifest = JSON.parse(fs.readFileSync(path.join(packDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.loops).sort(),
        ['bored', 'ecstatic', 'engaged', 'neutral']);
    assert.equal(manifest.intro.video, 'intro.mp4');
    assert.equal(manifest.intro.audio, 'bar-ambience.mp3');
    for (const f of [
        ...Object.values(manifest.loops),
        ...Object.values(manifest.stingers),
        manifest.intro.video,
        manifest.intro.audio,
    ]) {
        const stat = fs.statSync(path.join(packDir, f));
        assert.ok(stat.size > 0, `${f} must be present`);
    }
});

test('arena venue pack ships with full media in the plugin checkout', () => {
    const packDir = path.join(PLUGIN_DIR, 'venue-packs', 'arena');
    const manifest = JSON.parse(fs.readFileSync(path.join(packDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.venue, 'arena');
    assert.deepEqual(manifest.loops, {
        bored: 'bored.mp4', neutral: 'neutral.mp4',
        engaged: 'engaged.mp4', ecstatic: 'ecstatic.mp4',
    });
    assert.deepEqual(manifest.stingers, { clap: 'clap.mp4', cheer: 'cheer.mp4' });
    assert.deepEqual(manifest.sfx, { up: 'sfx-up.mp3', down: 'sfx-down.mp3' });
    assert.equal(manifest.intro.video, 'intro.mp4');
    assert.equal(manifest.intro.audio, 'arena-ambience.mp3');
    for (const f of [
        ...Object.values(manifest.loops),
        ...Object.values(manifest.stingers),
        manifest.intro.video,
        manifest.intro.audio,
        manifest.sfx.up,
        manifest.sfx.down,
    ]) {
        const stat = fs.statSync(path.join(packDir, f));
        assert.ok(stat.size > 0, `${f} must be present`);
    }
});

test('club venue pack ships with full media in the plugin checkout', () => {
    const packDir = path.join(PLUGIN_DIR, 'venue-packs', 'club');
    const manifest = JSON.parse(fs.readFileSync(path.join(packDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.venue, 'club');
    assert.deepEqual(manifest.loops, {
        bored: 'bored.mp4', neutral: 'neutral.mp4',
        engaged: 'engaged.mp4', ecstatic: 'ecstatic.mp4',
    });
    assert.deepEqual(manifest.stingers, { clap: 'clap.mp4', cheer: 'cheer.mp4' });
    assert.deepEqual(manifest.sfx, { up: 'sfx-up.mp3', down: 'sfx-down.mp3' });
    assert.equal(manifest.intro.video, 'intro.mp4');
    assert.equal(manifest.intro.audio, 'club-ambience.mp3');
    for (const f of [
        ...Object.values(manifest.loops),
        ...Object.values(manifest.stingers),
        manifest.intro.video,
        manifest.intro.audio,
        manifest.sfx.up,
        manifest.sfx.down,
    ]) {
        const stat = fs.statSync(path.join(packDir, f));
        assert.ok(stat.size > 0, `${f} must be present`);
    }
});

test('shell promotes the career plugin into the sidebar', () => {
    const src = fs.readFileSync(SHELL_JS, 'utf8');
    assert.match(src, /key: 'career',\s*screen: 'plugin-career'/);
    assert.match(src, /navKey: 'career',\s*pluginId: 'career',\s*slotId: 'v3-nav-career'/);
});

test('career screen pushes the crowd manifest with a base URL', () => {
    const src = fs.readFileSync(path.join(PLUGIN_DIR, 'screen.js'), 'utf8');
    assert.match(src, /v3VenueCrowd/);
    assert.match(src, /setManifest\(manifest\)/);
    assert.match(src, /manifest\.base = /);
    assert.match(src, /feedBack-career-venue/);
    // Degrades without the crowd layer (PR1 not merged / older desktop).
    assert.match(src, /typeof crowd\.setManifest !== 'function'\) return/);
});
