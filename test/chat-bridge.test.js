'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { parseIrcLine } = require('../src/irc');
const { Moderator, redact, normUser } = require('../src/moderation');
const { createBridge } = require('../src/chat-bridge');

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokede-test-'));
const blocklist = path.join(tmpdir, 'blocklist.txt');
fs.writeFileSync(blocklist, 'unsatisfactorymorassx\n');
process.env.POKEDE_BLOCKLIST = blocklist;
process.env.POKEDE_STATE_DIR = tmpdir;

function fakeIrc() {
    const c = new EventEmitter();
    c.outbound = false;
    c.start = () => {};
    c.sendPrivmsg = () => false;
    return c;
}

describe('IRC line parser', () => {
    test('PRIVMSG with tags', () => {
        const m = parseIrcLine('@badge-info=;badges= :someuser!someuser@someuser.tmi.twitch.tv PRIVMSG #chan :hello world');
        assert.equal(m.user, 'someuser');
        assert.equal(m.command, 'PRIVMSG');
        assert.equal(m.text, 'hello world');
        assert.equal(m.params[0], '#chan');
    });
    test('PING with trailing', () => {
        const m = parseIrcLine('PING :tmi.twitch.tv');
        assert.equal(m.command, 'PING');
        assert.equal(m.text, 'tmi.twitch.tv');
    });
});

describe('Moderator', () => {
    test('blocklist drops before anything else', () => {
        const mod = new Moderator({ blocklistFile: blocklist });
        const v = mod.moderate('UnSatisfactoryMorassX', 'Ai Viewers streamboo . Com');
        assert.equal(v.show, false);
        assert.equal(v.reason, 'blocked');
    });
    test('normalizes usernames for matching', () => {
        assert.equal(normUser('@UnSat_X'), 'unsat_x');
    });
    test('dedup: same normalized text suppressed within window', () => {
        const mod = new Moderator({ blocklistFile: blocklist });
        assert.equal(mod.moderate('a', 'hello!!').show, true);
        assert.equal(mod.moderate('a', 'HELLO!!!').reason, 'dup');
        assert.equal(mod.moderate('a', 'h e l l o ?!?').reason, 'dup');
    });
    test('rate limit trips then mutes', () => {
        const mod = new Moderator({ blocklistFile: blocklist });
        for (let i = 0; i < 4; i++) assert.equal(mod.moderate('spammer', 'msg' + i).show, true);
        assert.equal(mod.moderate('spammer', 'one more').reason, 'rate');
        assert.equal(mod.moderate('spammer', 'and again').reason, 'muted');
    });
    test('spam heuristics', () => {
        const mod = new Moderator({ blocklistFile: blocklist });
        assert.equal(mod.moderate('u1', 'check http://spam.example').reason, 'link');
        assert.equal(mod.moderate('u2', 'aaaaaaaaaaaaaaaaaaaa').reason, 'spam:charrun');
        assert.equal(mod.moderate('u3', 'LUL LUL LUL LUL').reason, 'spam:tokrun');
        assert.equal(mod.moderate('u4', 'THIS IS A VERY LOUD MESSAGE INDEED FRIEND').reason, 'spam:caps');
        assert.equal(mod.moderate('u5', '!token please').reason, 'cmd');
    });
    test('secret redaction inside kept messages', () => {
        const mod = new Moderator({ blocklistFile: blocklist });
        const v = mod.moderate('u', 'my oauth:abc123def456 thing');
        assert.equal(v.text.includes('oauth:abc123def456'), false);
        assert.match(v.text, /\[redacted\]/);
    });
});

