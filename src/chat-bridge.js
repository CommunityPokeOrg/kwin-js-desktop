'use strict';

// PokeDE chat bridge — localhost-only HTTP+SSE daemon connecting Twitch IRC
// to OBS browser-source overlays and Devin.
//
//   Twitch IRC (src/irc.js) ──chat──> Moderator ──> SSE /events ──> overlay(s)
//        ▲                                                   ▲
//   outbound PRIVMSG                    POST /notify|poll|status (Devin)
//   (only with TWITCH_IRC_OAUTH)
//
// Security model: binds 127.0.0.1 only; mutating endpoints additionally
// require `Authorization: Bearer $POKEDE_BRIDGE_TOKEN` when that env var is
// set. Chat is moderated (blocklist, rate limits, dedup, spam heuristics,
// secret redaction) BEFORE it can reach any SSE consumer — filtered messages
// surface only as a `[filtered:<reason>]` event with no content. Command
// handling is allowlisted; unknown commands are dropped. Fail-closed: a
// moderation error suppresses the message.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Moderator, redact } = require('./moderation');
const { IrcClient } = require('./irc');

const OVERLAY_DIR = path.join(__dirname, '..', 'obs', 'overlay');
const STATE_DIR = process.env.POKEDE_STATE_DIR ||
    path.join(os.homedir(), '.local/state/poke-stream');
const COMMAND_QUEUE = path.join(STATE_DIR, 'commands.jsonl');

const DEFAULT_PORT = 8765;
const REPLY_COOLDOWN_MS = 20_000;   // min gap between outbound chat replies
const MAX_CHAT_FEED = 200;          // in-memory ring for /log
const POLL_MAX_OPTIONS = 9;

// Commands viewers may run. Anything not here is silently dropped.
const COMMAND_ALLOWLIST = new Set(['status', 'uptime', 'repo', 'pr', 'vote']);

function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
}

