/* PokeDE overlay client — consumes the bridge SSE feed and renders chat,
 * notifications, polls, and Devin status. Reconnects with backoff. Never
 * renders raw HTML — textContent only (chat text is untrusted). */
(function () {
    'use strict';

    var feed = document.getElementById('feed');
    var statusEl = document.getElementById('status');
    var statusText = document.getElementById('status-text');
    var pollBox = document.getElementById('poll');
    var pollQ = document.getElementById('poll-question');
    var pollOpts = document.getElementById('poll-options');
    var toasts = document.getElementById('toasts');
    var speech = document.getElementById('speech');
    var speechWho = document.getElementById('speech-who');
    var speechText = document.getElementById('speech-text');
    var speechTimer = null;
    var MAX_FEED = 40;

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function ts(t) {
        var d = new Date(t || Date.now());
        return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    }

    function pushMsg(cls, who, text, t) {
        var d = el('div', 'msg ' + cls);
        d.appendChild(el('span', 'when', ts(t)));
        if (who) d.appendChild(el('span', 'who', who));
        d.appendChild(document.createTextNode(text));
        feed.appendChild(d);
        while (feed.children.length > MAX_FEED) feed.removeChild(feed.firstChild);
    }

    function showSpeech(who, text) {
        speechWho.textContent = who;
        speechText.textContent = text;
        speech.classList.remove('hidden');
        if (speechTimer) clearTimeout(speechTimer);
        speechTimer = setTimeout(function () { speech.classList.add('hidden'); }, 10000);
    }

    function toast(title, body) {
        var t = el('div', 'toast');
        t.appendChild(el('div', 't', title));
        if (body) t.appendChild(el('div', 'b', body));
        toasts.appendChild(t);
        setTimeout(function () { t.remove(); }, 8000);
    }

    function renderPoll(p) {
        if (!p) { pollBox.classList.add('hidden'); return; }
        pollBox.classList.remove('hidden');
        pollQ.textContent = (p.closed ? '[ended] ' : '') + p.question;
        pollOpts.innerHTML = '';
        var total = p.counts.reduce(function (a, b) { return a + b; }, 0);
        p.options.forEach(function (opt, i) {
            var li = document.createElement('li');
            var pct = total ? Math.round((p.counts[i] / total) * 100) : 0;
            var label = el('div', 'label');
            label.appendChild(el('span', null, (i + 1) + '. ' + opt));
            label.appendChild(el('span', null, p.counts[i] + ' (' + pct + '%)'));
            var bar = el('div', 'bar');
            var fill = document.createElement('i');
            fill.style.width = pct + '%';
            bar.appendChild(fill);
            li.appendChild(label);
            li.appendChild(bar);
            pollOpts.appendChild(li);
        });
    }

    function handle(evt) {
        switch (evt.type) {
            case 'hello':
                if (evt.status) statusText.textContent = evt.status;
                if (evt.poll) renderPoll(evt.poll);
                break;
            case 'status':
                statusText.textContent = evt.text || '';
                break;
            case 'chat':
                pushMsg('', evt.user + ':', ' ' + evt.text, evt.ts);
                break;
            case 'say':
                pushMsg('say', 'Devin #' + (evt.seq || '') + ':', ' ' + evt.text, evt.ts);
                showSpeech('Devin ▸', evt.text || '');
                break;
            case 'reply': {
                var target = evt.user ? 'Devin ▸ ' + evt.user + ':' : 'Devin:';
                pushMsg('reply', target, ' ' + evt.text, evt.ts);
                showSpeech(target, evt.text || '');
                break;
            }
            case 'filtered':
                pushMsg('filtered', null, '[filtered: ' + evt.reason + ']', evt.ts);
                break;
            case 'info':
                pushMsg('info', null, '· ' + evt.text, evt.ts);
                break;
            case 'notify':
                toast(evt.title || 'notice', evt.text);
                break;
            case 'poll:start':
            case 'poll:update':
            case 'poll:end':
                renderPoll(evt.poll);
                break;
        }
    }

    var backoff = 1000;
    function connect() {
        var es = new EventSource('/events');
        es.onopen = function () {
            backoff = 1000;
            statusEl.classList.remove('offline');
        };
        es.onmessage = function (e) {
            try { handle(JSON.parse(e.data)); } catch (err) { /* malformed event */ }
        };
        es.onerror = function () {
            es.close();
            statusEl.classList.add('offline');
            setTimeout(connect, backoff);
            backoff = Math.min(backoff * 2, 15000);
        };
    }
    connect();
})();
