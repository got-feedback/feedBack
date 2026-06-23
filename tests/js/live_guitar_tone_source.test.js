'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const toneSource = require('../../static/v3/live-guitar-tone-source.js');
const INDEX_HTML = path.join(__dirname, '..', '..', 'static', 'v3', 'index.html');

test('default live guitar tone source is internal', () => {
    assert.equal(toneSource.DEFAULT, 'internal');
    assert.equal(toneSource.normalize(undefined), 'internal');
    assert.equal(toneSource.normalize(''), 'internal');
    assert.equal(toneSource.normalize('bogus'), 'internal');
});

test('normalize accepts external and spark values', () => {
    assert.equal(toneSource.normalize('external_hardware'), 'external_hardware');
    assert.equal(toneSource.normalize('spark_control_x'), 'spark_control_x');
});

test('shouldSuppressMonitorMuteHint only for external modes', () => {
    assert.equal(toneSource.shouldSuppressMonitorMuteHint('internal'), false);
    assert.equal(toneSource.shouldSuppressMonitorMuteHint('external_hardware'), true);
    assert.equal(toneSource.shouldSuppressMonitorMuteHint('spark_control_x'), true);
    assert.equal(toneSource.shouldSuppressMonitorMuteHint('invalid'), false);
});

test('labels include internal, external, and spark options', () => {
    assert.match(toneSource.LABELS.internal, /fee\[dB\]ack internal tone/i);
    assert.match(toneSource.LABELS.external_hardware, /External amp/i);
    assert.match(toneSource.LABELS.spark_control_x, /Spark LIVE/i);
});

test('settings UI exposes tone source select with all options', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.match(html, /id="setting-live-guitar-tone-source"/);
    assert.match(html, /value="internal"/);
    assert.match(html, /value="external_hardware"/);
    assert.match(html, /value="spark_control_x"/);
    assert.match(html, /Live guitar tone source/);
    assert.match(html, /won&rsquo;t warn that no internal amp tone is loaded/);
});

test('player audio rail exposes tone source select', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.match(html, /id="player-live-guitar-tone-source"/);
});

test('live-guitar-tone-source script is loaded in v3 shell', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.match(html, /live-guitar-tone-source\.js/);
});
