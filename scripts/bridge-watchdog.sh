#!/usr/bin/env bash
# PokeDE chat-bridge watchdog — keeps the OBS chat bridge running and pushes
# Devin's current activity into the overlay.
#
#   loop every 20s:
#     1. /health probe; if the daemon is down -> respawn (setsid + nohup)
#     2. if $STATUS_FILE changed -> POST /status (header) + /say (bubble)
#
# The bridge itself handles IRC reconnects (5s backoff), bounded queues,
# moderation, and fail-closed suppression; this watchdog only covers process
# death and activity announcements. No secrets here: outbound text is
# redacted bridge-side and never leaves overlay without OAuth.

set -u
BRIDGE_DIR="${POKEDE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE_DIR="${HOME}/.local/state/poke-stream"
STATUS_FILE="${STATE_DIR}/devin-status.txt"
LOG="${STATE_DIR}/bridge.log"
BASE="http://127.0.0.1:${POKEDE_BRIDGE_PORT:-8765}"

mkdir -p "${STATE_DIR}"
touch "${STATUS_FILE}"

last_sig=""
announce() {
    [ -s "${STATUS_FILE}" ] || return 0
    sig="$(stat -c '%Y:%s' "${STATUS_FILE}" 2>/dev/null)"
    [ "${sig}" = "${last_sig}" ] && return 0
    last_sig="${sig}"
    text="$(head -c 200 "${STATUS_FILE}")"
    curl -sf -m 3 -X POST "${BASE}/status" -H 'content-type: application/json' \
        --data "{\"text\":$(printf '%s' "${text}" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.stringify(s)))' 2>/dev/null || echo '"pokede dev session"')}" >/dev/null || return 0
    curl -sf -m 3 -X POST "${BASE}/say" -H 'content-type: application/json' \
        --data "{\"text\":$(printf '%s' "${text}" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.stringify(s)))' 2>/dev/null || echo '"working"')}" >/dev/null || true
}

while true; do
    if ! curl -sf -m 3 "${BASE}/health" >/dev/null 2>&1; then
        echo "[watchdog] bridge down, respawning $(date -u +%FT%TZ)" >>"${LOG}"
        setsid nohup node "${BRIDGE_DIR}/src/chat-bridge.js" >>"${LOG}" 2>&1 &
        sleep 4
    fi
    announce
    sleep 20
done
