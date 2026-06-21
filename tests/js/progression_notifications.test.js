// Contract tests for notifications.js: the fbNotify toast surface and the
// progression:* → toast wiring (period labels, celebratory vs subtle, path
// name lookup, rank-up-only guard).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT } = require('./capabilities_test_harness');

const SRC = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'notifications.js'), 'utf8');

// Minimal DOM: enough for createElement/append/insertBefore/getElementById and
// the inline-style/innerHTML the toast sets.
function fakeDom() {
    function mkEl(tag) {
        return {
            tagName: tag, id: '', className: '', innerHTML: '', style: {},
            children: [], get firstChild() { return this.children[0] || null; },
            appendChild(c) { this.children.push(c); c.parent = this; return c; },
            insertBefore(c, ref) {
                const i = ref ? this.children.indexOf(ref) : -1;
                if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
                c.parent = this; return c;
            },
            remove() { const p = this.parent; if (p) p.children = p.children.filter((x) => x !== this); },
            addEventListener(type, fn) { (this._h || (this._h = {}))[type] = fn; },
            _text() { return (this.innerHTML || '').replace(/<[^>]*>/g, ''); },
        };
    }
    const body = mkEl('body');
    const byId = (node, id) => {
        if (node.id === id) return node;
        for (const c of node.children) { const hit = byId(c, id); if (hit) return hit; }
        return null;
    };
    return {
        body,
        createElement: mkEl,
        getElementById: (id) => byId(body, id),
    };
}

function load(progressionState) {
    const handlers = {};
    const sandbox = {
        console,
        setTimeout: () => 0, clearTimeout: () => {},
        requestAnimationFrame: (fn) => fn(),   // run animation callbacks synchronously
    };
    sandbox.window = sandbox;
    sandbox.document = fakeDom();
    sandbox.window.slopsmith = { on: (name, fn) => { handlers[name] = fn; } };
    sandbox.window.v3Progression = { get: () => progressionState };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    const stack = () => sandbox.document.getElementById('fb-notify-stack');
    return { sandbox, handlers, stack };
}

test('fbNotify.show renders a card with the title and message', () => {
    const { sandbox, stack } = load(null);
    assert.equal(typeof sandbox.window.fbNotify.show, 'function');
    sandbox.window.fbNotify.show({ title: 'Hello', message: 'World' });
    const cards = stack().children;
    assert.equal(cards.length, 1);
    assert.match(cards[0]._text(), /Hello/);
    assert.match(cards[0]._text(), /World/);
});

test('quest-completed makes a celebratory toast with the period label and reward', () => {
    const { handlers, stack } = load(null);
    handlers['progression:quest-completed']({ id: 'q1', title: 'Play 3 songs', period_type: 'weekly', reward_db: 200 });
    const card = stack().children[0];
    assert.match(card._text(), /Weekly Quest complete!/);
    assert.match(card._text(), /Play 3 songs/);
    assert.match(card._text(), /\+200 dB/);
});

test('quest-progressed makes a subtle toast showing N/M and the daily label', () => {
    const { handlers, stack } = load(null);
    handlers['progression:quest-progressed']({ id: 'q1', title: 'Play 3 songs', period_type: 'daily', count: 2, target: 3 });
    assert.match(stack().children[0]._text(), /Daily Quest advanced/);
    assert.match(stack().children[0]._text(), /2\/3/);
});

test('path-level-up resolves the path name from progression state', () => {
    const { handlers, stack } = load({ paths: [{ id: 'guitar', name: 'Lead Guitar' }] });
    handlers['progression:path-level-up']({ path_id: 'guitar', new_level: 4 });
    assert.match(stack().children[0]._text(), /Lead Guitar — Level 4!/);
});

test('path-progressed shows path name and challenge count toward the next level', () => {
    const { handlers, stack } = load(null);
    handlers['progression:path-progressed']({ id: 'bass', name: 'Bass', completed: 2, required: 3, next_level: 2 });
    assert.match(stack().children[0]._text(), /Bass progress/);
    assert.match(stack().children[0]._text(), /2\/3 to Level 2/);
});

test('rank-changed toasts on a rank up but not a rank drop', () => {
    const up = load(null);
    up.handlers['progression:rank-changed']({ from: 2, to: 3 });
    assert.equal(up.stack().children.length, 1);
    assert.match(up.stack().children[0]._text(), /Mastery Rank 3!/);

    const down = load(null);
    down.handlers['progression:rank-changed']({ from: 3, to: 2 });
    assert.equal(down.stack() ? down.stack().children.length : 0, 0);   // no toast on a drop
});

test('newest toast is inserted on top of the stack', () => {
    const { sandbox, stack } = load(null);
    sandbox.window.fbNotify.show({ title: 'first' });
    sandbox.window.fbNotify.show({ title: 'second' });
    assert.match(stack().children[0]._text(), /second/);
    assert.match(stack().children[1]._text(), /first/);
});
