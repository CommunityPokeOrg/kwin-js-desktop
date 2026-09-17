# OBS Integration — chat bridge + browser-source overlay

Bidirectional Devin↔Twitch-chat layer: a localhost bridge owns the IRC
connection and fans events out to any number of browser-source overlays.

## Components

```
Twitch IRC (irc.chat.twitch.tv:6697)
    │  src/irc.js — TLS, anonymous justinfan read; outbound only with
    │  TWITCH_IRC_OAUTH + TWITCH_IRC_NICK env (token never on argv/disk)
    ▼
src/chat-bridge.js — http://127.0.0.1:8765 (loopback only)
    ├── GET  /overlay[/*]   static overlay files (obs/overlay/)
    ├── GET  /events        Server-Sent Events: chat, filtered, say, reply,
    │                       notify, status, info, poll:*, hello
    ├── GET  /health        joined/outbound/suppressed/poll/clients
    ├── GET  /log           last ~50 feed events
    ├── GET  /commands      drain the allowlisted-command queue (Devin reads)
    ├── POST /notify        {title, text}  → toast on all overlays
    ├── POST /status        {text}         → header status line
    ├── POST /say           {text}         → Devin speech bubble (queued,
    │                                       1.5s min gap, seq-numbered)
    ├── POST /reply         {user, text}   → direct answer to a chatter
    ├── POST /poll          {question, options[], seconds} → chat poll
    └── POST /command       {user, text}   → inject a chat line (tests)
```

OBS browser source → `http://127.0.0.1:8765/overlay`. Works equally well in
any regular browser window (that's how it renders on a bare X11 stream with
no OBS).

## Moderation (src/moderation.js)

Every inbound line passes `moderate()` before it can reach an SSE client —
filtered messages emit only `{type:'filtered', reason}` with no content:

- **Blocklist** — `~/.config/poke-stream/blocklist.txt` (outside the repo,
  hot-reloaded on mtime change, usernames normalized lowercase). Override
  path with `POKEDE_BLOCKLIST`.
- **Per-user rate limit** — >4 msgs/10s → 120s mute (`rate`, then `muted`).
- **Dedup** — exact + normalized (lowercase, collapsed repeats, stripped
  punctuation) within 60s.
- **Heuristics** — URLs, 8+ char runs, repeated-token floods, caps floods.
- **Commands** — `!cmd` must be in `COMMAND_ALLOWLIST` (`status`, `uptime`,
  `repo`, `pr`, `vote`); everything else is silently dropped, dangerous
  prefixes (`!token`, `!secret`, `!exec`…) filtered even earlier.
- **Redaction** — `oauth:*`, `live_*`, `Bearer`, and 30+ char opaque strings
  masked inside any surviving text; applied to inbound AND outbound (`/say`,
  replies, notify, poll fields).
- **Fail-closed** — a moderation exception suppresses the message.

## Command routing

Allowlisted commands do two things: queue for Devin (`GET /commands` drains;
also appended to `~/.local/state/poke-stream/commands.jsonl`), and produce
canned safe replies (`!status` → current status line, `!uptime`, `!repo`,
`!pr`). `pokede`/`@pokede` mentions that survive moderation get a canned
status greeting. Replies render as `reply` events carrying the target
username on every overlay; they only reach Twitch chat itself when OAuth
env is configured — a 20s global cooldown applies either way. Blocked or
muted users never receive replies.

## Devin voice (`/say`, `/reply`)

`pokede say <text>` posts a sequenced, timestamped bubble (green accent)
meant for concise progress notes — "loading bridge into KWin", "tests
20/20 green". Bounded queue (5) + 1.5s min gap prevents flooding.
`pokede reply <user> <text>` answers a specific chatter directly. Both
fire the floating speech banner at the bottom of the overlay (~10s, large
type) in addition to the feed entry, so Devin's voice is readable even
when chat scrolls.

## CLI

```sh
pokede chat-bridge                      # run the daemon (foreground)
pokede say building overlay integration # Devin bubble
pokede reply wolfyblair on it — PR #1   # answer a chatter
pokede set-status refactoring registry  # header line
pokede notify CI tests green            # toast
pokede poll best editor :: kwrite,vim,emacs 60
```

## Security

- Loopback-only listener; `POKEDE_BRIDGE_TOKEN` (if set) requires
  `Authorization: Bearer` on all POSTs — unset means loopback is the gate.
- Overlay renders via `textContent` only — no HTML injection from chat.
- No secrets in source, argv, logs, or the repo. Blocklist/state live under
  `~/.config|~/.local/state`, gitignored patterns anyway.

## Limitations

- Read-only on Twitch without `TWITCH_IRC_OAUTH` — replies show on-overlay
  only. A Twitch OAuth token + nick enables real outbound.
- No autonomous semantic replies: Devin answers via canned status text
  (commands, @pokede mentions) or explicit `/reply` posts only.
- `/commands` is the Devin-input path: Devin polls it; there is no push
  channel into a Devin session — by design, commands are advisory.
- `pokede` CLI `fetch` requires Node ≥18 (engines field).
