# kwin-js-desktop

A desktop-environment layer for KDE: a **KWin script bridge** that syncs the
window table to a **session D-Bus registry**, plus a **JavaScript scripting
API** that apps and KDE-level automation use to observe and drive the desktop.

- `kwin/bridge` — KWin script (KWin 5 + 6) publishing window events to D-Bus
- `src/registry*` — canonical window state as `org.communitypoke.desktop.Registry`
- `src/jsapi.js` — `desktop` API injected into `node:vm` scripts
- `bin/pokede.js` — CLI: `registry`, `windows`, `run`, `bridge-load`, `status`
- `docs/` — [architecture](docs/architecture.md) and
  [platform constraints](docs/platform-constraints.md) (KWin 5/6, X11/Wayland,
  QuickShell/layer-shell)
- `examples/` — `watch-windows.js`, `tile-new-windows.js`

## Quickstart

```sh
source scripts/session-env.sh     # get DBUS_SESSION_BUS_ADDRESS on KDE
npm install
npm test                          # store unit tests + private-bus integration

pokede registry &                 # or: node bin/pokede.js registry
pokede bridge-load                # load bridge into the running KWin
pokede status                     # registry / kwin / bridge health
pokede windows                    # current window table as JSON
pokede run examples/watch-windows.js
```

For a persistent install (survives session restarts, toggleable in System
Settings → KWin Scripts): `scripts/install-bridge.sh`.

## Design in one paragraph

KWin scripts can *emit* D-Bus calls but can't *receive* them, so the bridge is
events-only: it serializes the window table and pushes `Sync`/`ReportWindow`/
`RemoveWindow`/`ReportFocus` to the registry on every KWin signal. The
registry diffs the table and fans out signals. Commands flow the other way
through KWin's own `org.kde.KWin` D-Bus surface (`/Scripting` for script
lifecycle). KWin 5/6 API differences (`clientAdded` vs `windowAdded`,
`clientList` vs `windowList`, `frameGeometry`, `output`…) are shimmed inside
the bridge with per-name probing. See [docs/architecture.md](docs/architecture.md).

## Status

Validated end-to-end on KWin 5.24 (X11, Ubuntu 22.04): bridge loads via
`/Scripting.loadScript`, windows register/deregister as they map/unmap, and
the JS API lists them. Wayland/KWin 6 paths are coded via the compat shim but
need a Wayland session to verify. Roadmap: shell-UI layer (QuickShell on
Wayland), tiling automation on top of `desktop.windows` events, packaged
systemd --user unit for the registry.
