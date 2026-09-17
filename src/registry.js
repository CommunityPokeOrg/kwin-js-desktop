'use strict';

// Canonical window state for the PokeDE session. Pure data layer — no D-Bus
// imports — so it is unit-testable without a bus. Events arrive as JSON from
// the KWin bridge (see kwin/bridge) or any other window source.
//
// Window record shape (mirrors the bridge serializer):
//   key, windowId, pid, caption, resourceName, resourceClass, windowRole,
//   desktop, screen, geometry {x,y,width,height}, minimized, active,
//   fullScreen, maximized, shaded, onAllDesktops, keepAbove, keepBelow,
//   skipTaskbar, skipPager, transient, modal, demandsAttention, kind, ts

class WindowRegistry {
    constructor() {
        this.windows = new Map();
        this.lastEventAt = null;
        this.focusedKey = null;
    }

    // Full-state sync from the bridge — replaces the table wholesale.
    sync(json) {
        let records;
        try {
            records = JSON.parse(json);
        } catch (e) {
            throw new Error(`Sync: invalid JSON payload: ${e.message}`);
        }
        if (!Array.isArray(records)) {
            throw new Error('Sync: payload must be a JSON array');
        }
        const added = [];
        const next = new Map();
        for (const raw of records) {
            const win = JSON.parse(raw);
            if (win && win.key) {
                if (!this.windows.has(win.key)) added.push(win);
                if (win.active) this.focusedKey = win.key;
                next.set(win.key, win);
            }
        }
        const removed = [];
        for (const key of this.windows.keys()) {
            if (!next.has(key)) removed.push(key);
        }
        this.windows = next;
        this.lastEventAt = new Date().toISOString();
        return { added, removed };
    }

    // Upsert one window record. Returns { win, added }.
    report(json) {
        let win;
        try {
            win = JSON.parse(json);
        } catch (e) {
            throw new Error(`ReportWindow: invalid JSON payload: ${e.message}`);
        }
        if (!win || !win.key) {
            throw new Error('ReportWindow: payload needs a "key" field');
        }
        const added = !this.windows.has(win.key);
        this.windows.set(win.key, win);
        if (win.active) this.focusedKey = win.key;
        this.lastEventAt = new Date().toISOString();
        return { win, added };
    }

    remove(key) {
        const existed = this.windows.delete(String(key));
        if (this.focusedKey === String(key)) this.focusedKey = null;
        this.lastEventAt = new Date().toISOString();
        return existed;
    }

    focus(key) {
        const k = String(key);
        if (this.windows.has(k)) {
            this.focusedKey = k;
            for (const [wk, w] of this.windows) {
                w.active = wk === k;
            }
        }
        this.lastEventAt = new Date().toISOString();
    }

    list() {
        return [...this.windows.values()];
    }

    get(key) {
        return this.windows.get(String(key)) || null;
    }

    stats() {
        return {
            count: this.windows.size,
            focusedKey: this.focusedKey,
            lastEventAt: this.lastEventAt
        };
    }
}

module.exports = { WindowRegistry };
