#!/usr/bin/env bash
# Set Devin's current-activity line; the bridge watchdog picks it up and
# pushes it to the overlay header + a say bubble on next loop (~20s).
printf '%s' "$*" > "${HOME}/.local/state/poke-stream/devin-status.txt"