describe('chat-bridge', () => {
    async function withBridge(fn) {
        const bridge = createBridge({ port: 0, ircFactory: fakeIrc });
        const port = await bridge.listen();
        try {
            await fn(bridge, `http://127.0.0.1:${port}`);
        } finally {
            bridge.server.close();
            bridge.irc.stop?.();
        }
    }

    function sse(url) {
        const got = [];
        return new Promise((resolve, reject) => {
            fetch(url + '/events').then(async (res) => {
                const reader = res.body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                const pump = () => reader.read().then(({ done, value }) => {
                    if (done) return;
                    buf += dec.decode(value);
                    const parts = buf.split('\n\n');
                    buf = parts.pop();
                    for (const p of parts) {
                        const line = p.trim();
                        if (line.startsWith('data: ')) got.push(JSON.parse(line.slice(6)));
                    }
                    if (got.length < 500) pump();   // stream until closed
                });
                pump();
                setTimeout(() => { reader.cancel(); resolve(got); }, 400);
            }).catch(reject);
        });
    }

    test('chat ingestion -> SSE, filtered events carry no content', async () => {
        await withBridge(async (bridge, base) => {
            const events = sse(base);
            await new Promise((r) => setTimeout(r, 60));
            bridge.ingestChat('viewer1', 'hello chat');
            bridge.ingestChat('unsatisfactorymorassx', 'spam ad goes here');
            const evs = await events;
            const chat = evs.find((e) => e.type === 'chat');
            const filt = evs.find((e) => e.type === 'filtered');
            assert.ok(chat);
            assert.equal(chat.user, 'viewer1');
            assert.ok(filt);
            assert.equal(filt.reason, 'blocked');
            assert.equal(filt.text, undefined);
        });
    });

    test('allowlisted commands queue for Devin + reply event; others dropped', async () => {
        await withBridge(async (bridge, base) => {
            const events = sse(base);
            await new Promise((r) => setTimeout(r, 60));
            bridge.ingestChat('viewer1', '!status');
            bridge.ingestChat('viewer1', '!runshell rm -rf');
            const evs = await events;
            const reply = evs.find((e) => e.type === 'reply');
            assert.ok(reply, 'expected a reply event for !status');
            const cmds = await (await fetch(base + '/commands')).json();
            assert.equal(cmds.commands.length, 1);
            assert.equal(cmds.commands[0].cmd, 'status');
        });
    });

    test('poll: start via API, votes from chat, tallies once per user', async () => {
        await withBridge(async (bridge, base) => {
            const r = await fetch(base + '/poll', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ question: 'editors?', options: ['kwrite', 'vim'], seconds: 60 })
            });
            assert.equal(r.status, 200);
            bridge.ingestChat('v1', '!vote 1');
            bridge.ingestChat('v2', '!2');
            bridge.ingestChat('v2', '!vote 1');   // v2 changes vote -> counts as 1
            const h = await (await fetch(base + '/health')).json();
            assert.deepEqual(h.poll.counts, [2, 0]);
        });
    });

    test('say: sequenced, redacted, broadcast to overlays', async () => {
        await withBridge(async (bridge, base) => {
            const events = sse(base);
            await new Promise((r) => setTimeout(r, 60));
            const post = (t) => fetch(base + '/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t }) });
            await post('first status update');
            await post('second update oauth:shouldberedacted');
            const evs = await events;
            const says = evs.filter((e) => e.type === 'say');
            assert.ok(says.length >= 1);
            assert.equal(says[0].seq, 1);
            const all = evs.map((e) => e.text).join(' ');
            assert.equal(all.includes('oauth:shouldberedacted'), false);
        });
    });

    test('reply: carries target user; mention and /reply route speak back', async () => {
        await withBridge(async (bridge, base) => {
            const events = sse(base);
            await new Promise((r) => setTimeout(r, 60));
            bridge.ingestChat('viewer1', '!uptime');
            bridge.ingestChat('curious2', 'hey @pokede what are you building?');
            bridge.ingestChat('unsatisfactorymorassx', '@pokede spam');   // blocked — never replies
            await fetch(base + '/reply', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ user: 'curious2', text: 'a KWin window-sync bridge, live' })
            });
            const evs = await events;
            const replies = evs.filter((e) => e.type === 'reply');
            assert.ok(replies.find((e) => e.user === 'viewer1'), '!uptime should reply to viewer1');
            const mention = replies.find((e) => e.user === 'curious2' && /hi curious2/.test(e.text));
            assert.ok(mention, '@pokede mention should get a canned status reply');
            assert.ok(replies.find((e) => e.text === 'a KWin window-sync bridge, live'));
            assert.ok(!replies.find((e) => e.user === 'unsatisfactorymorassx'), 'blocked user must get no reply');
        });
    });

    test('say: flood protection via bounded queue', async () => {
        await withBridge(async (bridge, base) => {
            const post = (t) => fetch(base + '/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t }) });
            for (let i = 0; i < 6; i++) await post('msg ' + i);
            const r = await post('overflow');
            assert.equal(r.status, 429);
        });
    });

    test('notify + status endpoints broadcast', async () => {
        await withBridge(async (bridge, base) => {
            const events = sse(base);
            await new Promise((r) => setTimeout(r, 60));
            await fetch(base + '/notify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'CI', text: 'tests green' }) });
            await fetch(base + '/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'building overlay' }) });
            const evs = await events;
            assert.ok(evs.find((e) => e.type === 'notify' && e.title === 'CI'));
            assert.ok(evs.find((e) => e.type === 'status' && e.text === 'building overlay'));
        });
    });
});
