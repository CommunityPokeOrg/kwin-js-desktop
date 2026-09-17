# Platform Constraints

What the bridge and registry can and cannot see, per KWin version and
compositor. Verified against KWin 5.24 (X11) on Ubuntu 22.04 unless noted.

## KWin 5 vs KWin 6 scripting API

| Concern | KWin 5 (5.24 verified) | KWin 6 |
|---|---|---|
| Add/remove signals | `workspace.clientAdded`, `clientRemoved` | `workspace.windowAdded`, `windowRemoved` |
| Window list | `workspace.clientList()` | `workspace.windowList()` |
| Activation | `clientActivated` | `windowActivated` |
| Window object | `AbstractClient`/`Client` | `Window` |
| Geometry | `client.geometry`, `frameGeometry` (QRect) | `window.frameGeometry` (QRectF) |
| Screen/output | `client.screen` | `window.output` |
| Shading | `client.shade` | `window.shaded` |
| Metadata format | metadata.json or metadata.desktop | metadata.json required |
| D-Bus scripting iface | `org.kde.KWin /Scripting` — `loadScript`, `unloadScript`, `isScriptLoaded`, `loadDeclarativeScript`, `start` | same object, plugin ids enforced |
| JS engine | QJSEngine (Qt5) | QJSEngine (Qt6) — strict-mode differences; avoid Qt4-era idioms |

`loadScript(filePath[, pluginName])` returns an int id; loaded scripts start
immediately. Verified on 5.24: `qdbus org.kde.KWin /Scripting` exposes the
methods above.

## X11 vs Wayland (KWin compositor)

- **Window identity.** X11 clients have a real `windowId` (XID); Wayland
  windows get a synthetic handle — use `internalId` (stable UUID) as the
  registry key on both.
- **`resourceName`/`resourceClass`.** Reliable for X11 and XWayland clients.
  Native Wayland clients may leave `resourceName` empty or map it differently;
  `resourceClass` is the app-id analog.
- **Window ops.** `callDBus`-visible state is compositor-neutral, but
  move/resize/position guarantees differ — X11 clients can be positioned by
  scripts in ways Wayland's security model restricts. Window mutation should
  go through KWin APIs (which apply policy), not raw protocol requests.
- **Managed set.** On X11, override-redirect windows (menus, some panels) are
  *not* managed and never emit `clientAdded`. On Wayland every surface is
  compositor-created; layer-shell surfaces show up as special windows.

## QuickShell / shell layers

QuickShell (Qt6) builds shell furniture — panels, launchers, desktop widgets —
as **layer-shell surfaces on Wayland**. Consequences for tracking:

- Layer surfaces are not normal XDG toplevels. Under KWin Wayland they appear
  in `windowList()` as special windows (`dock`, `onScreenDisplay`, etc.); the
  bridge tags them via `kind` rather than treating them as app windows.
- **QuickShell has no usable X11 mode** for layer behavior — a shell UI built
  on it is Wayland-only. For an X11 session the equivalent furniture must be
  ordinary windows with struts/dock type, which *are* tracked as regular
  clients.
- Layer surfaces bypass placement policy — do not attempt to tile/move
  `kind != "normal"` windows.

## Session D-Bus notes

- The registry binds `org.communitypoke.desktop.Registry` with
  `NAME_FLAG_DO_NOT_QUEUE` — exactly one owner; a second daemon exits fast.
- `workspace.callDBus` from a KWin script targets the *session* bus — the
  bridge cannot accidentally hit the system bus.
- All registry payloads are `s` (JSON). Variants/dicts would break the KWin
  script-engine marshalling; keep it that way.

## Security notes

- App scripts run in a `node:vm` context — convenience isolation only, not a
  sandbox. Do not run untrusted scripts.
- The D-Bus registry exposes all window titles on the session bus to any
  same-user process. That is the design (apps need it), but treat window
  metadata as sensitive.
