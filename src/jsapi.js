'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dbus = require('dbus-next');

const REGISTRY_SERVICE = 'org.communitypoke.desktop.Registry';
const REGISTRY_PATH = '/org/communitypoke/desktop/Registry';
const REGISTRY_IFACE = 'org.communitypoke.desktop.Registry';
const KWIN_SERVICE = 'org.kde.KWin';

async function proxyInterface(bus, service, objectPath, ifaceName) {
    const obj = await bus.getProxyObject(service, objectPath);
    return obj.getInterface(ifaceName);
}

async function tryProxy(bus, service, objectPath, ifaceName) {
    try {
        return await proxyInterface(bus, service, objectPath, ifaceName);
    } catch (e) {
        return null;
    }
}

// The `desktop` object injected into app/KDE scripts.
//   desktop.windows.list()/get(key)      — registry queries
//   desktop.windows.on(evt, cb)          — 'added' | 'removed' | 'changed'
//   desktop.windows.onFocus(cb)
//   desktop.kwin.scripting.loadScript(path[, pluginName]) -> int id
//   desktop.kwin.scripting.unloadScript(pluginName)       -> bool
//   desktop.kwin.scripting.isScriptLoaded(pluginName)     -> bool
//   desktop.kwin.invoke(path, iface, method, ...args)     — raw KWin D-Bus call
//   desktop.dbus.call(service, path, iface, method, ...args)
//   desktop.dbus.on(service, path, iface, signal, cb)
//   desktop.log(...)
async function createDesktopApi() {
    const bus = dbus.sessionBus();
    const listeners = { added: [], removed: [], changed: [], focus: [] };

    const registry = await tryProxy(bus, REGISTRY_SERVICE, REGISTRY_PATH, REGISTRY_IFACE);

    const parseList = async () => {
        if (!registry) return [];
        const raw = await registry.ListWindows();
        return JSON.parse(raw || '[]');
    };

    if (registry) {
        registry.on('WindowAdded', (json) => {
            const w = JSON.parse(json);
            listeners.added.forEach((cb) => safe(cb, w));
        });
        registry.on('WindowChanged', (json) => {
            const w = JSON.parse(json);
            listeners.changed.forEach((cb) => safe(cb, w));
        });
        registry.on('WindowRemoved', (key) => {
            listeners.removed.forEach((cb) => safe(cb, key));
        });
    }

    function safe(cb, ...args) {
        try { cb(...args); } catch (e) { console.error('[jsapi] listener error:', e); }
    }

    const scripting = await tryProxy(bus, KWIN_SERVICE, '/Scripting', 'org.kde.kwin.Scripting');

    const desktop = {
        windows: {
            list: parseList,
            get: async (key) => (registry ? JSON.parse(await registry.GetWindow(String(key)) || 'null') : null),
            focused: async () => (await parseList()).find((w) => w.active) || null,
            on: (evt, cb) => {
                const map = { added: 'added', removed: 'removed', changed: 'changed' };
                if (!map[evt]) throw new Error(`unknown window event '${evt}' (added|removed|changed)`);
                listeners[map[evt]].push(cb);
            },
            onFocus: (cb) => listeners.focus.push(cb)
        },
        kwin: {
            available: () => scripting !== null,
            scripting: {
                loadScript: (filePath, pluginName) => {
                    if (!scripting) throw new Error('KWin scripting service unavailable');
                    return pluginName === undefined
                        ? scripting.loadScript(filePath)
                        : scripting.loadScript(filePath, pluginName);
                },
                unloadScript: (name) => scripting.unloadScript(name),
                isScriptLoaded: (name) => scripting.isScriptLoaded(name)
            },
            invoke: async (objectPath, iface, method, ...args) => {
                const i = await proxyInterface(bus, KWIN_SERVICE, objectPath, iface);
                if (typeof i[method] !== 'function') throw new Error(`no method ${method} on ${objectPath}#${iface}`);
                return i[method](...args);
            }
        },
        dbus: {
            call: async (service, objectPath, iface, method, ...args) => {
                const i = await proxyInterface(bus, service, objectPath, iface);
                if (typeof i[method] !== 'function') throw new Error(`no method ${method} on ${service}${objectPath}#${iface}`);
                return i[method](...args);
            },
            on: async (service, objectPath, ifaceName, signal, cb) => {
                const i = await proxyInterface(bus, service, objectPath, ifaceName);
                i.on(signal, (...args) => safe(cb, ...args));
            }
        },
        log: (...args) => console.log('[script]', ...args)
    };

    if (registry) {
        registry.on('FocusChanged', async (key) => {
            const w = registry ? await desktop.windows.get(key) : null;
            listeners.focus.forEach((cb) => safe(cb, w || { key }));
        });
        registry.on('WindowChanged', (json) => {
            const w = JSON.parse(json);
            if (w.active) listeners.focus.forEach((cb) => safe(cb, w));
        });
    }

    return { desktop, bus };
}

// Runs a user script inside a node:vm context with the `desktop` API injected.
// Convenience sandboxing only — it is not a security boundary.
async function runScript(file, { filename } = {}) {
    const { desktop, bus } = await createDesktopApi();
    const filePath = path.resolve(file);
    const code = fs.readFileSync(filePath, 'utf8');
    const sandbox = {
        desktop,
        console,
        setTimeout, setInterval, clearTimeout, clearInterval,
        queueMicrotask,
        module: undefined, require: undefined, process: undefined
    };
    const context = vm.createContext(sandbox);
    const result = await vm.runInContext(
        `(async () => { ${code}\n})()`,
        context,
        { filename: filename || filePath }
    );
    await result;
    return { desktop, bus };
}

module.exports = { createDesktopApi, runScript };
