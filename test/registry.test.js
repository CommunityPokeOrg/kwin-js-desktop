'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { WindowRegistry } = require('../src/registry');

const winA = JSON.stringify({ key: 'a', caption: 'Alpha', resourceClass: 'term', active: true, kind: 'normal' });
const winB = JSON.stringify({ key: 'b', caption: 'Beta', resourceClass: 'browser', kind: 'normal' });

describe('WindowRegistry (pure store)', () => {
    test('report adds and updates windows', () => {
        const r = new WindowRegistry();
        assert.equal(r.report(winA).added, true);
        assert.equal(r.windows.size, 1);
        const upd = JSON.stringify({ key: 'a', caption: 'Alpha2', active: true });
        assert.equal(r.report(upd).added, false);
        assert.equal(r.get('a').caption, 'Alpha2');
    });

    test('sync replaces the table and diffs added/removed', () => {
        const r = new WindowRegistry();
        r.report(winA);
        r.report(winB);
        const { added, removed } = r.sync(JSON.stringify([winB]));
        assert.deepEqual(removed, ['a']);
        assert.deepEqual(added.map((w) => w.key), []);
        assert.equal(r.windows.size, 1);
    });

    test('remove tracks focus', () => {
        const r = new WindowRegistry();
        r.report(winA);
        r.focus('a');
        assert.equal(r.focusedKey, 'a');
        r.remove('a');
        assert.equal(r.focusedKey, null);
    });

    test('rejects malformed payloads', () => {
        const r = new WindowRegistry();
        assert.throws(() => r.report('not json'), /invalid JSON/);
        assert.throws(() => r.report('{"caption":"no key"}'), /key/);
        assert.throws(() => r.sync('{"a":1}'), /array/);
    });
});

describe('Registry D-Bus service', () => {
    const { spawnSync, spawn } = require('node:child_process');
    const { once } = require('node:events');

    async function privateBus() {
        const p = spawn('dbus-daemon', ['--session', '--print-address', '--nofork'], { stdio: ['ignore', 'pipe', 'inherit'] });
        const [line] = await once(p.stdout, 'data');
        const address = String(line).split('\n')[0].trim();
        return { proc: p, address };
    }

    test('end-to-end over a private bus: service + mock bridge + signals', async (t) => {
        const { address, proc } = await privateBus();
        t.after(() => proc.kill());
        process.env.DBUS_SESSION_BUS_ADDRESS = address;

        const dbus = require('dbus-next');
        const { startRegistry } = require('../src/registry-service');
        const { iface } = await startRegistry({ verbose: false });

        // A "mock bridge" client: the same calls main.js makes via callDBus.
        const client = dbus.sessionBus();
        const obj = await client.getProxyObject(
            'org.communitypoke.desktop.Registry',
            '/org/communitypoke/desktop/Registry'
        );
        const reg = obj.getInterface('org.communitypoke.desktop.Registry');

        const added = [];
        reg.on('WindowAdded', (json) => added.push(JSON.parse(json)));

        await reg.ReportWindow(winA);
        await reg.ReportWindow(winB);
        const list = JSON.parse(await reg.ListWindows());
        assert.equal(list.length, 2);
        assert.equal(added.length, 2);

        const removedSig = new Promise((res) => reg.once('WindowRemoved', res));
        await reg.RemoveWindow('a');
        assert.equal(await removedSig, 'a');
        assert.equal(JSON.parse(await reg.ListWindows()).length, 1);

        await reg.Sync(JSON.stringify([winA]));
        assert.equal(JSON.parse(await reg.ListWindows()).length, 1);

        const stats = JSON.parse(await reg.Stats());
        assert.equal(stats.count, 1);

        client.disconnect();
    });

    test('dbus-daemon is present for integration tests', () => {
        const res = spawnSync('dbus-daemon', ['--version']);
        assert.equal(res.status, 0);
    });
});
