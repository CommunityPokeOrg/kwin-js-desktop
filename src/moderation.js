'use strict';

// Shared chat moderation for every PokeDE display pipeline (terminal monitor,
// OBS browser-source overlay, logs). Mirrors moderation.py — keep rules in
// sync. Fail-closed contract: moderate() returns a verdict; callers treat any
// thrown error as 'suppress'. Verdicts carry a reason code, never user text.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BLOCKLIST_FILE = process.env.POKEDE_BLOCKLIST ||
    path.join(os.homedir(), '.config/poke-stream/blocklist.txt');

const RATE_WINDOW_MS = 10_000;   // per-user message window
const RATE_MAX = 4;              // msgs per user per window
const MUTE_MS = 120_000;         // temp-mute after tripping the rate limit
const DEDUP_WINDOW_MS = 60_000;  // normalized-duplicate suppression window
const MAX_LINE = 220;

const RE_CHAR_RUN = /(.)\1{7,}/;                                    // 8+ identical chars
const RE_URL = /(https?:\/\/|www\.|\b\w+\.(com|net|org|gg|tv|io|shop|xyz|ru|cn)\b)/i;
const RE_TOKEN_SPAM = /(\b\w+\b)(\s+\1\b){3,}/;                     // same word 4+ times
const RE_DANGEROUS_CMD = /^\s*![\w-]*(token|secret|key|pass|oauth|cred|password|api|exec|eval|shell)[\w-]*/i;

const SECRET_PATTERNS = [
    /oauth:[A-Za-z0-9_-]+/gi,
    /live_\d+_[A-Za-z0-9]+/gi,
    /bearer\s+[A-Za-z0-9_\-.]+/gi,
    /[A-Za-z0-9_-]{30,}/g,
];

function normUser(u) {
    return String(u).trim().replace(/^@/, '').toLowerCase();
}

function normMsg(t) {
    return String(t)
        .normalize('NFKC')
        .toLowerCase()
        .replace(/(.)\1{2,}/g, '$1$1')   // collapse 3+ char repeats to 2
        .replace(/[^a-z0-9]+/g, '');
}

function redact(text) {
    let out = String(text).replace(/[\x00-\x1f\x7f]/g, '');
    for (const p of SECRET_PATTERNS) out = out.replace(p, '[redacted]');
    return out.slice(0, MAX_LINE);
}

class Moderator {
    constructor({ blocklistFile = BLOCKLIST_FILE } = {}) {
        this.blocklistFile = blocklistFile;
        this._blocklist = new Set();
        this._blocklistMtime = 0;
        this._userWindow = new Map();
        this._userMutedUntil = new Map();
        this._recent = new Map();
        this.suppressed = 0;
    }

    reloadBlocklist() {
        let mtime;
        try {
            mtime = fs.statSync(this.blocklistFile).st_mtime;
        } catch {
            return this._blocklist;      // missing file: keep last known set
        }
        if (mtime !== this._blocklistMtime) {
            const users = new Set();
            for (const line of fs.readFileSync(this.blocklistFile, 'utf8').split('\n')) {
                const t = line.trim();
                if (t && !t.startsWith('#')) users.add(normUser(t));
            }
            this._blocklist = users;
            this._blocklistMtime = mtime;
        }
        return this._blocklist;
    }

    _gc(now) {
        for (const [k, v] of this._recent) {
            if (now - v.ts > DEDUP_WINDOW_MS) this._recent.delete(k);
        }
        for (const [u, ts] of this._userWindow) {
            const live = ts.filter((t) => now - t < RATE_WINDOW_MS);
            if (live.length) this._userWindow.set(u, live);
            else this._userWindow.delete(u);
        }
    }

    /** -> { show: bool, reason: string|null, text: string|null } */
    moderate(user, text) {
        const now = Date.now();
        this._gc(now);
        this.reloadBlocklist();
        const u = normUser(user);
        const drop = (reason) => {
            this.suppressed += 1;
            return { show: false, reason, text: null };
        };

        if (this._blocklist.has(u)) return drop('blocked');
        if (now < (this._userMutedUntil.get(u) || 0)) return drop('muted');

        const win = this._userWindow.get(u) || [];
        win.push(now);
        this._userWindow.set(u, win);
        if (win.length > RATE_MAX) {
            this._userMutedUntil.set(u, now + MUTE_MS);
            return drop('rate');
        }

        if (RE_DANGEROUS_CMD.test(text)) return drop('cmd');

        const key = normMsg(text);
        if (key) {
            const prev = this._recent.get(key);
            if (prev && now - prev.ts < DEDUP_WINDOW_MS) {
                this._recent.set(key, { count: prev.count + 1, ts: prev.ts });
                return drop('dup');
            }
            this._recent.set(key, { count: 1, ts: now });
        }

        if (RE_URL.test(text)) return drop('link');
        if (RE_CHAR_RUN.test(text)) return drop('spam:charrun');
        if (RE_TOKEN_SPAM.test(text)) return drop('spam:tokrun');
        const alpha = [...text].filter((c) => /[a-zA-Z]/.test(c));
        if (text.length > 24 && alpha.length &&
            alpha.filter((c) => c === c.toUpperCase()).length / alpha.length > 0.85) {
            return drop('spam:caps');
        }

        return { show: true, reason: null, text: redact(text) };
    }
}

module.exports = { Moderator, redact, normUser, normMsg, BLOCKLIST_FILE };
