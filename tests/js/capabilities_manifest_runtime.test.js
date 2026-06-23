const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCapabilities, ROOT } = require('./capabilities_test_harness');

const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'plugin_capabilities');

function fixture(name) {
    return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

test('manifest participants are visible before runtime handlers register', () => {
    const window = loadCapabilities();
    const api = window.feedBack.capabilities;
    api.registerParticipants([fixture('valid_owner_provider.json'), fixture('valid_requester_observer.json')]);

    const stems = api.inspect('stems');
    assert.equal(stems.participants.length, 2);
    const owner = stems.participants.find(p => p.pluginId === 'stems');
    assert.equal(owner.runtime, false);
    assert.equal(JSON.stringify(owner.commands.slice().sort()), JSON.stringify(['inspect', 'mute', 'restore']));
    assert.equal(owner.description, 'Owns stem mute and restore coordination for integrated audio plugins.');
    assert.equal(owner.ownership, 'exclusive-owner');
    assert.equal(owner.safety, 'safe');
});

test('runtime registration refreshes an existing manifest participant without duplicating it', async () => {
    const window = loadCapabilities();
    const api = window.feedBack.capabilities;
    api.registerParticipants([fixture('valid_owner_provider.json')]);
    api.registerParticipant('stems', {
        capabilities: {
            stems: {
                roles: ['owner', 'provider'],
                commands: ['mute'],
                runtime: true,
                handlers: { mute: () => ({ outcome: 'handled', payload: { muted: true } }) },
            },
        },
    });
    api.registerParticipant('stems', {
        stems: {
            roles: ['owner', 'provider'],
            commands: ['mute'],
            runtime: true,
            handlers: { mute: () => ({ outcome: 'handled', payload: { muted: 'refreshed' } }) },
        },
    });

    const stems = api.inspect('stems');
    assert.equal(stems.participants.filter(p => p.pluginId === 'stems').length, 1);
    assert.equal(stems.participants[0].runtime, true);
    const result = await api.dispatch({ capability: 'stems', command: 'mute', source: 'test' });
    assert.equal(result.status, 'applied');
    assert.deepEqual(result.payload, { muted: 'refreshed' });
});

test('native library provider capability coordinates providers', async () => {
    const providers = [
        { id: 'local', label: 'My Library', capabilities: ['library.read'], default: true },
        { id: 'remote:frodo', label: 'Frodo', capabilities: ['library.read', 'song.sync'], owner_plugin_id: 'frodo_library' },
    ];
    const synced = [];
    const window = loadCapabilities({ library: true });
    window.fetch = async (url, options = {}) => {
        const text = String(url);
        if (text === '/api/library/providers') {
            return { ok: true, json: async () => ({ providers }) };
        }
        if (text.includes('/sync') && options.method === 'POST') {
            synced.push(text);
            return { ok: true, json: async () => ({ ok: true, filename: 'remote:frodo:song-1' }) };
        }
        throw new Error(`unexpected fetch ${text}`);
    };
    const api = window.feedBack.capabilities;
    const events = [];
    api.subscribe('library:source-changed', event => events.push(event));

    await api.command('library', 'refresh-providers', { requester: 'test', payload: { restoreSaved: true } });
    const listed = await api.command('library', 'list-providers', { requester: 'test' });
    assert.equal(listed.outcome, 'handled');
    assert.equal(listed.payload.providers[1].owner_plugin_id, 'frodo_library');

    const libraryPipeline = api.inspect('library');
    const providerParticipants = libraryPipeline.participants.filter(participant => participant.roles.includes('provider'));
    const localProvider = providerParticipants.find(participant => participant.pluginId === 'core.library.local');
    const remoteProvider = providerParticipants.find(participant => participant.pluginId === 'frodo_library');
    assert.ok(localProvider);
    assert.equal(localProvider.providerPolicy.providerId, 'local');
    assert.ok(localProvider.operations.includes('query-page'));
    assert.ok(remoteProvider);
    assert.equal(remoteProvider.providerPolicy.providerId, 'remote:frodo');
    assert.ok(remoteProvider.operations.includes('sync-song'));

    const selected = await api.command('library', 'select-provider', {
        requester: 'test',
        target: { providerId: 'remote:frodo' },
    });
    assert.equal(selected.payload.current, 'remote:frodo');
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.to, 'remote:frodo');
    assert.equal(window.feedBack.libraryProviders.snapshot().current, 'remote:frodo');

    const syncResult = await api.command('library', 'sync-song', {
        requester: 'test',
        target: { providerId: 'remote:frodo', songId: 'song-1' },
    });
    assert.equal(syncResult.outcome, 'handled');
    assert.equal(syncResult.payload.result.filename, 'remote:frodo:song-1');
    assert.equal(synced.length, 1);
});