function createBridge({
    port = DEFAULT_PORT,
    channel = '#wolfyblair',
    ircFactory = null,          // inject a fake client in tests
    startedAt = Date.now()
} = {}) {
    const moderator = new Moderator();
    const clients = new Set();           // SSE response objects
    const feed = [];                     // recent display lines (ring)
    const pendingCommands = [];          // allowlisted cmds for Devin to drain
    const state = {
        joined: false,
        outbound: false,
        statusText: 'PokeDE dev session — building KWin window-sync desktop env',
        poll: null                       // {question, options, votes:Map, endsAt, closed}
    };
    let lastReplyAt = 0;
    let saySeq = 0;
    let lastSayAt = 0;
    const sayQueue = [];

    const SAY_COOLDOWN_MS = 1500;
    const SAY_MAX_QUEUE = 5;

    function flushSay() {
        const now = Date.now();
        if (!sayQueue.length || now - lastSayAt < SAY_COOLDOWN_MS) return;
        const text = sayQueue.shift();
        lastSayAt = now;
        broadcast('say', { seq: ++saySeq, text });
        if (sayQueue.length) setTimeout(flushSay, SAY_COOLDOWN_MS).unref?.();
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });

    function broadcast(type, data) {
        const evt = { type, ...data, ts: Date.now() };
        if (type === 'chat' || type === 'filtered' || type === 'reply' || type === 'info' || type === 'say') {
            feed.push(evt);
            if (feed.length > MAX_CHAT_FEED) feed.shift();
        }
        const payload = `data: ${JSON.stringify(evt)}\n\n`;
        for (const res of clients) {
            try { res.write(payload); } catch { clients.delete(res); }
        }
        return evt;
    }

    function queueCommand(user, cmd, args) {
        pendingCommands.push({ user, cmd, args, ts: Date.now() });
        try {
            fs.appendFileSync(COMMAND_QUEUE, JSON.stringify({ user, cmd, args, ts: Date.now() }) + '\n');
        } catch { /* queue file is best-effort */ }
    }

    function cannedReply(cmd) {
        switch (cmd) {
            case 'status': return state.statusText;
            case 'uptime': return `session up ${Math.round((Date.now() - startedAt) / 60000)} min`;
            case 'repo': return 'github.com/CommunityPokeOrg/kwin-js-desktop';
            case 'pr': return 'latest: CommunityPokeOrg/kwin-js-desktop#1';
            default: return null;
        }
    }

    function reply(user, text) {
        // Overlay-visible either way; lands in Twitch chat only with OAuth.
        broadcast('reply', { user, text: redact(text) });
        if (irc && irc.outbound && Date.now() - lastReplyAt > REPLY_COOLDOWN_MS) {
            const out = user ? `@${user} ${text}` : String(text);
            if (irc.sendPrivmsg(out)) lastReplyAt = Date.now();
        }
    }

    function recordVote(user, n) {
        const p = state.poll;
        if (!p || p.closed || Date.now() > p.endsAt) return;
        if (!(n >= 1 && n <= p.options.length)) return;
        if (p.votes.has(user)) {                    // one vote per user
            p.votes.set(user, n);                    // last vote wins
        } else {
            p.votes.set(user, n);
        }
        broadcast('poll:update', { poll: pollView() });
    }

    function pollView() {
        const p = state.poll;
        if (!p) return null;
        const counts = p.options.map((_, i) =>
            [...p.votes.values()].filter((v) => v === i + 1).length);
        return { question: p.question, options: p.options, counts, endsAt: p.endsAt, closed: p.closed };
    }

    function endPoll() {
        const p = state.poll;
        if (!p || p.closed) return;
        p.closed = true;
        broadcast('poll:end', { poll: pollView() });
    }

    function handleChat(user, text) {
        // Commands first — allowlist before moderation so legit commands
        // aren't eaten by dedup, but blocked/muted users get no commands.
        const u = user.trim().toLowerCase();
        if (moderator._blocklist.has(u) || Date.now() < (moderator._userMutedUntil.get(u) || 0)) {
            moderator.suppressed += 1;
            broadcast('filtered', { reason: 'blocked' });
            return;
        }

        const cmdMatch = text.match(/^!(\w+)(?:\s+(.*))?$/);
        if (cmdMatch) {
            const cmd = cmdMatch[1].toLowerCase();
            const args = cmdMatch[2] || '';
            if (!COMMAND_ALLOWLIST.has(cmd)) return;  // silent drop
            queueCommand(user, cmd, args);
            if (cmd === 'vote') {
                const n = parseInt(args, 10);
                if (state.poll) recordVote(u, n);
                return;
            }
            const ans = cannedReply(cmd);
            if (ans) reply(user, ans);
            return;
        }
        if (/^![1-9]$/.test(text) && state.poll) {
            recordVote(u, parseInt(text[1], 10));
            return;
        }

        let verdict;
        try {
            verdict = moderator.moderate(user, text);
        } catch (e) {
            verdict = { show: false, reason: 'filter-error', text: null };
        }
        if (!verdict.show) {
            broadcast('filtered', { reason: verdict.reason });
            return;
        }
        broadcast('chat', { user, text: verdict.text });
        // Mentions of the bot get a canned status answer — already past
        // moderation, so blocked/muted/spam senders never reach this.
        if (/@?pokede\b/i.test(verdict.text)) {
            reply(user, `hi ${user} — ${state.statusText}`);
        }
    }

    function ingestChat(user, text) { handleChat(user, text); }

    // --- IRC wiring ---
    let irc = null;
    if (ircFactory) {
        irc = ircFactory();
    } else {
        irc = new IrcClient({
            channel,
            nick: process.env.TWITCH_IRC_NICK || undefined,
            oauth: process.env.TWITCH_IRC_OAUTH || undefined
        });
    }
    state.outbound = irc.outbound;
    irc.on('chat', ({ user, text }) => handleChat(user, text));
    irc.on('joined', (ch) => { state.joined = true; broadcast('info', { text: `joined ${ch}` }); });
    irc.on('disconnected', () => { state.joined = false; broadcast('info', { text: 'chat disconnected, reconnecting' }); });
    irc.on('authFailed', () => { state.outbound = false; });
    if (irc.start) irc.start();

    // --- HTTP surface (loopback only) ---
    const token = process.env.POKEDE_BRIDGE_TOKEN || null;
    function authorized(req) {
        if (!token) return true;              // loopback-only deployment
        return req.headers.authorization === `Bearer ${token}`;
    }

    function readBody(req) {
        return new Promise((resolve) => {
            let b = '';
            req.on('data', (c) => { b += c; if (b.length > 64_000) req.destroy(); });
            req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
        });
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');

        if (req.method === 'GET' && url.pathname === '/events') {
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                'connection': 'keep-alive',
                'access-control-allow-origin': 'null'      // file:// / OBS browser source
            });
            res.write(`data: ${JSON.stringify({ type: 'hello', status: state.statusText, poll: pollView(), ts: Date.now() })}\n\n`);
            for (const e of feed.slice(-50)) res.write(`data: ${JSON.stringify(e)}\n\n`);
            clients.add(res);
            req.on('close', () => clients.delete(res));
            return;
        }

        if (req.method === 'GET' && url.pathname === '/health') {
            return json(res, 200, {
                joined: state.joined,
                outbound: state.outbound,
                suppressed: moderator.suppressed,
                poll: pollView(),
                clients: clients.size
            });
        }

        if (req.method === 'GET' && url.pathname === '/log') {
            return json(res, 200, { feed: feed.slice(-50) });
        }

        if (req.method === 'GET' && url.pathname === '/commands') {
            const drained = pendingCommands.splice(0, pendingCommands.length);
            return json(res, 200, { commands: drained });
        }

        if (req.method === 'GET' && (url.pathname === '/overlay' || url.pathname === '/')) {
            return serveFile(res, path.join(OVERLAY_DIR, 'index.html'), 'text/html');
        }
        if (req.method === 'GET' && url.pathname.startsWith('/overlay/')) {
            const file = path.normalize(path.join(OVERLAY_DIR, url.pathname.slice('/overlay/'.length)));
            if (!file.startsWith(OVERLAY_DIR)) return json(res, 403, { error: 'forbidden' });
            const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' };
            return serveFile(res, file, types[path.extname(file)] || 'application/octet-stream');
        }

        if (req.method === 'POST') {
            if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
            const body = await readBody(req);
            if (url.pathname === '/notify') {
                broadcast('notify', { title: String(body.title || ''), text: redact(String(body.text || '')) });
                return json(res, 200, { ok: true });
            }
            if (url.pathname === '/status') {
                state.statusText = redact(String(body.text || ''));
                broadcast('status', { text: state.statusText });
                return json(res, 200, { ok: true });
            }
            if (url.pathname === '/poll') {
                const options = Array.isArray(body.options)
                    ? body.options.slice(0, POLL_MAX_OPTIONS).map((o) => redact(String(o)).slice(0, 60))
                    : [];
                const seconds = Math.min(Math.max(parseInt(body.seconds, 10) || 60, 10), 600);
                if (!body.question || options.length < 2) return json(res, 400, { error: 'need question + 2+ options' });
                state.poll = {
                    question: redact(String(body.question)).slice(0, 140),
                    options,
                    votes: new Map(),
                    endsAt: Date.now() + seconds * 1000,
                    closed: false
                };
                broadcast('poll:start', { poll: pollView() });
                setTimeout(endPoll, seconds * 1000).unref();
                return json(res, 200, { ok: true, poll: pollView() });
            }
            if (url.pathname === '/say') {
                const text = redact(String(body.text || '')).slice(0, 200);
                if (!text) return json(res, 400, { error: 'empty text' });
                if (sayQueue.length >= SAY_MAX_QUEUE) return json(res, 429, { error: 'say queue full' });
                sayQueue.push(text);
                flushSay();
                if (sayQueue.length) setTimeout(flushSay, SAY_COOLDOWN_MS).unref?.();
                return json(res, 200, { ok: true, queued: sayQueue.length });
            }
            if (url.pathname === '/reply') {   // direct Devin response to a chatter
                const user = redact(String(body.user || '')).slice(0, 40);
                const text = redact(String(body.text || '')).slice(0, 200);
                if (!text) return json(res, 400, { error: 'empty text' });
                reply(user || null, text);
                return json(res, 200, { ok: true });
            }
            if (url.pathname === '/command') {   // inject a chat line (tests/devin)
                handleChat(String(body.user || 'devin'), String(body.text || ''));
                return json(res, 200, { ok: true });
            }
            return json(res, 404, { error: 'unknown endpoint' });
        }

        json(res, 404, { error: 'not found' });
    });

    function serveFile(res, file, type) {
        fs.readFile(file, (err, data) => {
            if (err) return json(res, 404, { error: 'not found' });
            res.writeHead(200, { 'content-type': type });
            res.end(data);
        });
    }

    function listen() {
        return new Promise((resolve) => {
            server.listen(port, '127.0.0.1', () => resolve(server.address().port));
        });
    }

    return { server, listen, broadcast, ingestChat, state, moderator, reply, say: flushSay, irc };
}

if (require.main === module) {
    const bridge = createBridge({ port: parseInt(process.env.POKEDE_BRIDGE_PORT || String(DEFAULT_PORT), 10) });
    bridge.listen().then((p) => {
        console.log(`[chat-bridge] http://127.0.0.1:${p}/overlay  (channel ${process.env.TWITCH_IRC_CHANNEL || '#wolfyblair'})`);
    });
}

module.exports = { createBridge, COMMAND_ALLOWLIST, DEFAULT_PORT };
