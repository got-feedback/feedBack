// Contract tests for progression-core's _diff(): the quest-progressed /
// path-progressed "advance" events that feed the achievement toasts, plus the
// guards that keep a completion / level-up from also firing a progress event.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT } = require('./capabilities_test_harness');

const SRC = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'progression-core.js'), 'utf8');

// Load progression-core.js in a sandbox whose fetch returns `states` in order.
// Boot consumes states[0] (prev=null → no diff); each later refresh() diffs
// against the previous state.
function load(states) {
    const events = [];
    let i = 0;
    const sandbox = {
        console,
        setTimeout, clearTimeout,
        fetch: async () => ({ ok: true, json: async () => states[Math.min(i++, states.length - 1)] }),
    };
    sandbox.window = sandbox;
    sandbox.window.slopsmith = { emit: (name, detail) => events.push({ name, detail }) };
    sandbox.document = { readyState: 'complete', addEventListener: () => {} };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    return { sandbox, events };
}

const stateA = {
    mastery_rank: 2,
    wallet: { balance: 100 },
    quests: {
        daily: { quests: [
            { id: 'q1', title: 'Play 3 songs', count: 1, target: 3, completed: false, reward_db: 50 },
            { id: 'q2', title: 'Finish one', count: 0, target: 1, completed: false, reward_db: 20 },
        ] },
        weekly: { quests: [
            { id: 'w1', title: 'Weekly grind', count: 2, target: 10, completed: false, reward_db: 200 },
        ] },
    },
    paths: [
        { id: 'guitar', name: 'Guitar', level: 1, max_level: 10, next: { level: 2, required: 3, completed: 1 } },
        { id: 'bass', name: 'Bass', level: 0, max_level: 10, next: { level: 1, required: 2, completed: 0 } },
    ],
};

const stateB = {
    mastery_rank: 3,                          // rank up
    wallet: { balance: 170 },                 // dB changed
    quests: {
        daily: { quests: [
            { id: 'q1', title: 'Play 3 songs', count: 2, target: 3, completed: false, reward_db: 50 },  // advanced
            { id: 'q2', title: 'Finish one', count: 1, target: 1, completed: true, reward_db: 20 },       // COMPLETED
        ] },
        weekly: { quests: [
            { id: 'w1', title: 'Weekly grind', count: 3, target: 10, completed: false, reward_db: 200 }, // advanced
        ] },
    },
    paths: [
        { id: 'guitar', name: 'Guitar', level: 1, max_level: 10, next: { level: 2, required: 3, completed: 2 } }, // progressed
        { id: 'bass', name: 'Bass', level: 1, max_level: 10, next: { level: 2, required: 3, completed: 0 } },     // LEVELED UP
    ],
};

async function diffEvents() {
    const { sandbox, events } = load([stateA, stateB]);
    await sandbox.window.v3Progression.refresh();   // coalesces with boot → state = A
    events.length = 0;                               // drop boot's progression:updated
    await sandbox.window.v3Progression.refresh();    // state = B → _diff(A, B)
    return events.filter((e) => e.name !== 'progression:updated');
}

test('quest advance emits quest-progressed with period_type, completion does not', async () => {
    const ev = await diffEvents();
    const progressed = ev.filter((e) => e.name === 'progression:quest-progressed');
    const ids = progressed.map((e) => e.detail.id).sort();
    assert.deepEqual(ids, ['q1', 'w1']);   // q2 completed → not a progress event
    const q1 = progressed.find((e) => e.detail.id === 'q1').detail;
    assert.equal(q1.period_type, 'daily');
    assert.equal(q1.count, 2);
    assert.equal(q1.target, 3);
    const w1 = progressed.find((e) => e.detail.id === 'w1').detail;
    assert.equal(w1.period_type, 'weekly');
});

test('path challenge progress emits path-progressed; a level-up does not', async () => {
    const ev = await diffEvents();
    const progressed = ev.filter((e) => e.name === 'progression:path-progressed');
    assert.equal(progressed.length, 1);
    const g = progressed[0].detail;
    assert.equal(g.id, 'guitar');
    assert.equal(g.name, 'Guitar');
    assert.equal(g.completed, 2);
    assert.equal(g.required, 3);
    assert.equal(g.next_level, 2);
    // bass leveled up (level 0 → 1) → handled by path-level-up, not path-progressed.
    assert.ok(!progressed.some((e) => e.detail.id === 'bass'));
});

test('rank-up and dB change still emit their events', async () => {
    const ev = await diffEvents();
    const rank = ev.find((e) => e.name === 'progression:rank-changed');
    assert.ok(rank && rank.detail.from === 2 && rank.detail.to === 3);
    assert.ok(ev.some((e) => e.name === 'progression:db-changed'));
});

test('no progress events fire on the very first state (prev=null)', async () => {
    const { sandbox, events } = load([stateA]);
    await sandbox.window.v3Progression.refresh();
    assert.ok(!events.some((e) => /progressed|changed/.test(e.name)));
});