test('removed library providers are unregistered as library participants on refresh', async () => {
    let providerSet = [
        { id: 'local', label: 'My Library', capabilities: ['library.read'], default: true },
        { id: 'remote:frodo', label: 'Frodo', capabilities: ['library.read', 'song.sync'], owner_plugin_id: 'frodo_library' },
        { id: 'remote:sam', label: 'Sam', capabilities: ['library.read'], owner_plugin_id: 'sam_library' },
    ];
    const window = loadCapabilities({ library: true });
    window.fetch = async (url) => {
        if (String(url) === '/api/library/providers') return { ok: true, json: async () => ({ providers: providerSet }) };
        throw new Error(`unexpected fetch ${url}`);
    };
    const api = window.feedBack.capabilities;

    await api.command('library', 'refresh-providers', { requester: 'test' });
    let ids = api.inspect('library').participants.map(p => p.pluginId);
    assert.ok(ids.includes('frodo_library'));
    assert.ok(ids.includes('sam_library'));

    // Sam is removed and the endpoint now omits it; the stale participant must
    // not linger in the capability registry / Inspector snapshot.
    providerSet = [
        { id: 'local', label: 'My Library', capabilities: ['library.read'], default: true },
        { id: 'remote:frodo', label: 'Frodo', capabilities: ['library.read', 'song.sync'], owner_plugin_id: 'frodo_library' },
    ];
    await api.command('library', 'refresh-providers', { requester: 'test' });
    ids = api.inspect('library').participants.map(p => p.pluginId);
    assert.ok(ids.includes('frodo_library'));
    assert.equal(ids.includes('sam_library'), false);
    assert.ok(ids.includes('core.library.local'));

    // A fetch failure falls back to local-only — all remote providers drop.
    window.fetch = async () => { throw new Error('network down'); };
    await api.command('library', 'refresh-providers', { requester: 'test' });
    ids = api.inspect('library').participants.map(p => p.pluginId);
    assert.equal(ids.includes('frodo_library'), false);
    assert.ok(ids.includes('core.library.local'));
});

test('a plugin with non-provider library roles is not wiped when its provider disappears', async () => {
    let providerSet = [
        { id: 'local', label: 'My Library', capabilities: ['library.read'], default: true },
        { id: 'remote:sam', label: 'Sam', capabilities: ['library.read'], owner_plugin_id: 'sam_library' },
    ];
    const window = loadCapabilities({ library: true });
    window.fetch = async (url) => {
        if (String(url) === '/api/library/providers') return { ok: true, json: async () => ({ providers: providerSet }) };
        throw new Error(`unexpected fetch ${url}`);
    };
    const api = window.feedBack.capabilities;

    // The same plugin also declares an observer library role via its manifest —
    // legitimate participation the provider-cleanup path must not delete.
    api.registerParticipants([{
        id: 'sam_library',
        name: 'Sam Library',
        runtime_domains: { library: { role: 'observer', observes: ['source-changed'] } },
    }]);

    await api.command('library', 'refresh-providers', { requester: 'test' });
    let sam = api.inspect('library').participants.find(p => p.pluginId === 'sam_library');
    assert.ok(sam);
    assert.ok(sam.roles.includes('provider'));
    assert.ok(sam.roles.includes('observer'));

    // Sam's provider is removed from the backend list. The participant stays
    // because it still carries the manifest-declared observer role.
    providerSet = [{ id: 'local', label: 'My Library', capabilities: ['library.read'], default: true }];
    await api.command('library', 'refresh-providers', { requester: 'test' });
    sam = api.inspect('library').participants.find(p => p.pluginId === 'sam_library');
    assert.ok(sam, 'plugin with a manifest library role must survive provider removal');
    assert.ok(sam.roles.includes('observer'));
});

test('runtime domain library declarations appear as library participants', () => {
    const window = loadCapabilities();
    const api = window.feedBack.capabilities;

    const touched = api.registerParticipants([{
        id: 'remote-library-client',
        name: 'Remote Library Client',
        runtime_domains: {
            library: {
                role: 'provider',
                operations: ['query-page'],
                description: 'Adds a remote source to the library provider list.',
            },
        },
    }]);

    assert.deepEqual(Array.from(touched), ['library']);
    const library = api.inspect('library');
    const participant = library.participants.find(item => item.pluginId === 'remote-library-client');
    assert.ok(participant);
    assert.deepEqual(Array.from(participant.roles), ['provider']);
    assert.ok(participant.operations.includes('query-page'));
    assert.equal(participant.description, 'Adds a remote source to the library provider list.');
    assert.equal(participant.ownership, 'exclusive-owner');
});