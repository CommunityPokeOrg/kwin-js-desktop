# Source this to get a session D-Bus address for pokede tools.
# Order: existing env -> KDE's ~/.dbus/session-bus file -> dbus-launch autolaunch.
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
    if [ -d "${HOME}/.dbus/session-bus" ]; then
        for f in "${HOME}/.dbus/session-bus"/*; do
            addr=$(grep -E "^DBUS_SESSION_BUS_ADDRESS=" "$f" 2>/dev/null | head -1 | sed "s/^DBUS_SESSION_BUS_ADDRESS=//; s/^'//; s/'\$//")
            if [ -n "$addr" ]; then
                export DBUS_SESSION_BUS_ADDRESS="$addr"
                break
            fi
        done
    fi
    if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -n "${DISPLAY:-}" ]; then
        export DBUS_SESSION_BUS_ADDRESS=$(dbus-launch --autolaunch=$(cat /var/lib/dbus/machine-id 2>/dev/null || cat /etc/machine-id) --sh-syntax 2>/dev/null | sed "s/^DBUS_SESSION_BUS_ADDRESS='//; s/';.*//")
    fi
fi
export DBUS_SESSION_BUS_ADDRESS
