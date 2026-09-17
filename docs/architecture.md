# PokeDE Architecture

A desktop-environment layer on top of KWin that exposes window state and KDE
control to JavaScript apps via the session D-Bus.

## Components

```
┌──────────────────────────────────────────────────────────────┐
│ KWin (X11 or Wayland)                                        │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ pokede-bridge  (kwin/bridge, a KWin script)             │ │
│  │  workspace.windowAdded / clientAdded  (K6 / K5 spell)   │ │
│  │  per-window property signals  →  workspace.callDBus ────┼─┼──┐
│  └─────────────────────────────────────────────────────────┘ │  │
└──────────────────────────────────────────────────────────────┘  │
              ▲                                                   │ method calls
              │ org.kde.KWin /Scripting (load/unload/status)      ▼
              │                        session D-Bus
┌──────────────────────────────────────────────────────────────┐  │
│ pokede registry daemon  (src/registry-service.js)            │◀─┘
│  org.communitypoke.desktop.Registry                          │
│  /org/communitypoke/desktop/Registry                         │
│   - Sync(json[]), ReportWindow(json), RemoveWindow(key)      │
│   - ReportFocus(key)                                         │
│   - ListWindows(), GetWindow(key), Stats()                   │
│   - signals: WindowAdded / WindowChanged / WindowRemoved /   │
│              FocusChanged                                    │
│   - properties: WindowCount, LastEventAt                     │
└──────────────────────────────────────────────────────────────┘
              ▲
              │ proxy + signals
┌──────────────────────────────────────────────────────────────┐
│ pokede JS API host  (src/jsapi.js, `pokede run <script>`)    │
│  node:vm sandbox injecting a `desktop` object:               │
│   desktop.windows.{list,get,focused,on,onFocus}              │
│   desktop.kwin.{available,scripting.{load,unload,isLoaded},  │
│                 invoke}                                      │
│   desktop.dbus.{call,on}                                     │
└──────────────────────────────────────────────────────────────┘
```

## Design decisions

- **Bridge is events-only (KWin → bus).** KWin scripts can call out via
  `workspace.callDBus` but cannot *own* a bus name or receive calls. Commands
  into KWin (`loadScript`, window ops) use KWin's own `org.kde.KWin` service,
  which the JS API wraps. Clean split: bridge = source, `org.kde.KWin` = sink.
- **Registry is the state owner.** The bridge is stateless — it re-emits the
  full window table on every structural event (`Sync`). An idle registry
  restart, a slow bridge, or a missed signal all self-heal on the next event.
- **JSON strings over D-Bus.** The KWin script engine marshals only basic
  variant types; a single `s` argument is the only ABI-safe channel. JSON also
  keeps the registry producer-agnostic (KWin bridge, test harness, a future
  Wayland bridge).
- **KWin 5 + KWin 6 shim in the bridge.** Signal names
  (`clientAdded`/`windowAdded`, `clientList`/`windowList`), property spellings
  (`frameGeometry`/`geometry`, `screen`/`output`, `shade`/`shaded`) are probed
  per-name so one script runs on both majors. See
  [platform-constraints.md](platform-constraints.md).
- **Node + dbus-next for the registry/host.** Pure-JS, no native build; Node's
  `vm` module gives app scripts a controlled global with the `desktop` API
  injected. (Convenience isolation, not a security boundary.)
- **Special windows are flagged, not filtered.** Panels/desktops/OSDs
  (plasmashell, QuickShell layer-surfaces on Wayland, docks) appear in the
  window list — the bridge tags them with `kind` so apps can decide.

## Data flow

1. `scripts/install-bridge.sh` (kpackagetool) or `pokede bridge-load`
   (org.kde.KWin `/Scripting` → `loadScript`) installs/loads the bridge.
2. Bridge serializes all managed windows, then re-syncs on every
   add/remove/desktop switch and reports property deltas per signal.
3. Registry merges `Sync`/`ReportWindow`/`RemoveWindow`, diffs the table, and
   fans out `WindowAdded`/`WindowChanged`/`WindowRemoved`/`FocusChanged`.
4. `pokede run script.js` connects the `desktop` API: list/get/focused
   queries plus event subscription; `desktop.kwin.scripting` and
   `desktop.dbus.call` cover the command path.

## Window record

See `src/registry.js` — fields mirror the bridge serializer: `key`
(`internalId`/`windowId`), `caption`, `resourceName/Class`, `geometry`,
`desktop`, `screen`, `minimized`, `active`, `kind`, focus/attention flags, `ts`.
