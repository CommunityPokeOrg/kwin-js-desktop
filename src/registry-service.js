'use strict';

const dbus = require('dbus-next');
const { Interface } = dbus.interface;
const { WindowRegistry } = require('./registry');

const SERVICE = 'org.communitypoke.desktop.Registry';
const OBJECT_PATH = '/org/communitypoke/desktop/Registry';
const IFACE = 'org.communitypoke.desktop.Registry';

// org.communitypoke.desktop.Registry — session-bus window registry.
// Methods take/return JSON strings so any producer (the KWin script engine
// only marshals basic types) can talk to it without a shared schema lib.
class RegistryInterface extends Interface {
    constructor(registry, hooks) {
        super(IFACE);
        this._registry = registry;
        this._hooks = hooks;
    }

    Sync(json) {
        const { added, removed } = this._registry.sync(json);
        for (const key of removed) this.emitSignal('WindowRemoved', key);
        for (const win of added) this.emitSignal('WindowAdded', JSON.stringify(win));
        this._emitCount();
        return JSON.stringify(this._registry.stats());
    }

    ReportWindow(json) {
        const { win, added } = this._registry.report(json);
        this.emitSignal(added ? 'WindowAdded' : 'WindowChanged', JSON.stringify(win));
        this._emitCount();
        return added;
    }

    RemoveWindow(key) {
        const existed = this._registry.remove(key);
        if (existed) {
            this.emitSignal('WindowRemoved', String(key));
            this._emitCount();
        }
        return existed;
    }

    // Inbound call from the bridge (a method — the KWin script engine can
    // only call, not listen). Fanned out as the FocusChanged signal below.
    ReportFocus(key) {
        this._registry.focus(key);
        this.FocusChanged(String(key));
        return true;
    }

    ListWindows() {
        return JSON.stringify(this._registry.list());
    }

    GetWindow(key) {
        const win = this._registry.get(key);
        return JSON.stringify(win);
    }

    Stats() {
        return JSON.stringify(this._registry.stats());
    }

    get WindowCount() {
        return this._registry.windows.size;
    }

    get LastEventAt() {
        return this._registry.lastEventAt || '';
    }

    // dbus-next emits a configured signal when its method is invoked; the
    // return value is marshaled as the signal body.
    WindowAdded(json) { return json; }
    WindowChanged(json) { return json; }
    WindowRemoved(key) { return key; }
    FocusChanged(key) { return key; }
    BridgeEvent(json) { return json; }

    emitSignal(name, ...args) {
        this[name](...args);
        this._hooks.onSignal?.(name, args);
    }

    _emitCount() {
        Interface.emitPropertiesChanged(this, {
            WindowCount: this.WindowCount,
            LastEventAt: this.LastEventAt
        });
    }
}

RegistryInterface.configureMembers({
    methods: {
        Sync: { inSignature: 's', outSignature: 's' },
        ReportWindow: { inSignature: 's', outSignature: 'b' },
        RemoveWindow: { inSignature: 's', outSignature: 'b' },
        ReportFocus: { inSignature: 's', outSignature: 'b' },
        ListWindows: { inSignature: '', outSignature: 's' },
        GetWindow: { inSignature: 's', outSignature: 's' },
        Stats: { inSignature: '', outSignature: 's' }
    },
    signals: {
        WindowAdded: { signature: 's' },
        WindowChanged: { signature: 's' },
        WindowRemoved: { signature: 's' },
        FocusChanged: { signature: 's' },
        BridgeEvent: { signature: 's' }
    },
    properties: {
        WindowCount: { signature: 'i', access: 'read' },
        LastEventAt: { signature: 's', access: 'read' }
    }
});

async function startRegistry({ bus, hooks = {}, verbose = true } = {}) {
    bus = bus || dbus.sessionBus();
    const registry = new WindowRegistry();
    const iface = new RegistryInterface(registry, hooks);
    await bus.requestName(SERVICE, 0x4); // NAME_FLAG_DO_NOT_QUEUE
    bus.export(OBJECT_PATH, iface);
    if (verbose) {
        console.log(`[registry] ${SERVICE} at ${OBJECT_PATH} on ${process.env.DBUS_SESSION_BUS_ADDRESS || 'default session bus'}`);
    }
    return { bus, registry, iface, SERVICE, OBJECT_PATH, IFACE };
}

module.exports = { startRegistry, SERVICE, OBJECT_PATH, IFACE, WindowRegistry };

if (require.main === module) {
    startRegistry().catch((e) => {
        console.error('[registry] failed:', e.message || e);
        process.exit(1);
    });
}
