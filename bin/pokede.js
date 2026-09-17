#!/usr/bin/env node
'use strict';

const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const BRIDGE_MAIN = path.join(REPO_ROOT, 'kwin/bridge/contents/code/main.js');
const BRIDGE_PLUGIN = 'pokede-bridge';

function usage() {
    console.log(`pokede — PokeDE control CLI

usage: pokede <command> [args]

  registry                 run the window registry D-Bus daemon (foreground)
  windows                  print the window list as JSON
  stats                    print registry stats
  run <script.js>          execute a script with the PokeDE desktop API injected
  bridge-load [main.js]    load the bridge into the running KWin via /Scripting
  bridge-unload            unload the bridge from KWin
  bridge-status            is the bridge loaded in KWin
  status                   session health: bus, registry, KWin, bridge
`);
}

async function dbusProxy(service, objectPath, iface) {
    const dbus = require('dbus-next');
    const bus = dbus.sessionBus();
    const obj = await bus.getProxyObject(service, objectPath);
    return obj.getInterface(iface);
}

async function registryIface() {
    return dbusProxy(
        'org.communitypoke.desktop.Registry',
        '/org/communitypoke/desktop/Registry',
        'org.communitypoke.desktop.Registry'
    );
}

async function kwinScripting() {
    return dbusProxy('org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting');
}

const cmd = process.argv[2];

(async () => {
    switch (cmd) {
        case 'registry': {
            const { startRegistry } = require('../src/registry-service');
            await startRegistry();
            break;
        }
        case 'windows': {
            const r = await registryIface();
            console.log(JSON.stringify(JSON.parse(await r.ListWindows()), null, 2));
            break;
        }
        case 'stats': {
            const r = await registryIface();
            console.log(await r.Stats());
            break;
        }
        case 'run': {
            const file = process.argv[3];
            if (!file) { usage(); process.exit(2); }
            const { runScript } = require('../src/jsapi');
            await runScript(file);
            break;
        }
        case 'bridge-load': {
            const s = await kwinScripting();
            const main = process.argv[3] || BRIDGE_MAIN;
            const id = await s.loadScript(main, BRIDGE_PLUGIN);
            // KWin 5.24 loads scripts inert: org.kde.kwin.Scripting.start()
            // runs all loaded (not-yet-running) scripts.
            await s.start();
            console.log(`bridge loaded and started (script id ${id}, plugin ${BRIDGE_PLUGIN})`);
            break;
        }
        case 'bridge-unload': {
            const s = await kwinScripting();
            const ok = await s.unloadScript(BRIDGE_PLUGIN);
            console.log(ok ? 'bridge unloaded' : 'bridge was not loaded');
            break;
        }
        case 'bridge-status': {
            const s = await kwinScripting();
            const loaded = await s.isScriptLoaded(BRIDGE_PLUGIN);
            console.log(loaded ? 'loaded' : 'not loaded');
            break;
        }
        case 'status': {
            const checks = [];
            try { await registryIface(); checks.push('registry: up'); }
            catch (e) { checks.push('registry: DOWN'); }
            try {
                const s = await kwinScripting();
                checks.push('kwin: up');
                checks.push(`bridge: ${await s.isScriptLoaded(BRIDGE_PLUGIN) ? 'loaded' : 'not loaded'}`);
            } catch (e) { checks.push('kwin: DOWN (no org.kde.KWin on session bus)'); }
            console.log(checks.join('\n'));
            break;
        }
        case undefined:
        case 'help':
        case '--help':
            usage();
            break;
        default:
            console.error(`unknown command: ${cmd}`);
            usage();
            process.exit(2);
    }
})().catch((e) => {
    console.error(`pokede: ${e.message || e}`);
    process.exit(1);
});
