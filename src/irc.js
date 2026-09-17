'use strict';

// Minimal Twitch IRC client — no dependencies, TLS only.
// Read mode uses an anonymous `justinfan*` login (Twitch permits read-only
// chat without OAuth). Outbound replies activate only when
// TWITCH_IRC_OAUTH + TWITCH_IRC_NICK are set in the environment; the token
// is read from env and only ever written to the TLS socket.

const tls = require('node:tls');
const { EventEmitter } = require('node:events');

const HOST = 'irc.chat.twitch.tv';
const PORT = 6697;

/** Parse one IRC line -> { raw, tags, prefix, command, params, user, text }. */
function parseIrcLine(line) {
    const out = { raw: line, tags: {}, prefix: null, command: null, params: [], user: null, text: null };
    let rest = line;
    if (rest.startsWith('@')) {
        const sp = rest.indexOf(' ');
        for (const kv of rest.slice(1, sp).split(';')) {
            const [k, v] = kv.split('=');
            out.tags[k] = v;
        }
        rest = rest.slice(sp + 1);
    }
    if (rest.startsWith(':')) {
        const sp = rest.indexOf(' ');
        out.prefix = rest.slice(1, sp);
        rest = rest.slice(sp + 1);
    }
    const trail = rest.indexOf(' :');
    if (trail !== -1) {
        out.text = rest.slice(trail + 2);
        rest = rest.slice(0, trail);
    }
    const parts = rest.split(' ').filter(Boolean);
    out.command = parts.shift() || null;
    out.params = parts;
    if (out.prefix && out.prefix.includes('!')) {
        out.user = out.prefix.slice(0, out.prefix.indexOf('!'));
    }
    return out;
}

class IrcClient extends EventEmitter {
    constructor({ channel, nick, oauth, host = HOST, port = PORT, reconnectMs = 5000 }) {
        super();
        this.channel = channel;
        this.oauth = oauth || null;
        this.nick = nick || (oauth ? null : `justinfan${Math.floor(10000 + Math.random() * 89999)}`);
        this.host = host;
        this.port = port;
        this.reconnectMs = reconnectMs;
        this.joined = false;
        this.connected = false;
        this._sock = null;
        this._buf = '';
        this._destroyed = false;
    }

    get outbound() {
        return Boolean(this.oauth && this.nick && !this.nick.startsWith('justinfan'));
    }

    start() {
        this._destroyed = false;
        this._connect();
    }

    stop() {
        this._destroyed = true;
        if (this._sock) this._sock.destroy();
    }

    _connect() {
        const sock = tls.connect(this.port, this.host, { servername: this.host });
        this._sock = sock;
        sock.setEncoding('utf8');
        sock.on('secureConnect', () => {
            this.connected = true;
            this._send(`CAP REQ :twitch.tv/tags twitch.tv/commands`);
            this._send(this.oauth ? `PASS ${this.oauth}` : 'PASS schmoopiie'); // placeholder for anon
            this._send(`NICK ${this.nick}`);
            this._send(`JOIN ${this.channel}`);
        });
        sock.on('data', (d) => this._onData(d));
        const retry = () => {
            this.connected = false;
            this.joined = false;
            sock.destroy();
            if (!this._destroyed) {
                this.emit('disconnected');
                setTimeout(() => this._connect(), this.reconnectMs);
            }
        };
        sock.on('error', (e) => { this.emit('error', e); retry(); });
        sock.on('close', () => retry());
        sock.on('timeout', () => retry());
        sock.setTimeout(5 * 60_000); // Twitch PINGs keep this alive
    }

    _send(line) {
        try { this._sock.write(line + '\r\n'); } catch { /* dropping connection */ }
    }

    sendPrivmsg(text) {
        if (!this.outbound) return false;
        this._send(`PRIVMSG ${this.channel} :${text}`);
        return true;
    }

    _onData(data) {
        this._buf += data;
        let i;
        while ((i = this._buf.indexOf('\r\n')) !== -1) {
            const line = this._buf.slice(0, i);
            this._buf = this._buf.slice(i + 2);
            this._onLine(parseIrcLine(line));
        }
    }

    _onLine(m) {
        if (m.command === 'PING') {
            this._send('PONG ' + (m.text ? ':' + m.text : ''));
            return;
        }
        if (m.command === '001' || m.command === '376') return;
        if (m.command === 'JOIN' && m.user === this.nick) {
            this.joined = true;
            this.emit('joined', this.channel);
            return;
        }
        if (m.command === '353' || m.command === '366') { this.joined = true; return; }
        if (m.command === '403' || m.command === '464') {
            this.emit('authFailed', m.text || m.raw);
            return;
        }
        if (m.command === 'PRIVMSG' && m.user) {
            this.emit('chat', { user: m.user, text: m.text || '', tags: m.tags });
        }
    }
}

module.exports = { IrcClient, parseIrcLine, HOST, PORT };
